/**
 * FleetManager: server-side orchestration state.
 *
 * Owns agent connections (one per host), tracks instances and their event
 * streams, detects settle points (`agent_settled`), and captures the last
 * assistant message so blocking prompts can return the worker's result.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "./agent-client.ts";
import { startRegistryServer, type RunningRegistryServer } from "./registry-server.ts";
import { Tailscale } from "../core/tailscale.ts";
import { AGENT_DEFAULT_PORT } from "../agent/daemon.ts";

const EVENT_BUFFER_LIMIT = 300;

interface PiEvent {
	type?: string;
	message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
	[key: string]: unknown;
}

export interface TrackedInstance {
	instanceId: string;
	host: string;
	cwd: string;
	bundle: string;
	state: "running" | "stopped" | "exited";
	review: "none" | "awaiting";
	settled: boolean;
	lastAssistant: string | undefined;
	events: PiEvent[];
}

export interface FleetManagerOptions {
	registryRoot?: string;
	registryPort?: number;
	agentPort?: number;
	connectAgent?: (host: string, port: number) => Promise<AgentClient>;
	registryUrl?: string;
	/** Fired whenever a tracked instance reaches agent_settled. */
	onSettled?: (instance: TrackedInstance) => void;
	/** Fired once per unique durable task_done (deduped by instanceId+taskId+seq). */
	onTaskDone?: (frame: { taskId: string; instanceId: string; seq: number; summary: string }) => void;
	/** Fired on any fleet change worth re-rendering (spawn/stop/settle/task_done/reconnect). */
	onChange?: () => void;
	/** Fired for every worker event (follow view). */
	onInstanceEvent?: (instanceId: string, event: unknown) => void;
	/** Disable auto-reconnect (tests). */
	autoReconnect?: boolean;
}

export class FleetManager {
	private readonly agents = new Map<string, AgentClient>();
	private readonly instances = new Map<string, TrackedInstance>();
	private readonly settleWaiters = new Map<string, Array<() => void>>();
	private registry: RunningRegistryServer | undefined;
	private readonly seenTaskDone = new Set<string>();
	private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
	private readonly rpcWaiters = new Map<string, (event: PiEvent) => void>();
	private baselines = new Map<string, BaselineRecord>();
	private baselinesLoaded = false;
	private closed = false;
	private readonly options: FleetManagerOptions;
	readonly registryRoot: string;

	constructor(options: FleetManagerOptions = {}) {
		this.options = options;
		this.registryRoot =
			options.registryRoot ?? join(homedir(), ".pi", "agent", "fleet", "bundles");
	}

	async agent(host: string): Promise<AgentClient> {
		const existing = this.agents.get(host);
		if (existing && !existing.isClosed) return existing;

		const port = this.options.agentPort ?? AGENT_DEFAULT_PORT;
		const client = this.options.connectAgent
			? await this.options.connectAgent(host, port)
			: await AgentClient.connect(host, port);
		await client.hello();
		client.onEvent((instanceId, event) => this.handleEvent(instanceId, event as PiEvent));
		client.onTaskDone((frame) => {
			const key = `${frame.instanceId}:${frame.taskId}:${frame.seq}`;
			if (this.seenTaskDone.has(key)) return;
			this.seenTaskDone.add(key);
			const tracked = this.instances.get(frame.instanceId);
			if (tracked) tracked.review = "awaiting";
			this.options.onTaskDone?.(frame);
		});
		this.agents.set(host, client);
		// Auto-reconnect with backoff: durable task_done replay only arrives
		// while a connection exists, so do not wait for the next tool call.
		if (this.options.autoReconnect !== false) this.watchConnection(host, client, 1_000);
		this.options.onChange?.();
		return client;
	}

	private watchConnection(host: string, client: AgentClient, backoffMs: number): void {
		const poll = setInterval(() => {
			if (!client.isClosed) return;
			clearInterval(poll);
			if (this.closed) return;
			this.options.onChange?.();
			const timer = setTimeout(() => {
				this.reconnectTimers.delete(host);
				void this.agent(host)
					.then(() => this.options.onChange?.())
					.catch(() => {
						if (!this.closed) this.watchClosed(host, Math.min(backoffMs * 2, 30_000));
					});
			}, backoffMs);
			timer.unref?.();
			this.reconnectTimers.set(host, timer);
		}, 500);
		poll.unref?.();
	}

	private watchClosed(host: string, backoffMs: number): void {
		const timer = setTimeout(() => {
			this.reconnectTimers.delete(host);
			void this.agent(host)
				.then(() => this.options.onChange?.())
				.catch(() => {
					if (!this.closed) this.watchClosed(host, Math.min(backoffMs * 2, 30_000));
				});
		}, backoffMs);
		timer.unref?.();
		this.reconnectTimers.set(host, timer);
	}

