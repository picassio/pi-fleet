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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
	/** Instance registry file (default ~/.pi/agent/fleet-agent/instances.json). */
	instancesFile?: string;
	/** When set, poll for the tailnet IP and rebind the listener on change (gap fix #3). */
	ipProvider?: { current: () => Promise<string>; intervalMs?: number };
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
	/** taskId -> connection that submitted it (gap fix #2: review ownership). */
	const taskOwners = new Map<string, FrameConnection>();
	const instancesFile =
		options.instancesFile ?? join(homedir(), ".pi", "agent", "fleet-agent", "instances.json");
	interface PersistedInstance {
		instanceId: string;
		pid?: number;
		cwd: string;
		bundle: string;
		taskId?: string;
		sessionPath?: string;
	}
	const persisted = new Map<string, PersistedInstance>();
	const lostInstances: PersistedInstance[] = [];
	const persist = () => {
		void mkdir(join(instancesFile, ".."), { recursive: true })
			.then(() => writeFile(instancesFile, JSON.stringify([...persisted.values()]), "utf8"))
			.catch(() => {});
	};
	const emitTaskDone = (instanceId: string, taskId: string, status: "settled" | "budget_exceeded" | "aborted") => {
		const frame = {
			v: 1 as const,
			type: "task_done" as const,
			taskId,
			instanceId,
			seq: Date.now(),
			status,
			summary: (lastAssistant.get(instanceId) ?? "(no assistant output)").slice(0, 2_000),
			...(lastAssistant.get(instanceId) ? { lastAssistantMessage: lastAssistant.get(instanceId) as string } : {}),
		};
		void outbox.put(frame).then(() => {
			// Ownership-preferred delivery: only the submitting connection reviews;
			// broadcast is the durability fallback when the owner is gone.
			const owner = taskOwners.get(taskId);
			taskOwners.delete(taskId);
			if (owner && !owner.isClosed && owner.trySend(frame)) {
				log(`task_done ${taskId} (${status}) delivered to owner`);
				return;
			}
			for (const connection of connections) connection.trySend(frame);
			log(`task_done ${taskId} (${status}) persisted + broadcast`);
		});
	};
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
			const probeId = (event as { id?: unknown }).id;
			if (typeof probeId === "string" && probeId === `probe-${instanceId}`) {
				const data = (event as { data?: Record<string, unknown> }).data ?? {};
				const sessionPath = [data.sessionFile, data.sessionPath, data.file].find(
					(value) => typeof value === "string",
				) as string | undefined;
				const record = persisted.get(instanceId);
				if (record && sessionPath) {
					record.sessionPath = sessionPath;
					persist();
				}
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
					emitTaskDone(instanceId, taskId, budgetExceeded.has(instanceId) ? "budget_exceeded" : "settled");
				}
			}
		},
		onExit: (instanceId, code) => {
			options.supervisor?.onExit?.(instanceId, code);
			log(`instance ${instanceId} exited (${code})`);
			persisted.delete(instanceId);
			persist();
			// Crash mid-task: never leave the orchestrator waiting (gap fix).
			const taskId = pendingTasks.get(instanceId);
			if (taskId !== undefined) {
				pendingTasks.delete(instanceId);
				emitTaskDone(instanceId, taskId, "aborted");
			}
		},
	});

	options.registerBudget = (instanceId, maxCost) => budgets.set(instanceId, maxCost);

	// Gap fix #1: previous-life instances are lost (stdio cannot be re-attached).
	// Kill live orphans, surface them as `lost` with session paths, and emit
	// durable aborted task_done for anything that was mid-task.
	try {
		const raw = JSON.parse(await readFile(instancesFile, "utf8")) as PersistedInstance[];
		for (const record of raw) {
			if (record.pid !== undefined) {
				try {
					process.kill(record.pid, "SIGTERM");
					log(`killed orphaned worker ${record.instanceId} (pid ${record.pid})`);
				} catch {
					// already dead
				}
			}
			lostInstances.push(record);
			if (record.taskId) {
				lastAssistant.set(record.instanceId, "(agent restarted; worker lost mid-task)");
				emitTaskDone(record.instanceId, record.taskId, "aborted");
			}
		}
	} catch {
		// no previous registry
	}
	persisted.clear();
	persist();

	const agentState: AgentSharedState = { taskOwners, persisted, persist, lostInstances, probe: (id) => {
		supervisor.writeRpc(id, { type: "get_state", id: `probe-${id}` });
	} };
	const server = createServer((socket) => {
		void handleConnection(socket, options, supervisor, connections, log, outbox, pendingTasks, agentState).catch((error) => {
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

	let activeServer = server;
	let currentHost = options.host;
	let rebindTimer: NodeJS.Timeout | undefined;
	if (options.ipProvider) {
		const provider = options.ipProvider;
		rebindTimer = setInterval(() => {
			void provider
				.current()
				.then(async (nextHost) => {
					if (nextHost === currentHost) return;
					log(`tailnet IP changed ${currentHost} -> ${nextHost}; rebinding (workers unaffected)`);
					await new Promise<void>((resolvePromise) => activeServer.close(() => resolvePromise()));
					const next = createServer((socket) => {
						void handleConnection(socket, options, supervisor, connections, log, outbox, pendingTasks, agentState).catch(() => socket.destroy());
					});
					await new Promise<void>((resolvePromise, rejectPromise) => {
						next.once("error", rejectPromise);
						next.listen(port, nextHost, () => resolvePromise());
					});
					activeServer = next;
					currentHost = nextHost;
				})
				.catch((error) => log(`ip poll failed: ${error instanceof Error ? error.message : String(error)}`));
		}, options.ipProvider.intervalMs ?? 60_000);
		rebindTimer.unref?.();
	}

	return {
		get server() {
			return activeServer;
		},
		host: options.host,
		port,
		supervisor,
		close: async () => {
			if (rebindTimer) clearInterval(rebindTimer);
			for (const connection of connections) connection.close();
			await supervisor.stopAll();
			await new Promise<void>((resolvePromise) => activeServer.close(() => resolvePromise()));
		},
	};
}

interface AgentSharedState {
	taskOwners: Map<string, FrameConnection>;
	persisted: Map<string, { instanceId: string; pid?: number; cwd: string; bundle: string; taskId?: string; sessionPath?: string }>;
	persist: () => void;
	lostInstances: Array<{ instanceId: string; cwd: string; bundle: string; sessionPath?: string }>;
	probe: (instanceId: string) => void;
}

async function handleConnection(
	socket: Socket,
	options: AgentDaemonOptions,
	supervisor: InstanceSupervisor,
	connections: Set<FrameConnection>,
	log: (line: string) => void,
	outbox: TaskOutbox,
	pendingTasks: Map<string, string>,
	state: AgentSharedState,
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
			state.taskOwners.set(frame.taskId, connection);
			const record = state.persisted.get(frame.instanceId);
			if (record) {
				record.taskId = frame.taskId;
				state.persist();
			}
		}
		void dispatch(frame, connection, supervisor, options, state).catch((error) => {
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
	state: AgentSharedState,
): Promise<void> {
	switch (frame.type) {
		case "hello":
			return; // informational
		case "list": {
			const instances = [
				...supervisor.list().map((record) => ({
					instanceId: record.instanceId,
					...(record.pid !== undefined ? { pid: record.pid } : {}),
					cwd: record.cwd,
					bundle: record.bundle,
					state: record.state,
				})),
				...state.lostInstances.map((record) => ({
					instanceId: record.instanceId,
					cwd: record.cwd,
					bundle: record.bundle,
					state: "lost",
					...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
				})),
			];
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
				state.persisted.set(record.instanceId, {
					instanceId: record.instanceId,
					...(record.pid !== undefined ? { pid: record.pid } : {}),
					cwd: record.cwd,
					bundle: record.bundle,
				});
				state.persist();
				state.probe(record.instanceId);
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
