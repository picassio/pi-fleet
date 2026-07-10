/**
 * Server-side client for a fleet agent: dials the agent's tailnet listener,
 * exchanges hello, and provides promise-correlated spawn/list/stop plus RPC
 * passthrough with an event stream.
 */
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { FrameConnection, type FrameConnectionOptions } from "../core/connection.ts";
import type { Frame, FrameOf } from "../core/frames.ts";

export interface AgentClientOptions extends FrameConnectionOptions {
	connectTimeoutMs?: number;
}

export type AgentEventHandler = (instanceId: string, event: unknown) => void;
export type TaskDoneHandler = (frame: FrameOf<"task_done">) => void;

export class AgentClient {
	private connection: FrameConnection;
	private readonly pending = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
	private eventHandler: AgentEventHandler | undefined;
	private taskDoneHandler: TaskDoneHandler | undefined;
	private sessionsHandler: ((frame: FrameOf<"sessions_report">) => void) | undefined;
	lastSessionsReport: FrameOf<"sessions_report"> | undefined;
	private helloFrame: FrameOf<"hello"> | undefined;
	private helloWaiters: Array<(hello: FrameOf<"hello">) => void> = [];

	private constructor(connection: FrameConnection) {
		this.connection = connection;
		connection.onFrame((frame) => this.handleFrame(frame));
		connection.onClose(() => {
			for (const { reject } of this.pending.values()) {
				reject(new Error("agent connection closed"));
			}
			this.pending.clear();
		});
	}

	static async connect(host: string, port: number, options: AgentClientOptions = {}): Promise<AgentClient> {
		const socket = await new Promise<import("node:net").Socket>((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(
				() => {
					candidate.destroy();
					rejectPromise(new Error(`timed out connecting to agent ${host}:${port}`));
				},
				options.connectTimeoutMs ?? 10_000,
			);
			const candidate = connect(port, host, () => {
				clearTimeout(timeout);
				resolvePromise(candidate);
			});
			candidate.once("error", (error) => {
				clearTimeout(timeout);
				rejectPromise(error);
			});
		});
		return new AgentClient(new FrameConnection(socket, options));
	}

	/** Wait for the agent's hello (identity, version, platform). */
	async hello(timeoutMs = 10_000): Promise<FrameOf<"hello">> {
		if (this.helloFrame) return this.helloFrame;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for agent hello")), timeoutMs);
			this.helloWaiters.push((hello) => {
				clearTimeout(timer);
				resolvePromise(hello);
			});
		});
	}

	onEvent(handler: AgentEventHandler): void {
		this.eventHandler = handler;
	}

	onSessionsReport(handler: (frame: FrameOf<"sessions_report">) => void): void {
		this.sessionsHandler = handler;
		if (this.lastSessionsReport) handler(this.lastSessionsReport);
	}

	/** task_done frames are auto-acked after the handler runs (at-least-once + ack). */
	onTaskDone(handler: TaskDoneHandler): void {
		this.taskDoneHandler = handler;
	}

	async spawn(request: {
		cwd: string;
		bundle: string;
		bundleHash?: string;
		env?: Record<string, string>;
		traceId?: string;
		budget?: { maxCost?: number };
	}): Promise<FrameOf<"spawned">["instance"]> {
		const response = await this.request({
			v: 1,
			type: "spawn",
			cwd: request.cwd,
			bundle: request.bundle,
			...(request.bundleHash ? { bundleHash: request.bundleHash } : {}),
			...(request.env ? { env: request.env } : {}),
			...(request.traceId ? { traceId: request.traceId } : {}),
			...(request.budget ? { budget: request.budget } : {}),
		});
		if (response.type === "spawned") return response.instance;
		if (response.type === "spawn_error") {
			throw new Error(`spawn failed (${response.code}): ${response.message}`);
		}
		throw new Error(`unexpected response: ${response.type}`);
	}

	async list(): Promise<FrameOf<"instances">["instances"]> {
		const response = await this.request({ v: 1, type: "list" });
		if (response.type === "instances") return response.instances;
		throw new Error(`unexpected response: ${response.type}`);
	}

	async stop(instanceId: string): Promise<{ forced: boolean }> {
		const response = await this.request({ v: 1, type: "stop", instanceId });
		if (response.type === "stopped") return { forced: response.forced };
		if (response.type === "error") throw new Error(`${response.code}: ${response.message}`);
		throw new Error(`unexpected response: ${response.type}`);
	}

	/** Content search over the agent machine's pi sessions; only hits cross the wire. */
	async sessionSearch(query: string): Promise<FrameOf<"session_hits">["hits"]> {
		const response = await this.request({ v: 1, type: "session_search", query });
		if (response.type === "session_hits") return response.hits;
		throw new Error(`unexpected response: ${response.type}`);
	}

	/** Read-only file service (answered by the agent, not the worker). */
	async fs(
		request:
			| { type: "fs_read"; instanceId: string; path: string; offset?: number; limit?: number }
			| { type: "fs_list"; instanceId: string; path: string }
			| { type: "fs_grep"; instanceId: string; pattern: string; glob?: string }
			| { type: "fs_diff"; instanceId: string; ref?: string; staged?: boolean; stat?: boolean; revParse?: boolean },
	): Promise<FrameOf<"fs_result">> {
		const response = await this.request({ v: 1, ...request } as Frame);
		if (response.type === "fs_result") return response;
		throw new Error(`unexpected response: ${response.type}`);
	}

	/** Fire-and-forget pi RPC command to a worker; replies arrive as events. */
	rpc(instanceId: string, command: unknown, taskId?: string): void {
		this.connection.send({
			v: 1,
			type: "rpc",
			instanceId,
			command,
			...(taskId ? { taskId } : {}),
		});
	}

	close(): void {
		this.connection.close();
	}

	get isClosed(): boolean {
		return this.connection.isClosed;
	}

	private async request(frame: Frame & { id?: string }): Promise<Frame> {
		const id = `r-${randomBytes(6).toString("hex")}`;
		const withId = { ...frame, id } as Frame;
		return new Promise((resolvePromise, rejectPromise) => {
			this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
			try {
				this.connection.send(withId);
			} catch (error) {
				this.pending.delete(id);
				rejectPromise(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleFrame(frame: Frame): void {
		if (frame.type === "hello") {
			this.helloFrame = frame;
			for (const waiter of this.helloWaiters) waiter(frame);
			this.helloWaiters = [];
			return;
		}
		if (frame.type === "event") {
			this.eventHandler?.(frame.instanceId, frame.event);
			return;
		}
		if (frame.type === "sessions_report") {
			this.lastSessionsReport = frame;
			this.sessionsHandler?.(frame);
			return;
		}
		if (frame.type === "task_done") {
			this.taskDoneHandler?.(frame);
			this.connection.trySend({ v: 1, type: "task_done_ack", taskId: frame.taskId, seq: frame.seq });
			return;
		}
		if (frame.id && this.pending.has(frame.id)) {
			const pending = this.pending.get(frame.id);
			this.pending.delete(frame.id);
			pending?.resolve(frame);
			return;
		}
	}
}