	/** Registry URL workers should sync from; starts the HTTP registry lazily. */
	async registryUrlFor(): Promise<string> {
		if (this.options.registryUrl) return this.options.registryUrl;
		if (!this.registry) {
			const tailscale = new Tailscale();
			const host = await tailscale.ip4();
			this.registry = await startRegistryServer({
				root: this.registryRoot,
				host,
				port: this.options.registryPort ?? 9787,
			});
		}
		return this.registry.url;
	}

	async spawn(request: {
		host: string;
		cwd: string;
		bundle: string;
		bundleHash?: string;
		maxCost?: number;
	}): Promise<TrackedInstance> {
		const client = await this.agent(request.host);

		// Platform enforcement (AC-4.3): refuse before any process starts.
		try {
			const manifestRaw = await readFile(
				join(this.registryRoot, request.bundle, "manifest.json"),
				"utf8",
			);
			const platforms = (JSON.parse(manifestRaw) as { platforms?: string[] }).platforms;
			if (platforms && platforms.length > 0) {
				const agentPlatform = (await client.hello()).platform;
				if (!platforms.includes(agentPlatform)) {
					throw new Error(
						`bundle "${request.bundle}" targets [${platforms.join(", ")}] but ${request.host} runs ${agentPlatform}`,
					);
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("targets [")) throw error;
			// Manifest unreadable locally (remote registryUrl case): the worker's
			// own sync validates the manifest; platform check is best-effort here.
		}

		const registryUrl = await this.registryUrlFor();
		const instance = await client.spawn({
			cwd: request.cwd,
			bundle: request.bundle,
			...(request.bundleHash ? { bundleHash: request.bundleHash } : {}),
			...(request.maxCost !== undefined ? { budget: { maxCost: request.maxCost } } : {}),
			env: { PI_FLEET_SERVER: registryUrl },
		});
		const tracked: TrackedInstance = {
			instanceId: instance.instanceId,
			host: request.host,
			cwd: request.cwd,
			bundle: request.bundle,
			state: "running",
			review: "none",
			settled: false,
			lastAssistant: undefined,
			events: [],
		};
		this.instances.set(instance.instanceId, tracked);
		return tracked;
	}

	/** Send a pi RPC command and await its correlated response event. */
	async rpcRequest(
		instanceId: string,
		command: Record<string, unknown>,
		timeoutMs = 60_000,
	): Promise<PiEvent> {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		const id = `rpc-${randomBytes(5).toString("hex")}`;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.rpcWaiters.delete(id);
				rejectPromise(new Error(`rpc ${String(command.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.rpcWaiters.set(id, (event) => {
				clearTimeout(timer);
				this.rpcWaiters.delete(id);
				resolvePromise(event);
			});
			client.rpc(instanceId, { ...command, id });
		});
	}

	// --- Baselines (Phase 3.5) ---------------------------------------------

	private get baselinesPath(): string {
		return join(this.registryRoot, "..", "baselines.json");
	}

	async loadBaselines(): Promise<Map<string, BaselineRecord>> {
		if (!this.baselinesLoaded) {
			try {
				const raw = JSON.parse(await readFile(this.baselinesPath, "utf8")) as BaselineRecord[];
				this.baselines = new Map(raw.map((entry) => [entry.label, entry]));
			} catch {
				this.baselines = new Map();
			}
			this.baselinesLoaded = true;
		}
		return this.baselines;
	}

	async saveBaseline(record: BaselineRecord): Promise<void> {
		await this.loadBaselines();
		this.baselines.set(record.label, record);
		await mkdir(join(this.baselinesPath, ".."), { recursive: true });
		await writeFile(this.baselinesPath, JSON.stringify([...this.baselines.values()], null, "\t"), "utf8");
	}

	/** Send a prompt; resets the settle latch. taskId makes it a durable tracked task. */
	async prompt(instanceId: string, message: string, taskId?: string): Promise<void> {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		tracked.settled = false;
		tracked.review = "none";
		client.rpc(instanceId, { type: "prompt", message }, taskId);
	}

	/** Resolve when the worker settles (agent_settled) or reject on timeout/abort. */
	async waitSettled(instanceId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const tracked = this.mustGet(instanceId);
		if (tracked.settled) return;
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const waiters = this.settleWaiters.get(instanceId) ?? [];
			const timer = setTimeout(() => {
				remove();
				rejectPromise(new Error(`worker ${instanceId} did not settle within ${timeoutMs}ms`));
			}, timeoutMs);
			const onAbort = () => {
				remove();
				clearTimeout(timer);
				rejectPromise(new Error("aborted"));
			};
			const waiter = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolvePromise();
			};
			const remove = () => {
				const list = this.settleWaiters.get(instanceId) ?? [];
				this.settleWaiters.set(instanceId, list.filter((entry) => entry !== waiter));
			};
			waiters.push(waiter);
			this.settleWaiters.set(instanceId, waiters);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	output(instanceId: string, recentCount = 20): {
		instance: TrackedInstance;
		recentEventTypes: string[];
	} {
		const tracked = this.mustGet(instanceId);
		return {
			instance: tracked,
			recentEventTypes: tracked.events.slice(-recentCount).map((event) => event.type ?? "?"),
		};
	}

	async fs(
		instanceId: string,
		request:
			| { type: "fs_read"; path: string; offset?: number; limit?: number }
			| { type: "fs_list"; path: string }
			| { type: "fs_grep"; pattern: string; glob?: string }
			| { type: "fs_diff"; ref?: string; staged?: boolean; stat?: boolean; revParse?: boolean },
	) {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		return client.fs({ ...request, instanceId } as Parameters<AgentClient["fs"]>[0]);
	}

	async abort(instanceId: string): Promise<void> {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		client.rpc(instanceId, { type: "abort" });
	}

	async stop(instanceId: string): Promise<{ forced: boolean }> {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		const result = await client.stop(instanceId);
		tracked.state = "stopped";
		return result;
	}

	status(): TrackedInstance[] {
		return [...this.instances.values()];
	}

	get(instanceId: string): TrackedInstance | undefined {
		return this.instances.get(instanceId);
	}

	/** Self-diagnosis lines for /fleet-doctor (Phase 5). */
	async doctor(): Promise<string[]> {
		const lines: string[] = [];
		try {
			const tailscale = new Tailscale();
			const binary = await tailscale.findBinary();
			lines.push(binary ? `tailscale: ok (${binary}, ip ${await tailscale.ip4()})` : "tailscale: NOT FOUND");
		} catch (error) {
			lines.push(`tailscale: ERROR ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const bundles = (await readdir(this.registryRoot, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
			lines.push(`registry: ${this.registryRoot} (${bundles.length} bundle(s): ${bundles.join(", ") || "none"})`);
		} catch {
			lines.push(`registry: MISSING ${this.registryRoot}`);
		}
		const baselines = await this.loadBaselines();
		lines.push(`baselines: ${baselines.size}`);
		const hosts = [...this.agents.entries()];
		lines.push(
			hosts.length === 0
				? "agents: none connected"
				: hosts.map(([host, client]) => `agent ${host}: ${client.isClosed ? "DISCONNECTED" : "connected"}`).join("\n"),
		);
		const instances = this.status();
		lines.push(`workers: ${instances.filter((entry) => entry.state === "running").length} running / ${instances.length} tracked`);
		return lines;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
		this.reconnectTimers.clear();
		for (const client of this.agents.values()) client.close();
		this.agents.clear();
		await this.registry?.close();
		this.registry = undefined;
	}

	private mustGet(instanceId: string): TrackedInstance {
		const tracked = this.instances.get(instanceId);
		if (!tracked) throw new Error(`unknown instance: ${instanceId}`);
		return tracked;
	}

	private handleEvent(instanceId: string, event: PiEvent): void {
		const eventId = (event as { id?: unknown }).id;
		if (typeof eventId === "string") this.rpcWaiters.get(eventId)?.(event);
		const tracked = this.instances.get(instanceId);
		if (!tracked) return;
		tracked.events.push(event);
		this.options.onInstanceEvent?.(instanceId, event);
		if (tracked.events.length > EVENT_BUFFER_LIMIT) {
			tracked.events.splice(0, tracked.events.length - EVENT_BUFFER_LIMIT);
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content ?? [])
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
			if (text.length > 0) tracked.lastAssistant = text;
		}
		if (event.type === "agent_settled") {
			this.options.onChange?.();
			tracked.settled = true;
			const waiters = this.settleWaiters.get(instanceId) ?? [];
			this.settleWaiters.delete(instanceId);
			for (const waiter of waiters) waiter();
			if (waiters.length === 0) this.options.onSettled?.(tracked);
		}
	}
}

export interface BaselineRecord {
	label: string;
	host: string;
	cwd: string;
	sessionPath: string;
	bundle: string;
	createdAt: number;
	gitHead?: string;
}
