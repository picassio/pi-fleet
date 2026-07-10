/**
 * Fleet agent daemon: tailnet TCP listener that supervises pi workers.
 *
 * Trust model (docs/plan.md "Security model"): the agent is headless and
 * deny-by-default. The server identity is pinned at install; every inbound
 * connection is whois-verified against the pin and anything else is refused
 * without a dialog (AC-2.2a). Binds the tailscale IP only (AC-2.1).
 */
import { createServer, type Server, type Socket } from "node:net";
import { FrameConnection } from "../core/connection.ts";
import type { Frame, FrameOf } from "../core/frames.ts";
import type { TailscaleIdentity } from "../core/tailscale.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { InstanceSupervisor, type SupervisorOptions } from "./instances.ts";
import { fsDiff, fsGrep, fsList, fsRead } from "./fsservice.ts";
import { TaskOutbox } from "./outbox.ts";
import { listSessions, searchSessions } from "./sessions.ts";

export const AGENT_DEFAULT_PORT = 9788;
export const PACKAGE_VERSION = "0.0.1";

export interface AgentDaemonOptions {
	host: string;
	port: number;
	machine: string;
	/** Pinned server machine name; connections from anyone else are refused. */
	pinnedServer: string;
	whois: (ip: string) => Promise<TailscaleIdentity>;
	supervisor?: SupervisorOptions;
	/** Outbox directory (default ~/.pi/agent/fleet-agent/outbox). */
	outboxDir?: string;
	/** Refuse spawns beyond this many running instances (AC-3.14). */
	maxWorkers?: number;
	/** pi session storage root to search (default ~/.pi/agent/sessions). */
	sessionsDir?: string;
	/** Internal: wired by startAgentDaemon to register per-instance budgets. */
	registerBudget?: (instanceId: string, maxCost: number) => void;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	log?: (line: string) => void;
}

export interface RunningAgent {
	server: Server;
	host: string;
	port: number;
	supervisor: InstanceSupervisor;
	close(): Promise<void>;
}

export async function startAgentDaemon(options: AgentDaemonOptions): Promise<RunningAgent> {
	const log = options.log ?? (() => {});
	const connections = new Set<FrameConnection>();
	const outbox = new TaskOutbox(
		options.outboxDir ?? join(homedir(), ".pi", "agent", "fleet-agent", "outbox"),
	);
	/** instanceId → pending taskId (set by rpc prompt frames carrying taskId). */
	const pendingTasks = new Map<string, string>();
	const lastAssistant = new Map<string, string>();
	const budgets = new Map<string, number>(); // instanceId -> maxCost
	const costs = new Map<string, number>(); // instanceId -> accumulated cost
	const budgetExceeded = new Set<string>();

	const supervisor = new InstanceSupervisor({
		...options.supervisor,
		onEvent: (instanceId, event) => {
			options.supervisor?.onEvent?.(instanceId, event);
			for (const connection of connections) {
				connection.trySend({ v: 1, type: "event", instanceId, event });
			}
			const typed = event as {
				type?: string;
				message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
			};
			const usage = (event as { message?: { usage?: { cost?: { total?: number } } } }).message?.usage;
			if (typeof usage?.cost?.total === "number") {
				const total = (costs.get(instanceId) ?? 0) + usage.cost.total;
				costs.set(instanceId, total);
				const maxCost = budgets.get(instanceId);
				if (maxCost !== undefined && total > maxCost && !budgetExceeded.has(instanceId)) {
					budgetExceeded.add(instanceId);
					log(`instance ${instanceId} exceeded budget ($${total.toFixed(4)} > $${maxCost}); aborting`);
					supervisor.writeRpc(instanceId, { type: "abort" });
				}
			}
			if (typed.type === "message_end" && typed.message?.role === "assistant") {
				const textParts = (typed.message.content ?? [])
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n");
				if (textParts) lastAssistant.set(instanceId, textParts);
			}
			if (typed.type === "agent_settled") {
				const taskId = pendingTasks.get(instanceId);
				if (taskId !== undefined) {
					pendingTasks.delete(instanceId);
					const frame = {
						v: 1 as const,
						type: "task_done" as const,
						taskId,
						instanceId,
						seq: Date.now(),
						status: budgetExceeded.has(instanceId) ? ("budget_exceeded" as const) : ("settled" as const),
						summary: (lastAssistant.get(instanceId) ?? "(no assistant output)").slice(0, 2_000),
						...(lastAssistant.get(instanceId)
							? { lastAssistantMessage: lastAssistant.get(instanceId) as string }
							: {}),
					};
					void outbox.put(frame).then(() => {
						for (const connection of connections) connection.trySend(frame);
						log(`task_done ${taskId} persisted + broadcast`);
					});
				}
			}
		},
		onExit: (instanceId, code) => {
			options.supervisor?.onExit?.(instanceId, code);
			log(`instance ${instanceId} exited (${code})`);
		},
	});

	options.registerBudget = (instanceId, maxCost) => budgets.set(instanceId, maxCost);

	const server = createServer((socket) => {
		void handleConnection(socket, options, supervisor, connections, log, outbox, pendingTasks).catch((error) => {
			log(`connection error: ${error instanceof Error ? error.message : String(error)}`);
			socket.destroy();
		});
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port, options.host, () => {
			server.removeListener("error", rejectPromise);
			resolvePromise();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	log(`agent listening on ${options.host}:${port}, pinned server: ${options.pinnedServer}`);

	return {
		server,
		host: options.host,
		port,
		supervisor,
		close: async () => {
			for (const connection of connections) connection.close();
			await supervisor.stopAll();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		},
	};
}

async function handleConnection(
	socket: Socket,
	options: AgentDaemonOptions,
	supervisor: InstanceSupervisor,
	connections: Set<FrameConnection>,
	log: (line: string) => void,
	outbox: TaskOutbox,
	pendingTasks: Map<string, string>,
): Promise<void> {
	const ip = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");

	// Deny-by-default whois gate against the pinned server (AC-2.2a).
	let identity: TailscaleIdentity;
	try {
		identity = await options.whois(ip);
	} catch (error) {
		log(`refused ${ip}: whois failed (${error instanceof Error ? error.message : String(error)})`);
		socket.destroy();
		return;
	}
	if (identity.machine !== options.pinnedServer) {
		log(`refused ${identity.machine}(${identity.user}) from ${ip}: not the pinned server`);
		socket.destroy();
		return;
	}
	log(`accepted ${identity.machine}(${identity.user}) from ${ip}`);

	const connection = new FrameConnection(socket, {
		...(options.heartbeatIntervalMs !== undefined
			? { heartbeatIntervalMs: options.heartbeatIntervalMs }
			: {}),
		...(options.heartbeatTimeoutMs !== undefined
			? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
			: {}),
	});
	connections.add(connection);
	connection.onClose(() => connections.delete(connection));

	connection.send({
		v: 1,
		type: "hello",
		machine: options.machine,
		role: "agent",
		packageVersion: PACKAGE_VERSION,
		platform: process.platform,
	});

	// Replay unacked task_done entries to the newly connected server (AC-3.5/3.6).
	for (const pending of await outbox.pending()) {
		connection.trySend(pending);
	}

	// Session registry push: agent disk is the source of truth (AC-3.5.4).
	// Async so a large session store never delays frame handling.
	void listSessions(options.sessionsDir).then((sessions) => {
		connection.trySend({ v: 1, type: "sessions_report", machine: options.machine, full: true, sessions });
	});

	connection.onFrame((frame) => {
		if (frame.type === "task_done_ack") {
			void outbox.ack(frame.taskId, frame.seq);
			return;
		}
		if (frame.type === "rpc" && frame.taskId) {
			pendingTasks.set(frame.instanceId, frame.taskId);
		}
		void dispatch(frame, connection, supervisor, options).catch((error) => {
			connection.trySend({
				v: 1,
				type: "error",
				code: "internal",
				message: error instanceof Error ? error.message : String(error),
			});
		});
	});
}

async function dispatch(
	frame: Frame,
	connection: FrameConnection,
	supervisor: InstanceSupervisor,
	agentOptions: AgentDaemonOptions,
): Promise<void> {
	switch (frame.type) {
		case "hello":
			return; // informational
		case "list": {
			const instances = supervisor.list().map((record) => ({
				instanceId: record.instanceId,
				...(record.pid !== undefined ? { pid: record.pid } : {}),
				cwd: record.cwd,
				bundle: record.bundle,
				state: record.state,
			}));
			connection.send({ v: 1, type: "instances", instances, ...(frame.id ? { id: frame.id } : {}) });
			return;
		}
		case "spawn": {
			const request = frame as FrameOf<"spawn">;
			const limit = agentOptions.maxWorkers;
			if (limit !== undefined) {
				const runningCount = supervisor.list().filter((record) => record.state === "running").length;
				if (runningCount >= limit) {
					connection.send({
						v: 1,
						type: "spawn_error",
						code: "max_workers",
						message: `machine at capacity: ${runningCount}/${limit} workers running`,
						...(request.id ? { id: request.id } : {}),
					});
					return;
				}
			}
			try {
				const record = await supervisor.spawn({
					cwd: request.cwd,
					bundle: request.bundle,
					...(request.bundleHash ? { bundleHash: request.bundleHash } : {}),
					...(request.env ? { env: request.env } : {}),
					...(request.traceId ? { traceId: request.traceId } : {}),
				});
				if (request.budget?.maxCost !== undefined) {
					agentOptions.registerBudget?.(record.instanceId, request.budget.maxCost);
				}
				connection.send({
					v: 1,
					type: "spawned",
					instance: {
						instanceId: record.instanceId,
						...(record.pid !== undefined ? { pid: record.pid } : {}),
						cwd: record.cwd,
						bundle: record.bundle,
						state: record.state,
					},
					...(request.id ? { id: request.id } : {}),
					...(request.traceId ? { traceId: request.traceId } : {}),
				});
			} catch (error) {
				connection.send({
					v: 1,
					type: "spawn_error",
					code: "spawn_failed",
					message: error instanceof Error ? error.message : String(error),
					...(request.id ? { id: request.id } : {}),
				});
			}
			return;
		}
		case "stop": {
			const request = frame as FrameOf<"stop">;
			const result = await supervisor.stop(request.instanceId);
			if (result === null) {
				connection.send({
					v: 1,
					type: "error",
					code: "unknown_instance",
					message: `no instance ${request.instanceId}`,
					...(request.id ? { id: request.id } : {}),
				});
				return;
			}
			connection.send({
				v: 1,
				type: "stopped",
				instanceId: request.instanceId,
				forced: result.forced,
				...(request.id ? { id: request.id } : {}),
			});
			return;
		}
		case "rpc": {
			const request = frame as FrameOf<"rpc">;
			if (!supervisor.writeRpc(request.instanceId, request.command)) {
				connection.send({
					v: 1,
					type: "error",
					code: "unknown_instance",
					message: `no running instance ${request.instanceId}`,
					...(request.id ? { id: request.id } : {}),
				});
			}
			return;
		}
		case "session_search": {
			const hits = await searchSessions(
				agentOptions.sessionsDir,
				frame.query,
			);
			connection.send({ v: 1, type: "session_hits", hits, ...(frame.id ? { id: frame.id } : {}) });
			return;
		}
		case "fs_read":
		case "fs_list":
		case "fs_grep":
		case "fs_diff": {
			const instanceId = (frame as { instanceId: string }).instanceId;
			const record = supervisor.get(instanceId);
			if (!record) {
				connection.send({
					v: 1,
					type: "fs_result",
					done: true,
					error: { code: "unknown_instance", message: `no instance ${instanceId}` },
					...(frame.id ? { id: frame.id } : {}),
				});
				return;
			}
			const cwd = record.cwd;
			const payload =
				frame.type === "fs_read"
					? await fsRead(cwd, frame.path, {
							...(frame.offset !== undefined ? { offset: frame.offset } : {}),
							...(frame.limit !== undefined ? { limit: frame.limit } : {}),
						})
					: frame.type === "fs_list"
						? await fsList(cwd, frame.path)
						: frame.type === "fs_grep"
							? await fsGrep(cwd, frame.pattern, frame.glob)
							: await fsDiff(cwd, {
									...(frame.ref !== undefined ? { ref: frame.ref } : {}),
									...(frame.staged !== undefined ? { staged: frame.staged } : {}),
									...(frame.stat !== undefined ? { stat: frame.stat } : {}),
									...(frame.revParse !== undefined ? { revParse: frame.revParse } : {}),
								});
			connection.send({ v: 1, type: "fs_result", ...payload, ...(frame.id ? { id: frame.id } : {}) });
			return;
		}
		default:
			connection.trySend({
				v: 1,
				type: "error",
				code: "unexpected_frame",
				message: `agent does not handle ${frame.type}`,
			});
	}
}
