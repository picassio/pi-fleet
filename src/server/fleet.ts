/**
 * FleetManager: server-side orchestration state.
 *
 * Owns agent connections (one per host), tracks instances and their event
 * streams, detects settle points (`agent_settled`), and captures the last
 * assistant message so blocking prompts can return the worker's result.
 */
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
}

export class FleetManager {
	private readonly agents = new Map<string, AgentClient>();
	private readonly instances = new Map<string, TrackedInstance>();
	private readonly settleWaiters = new Map<string, Array<() => void>>();
	private registry: RunningRegistryServer | undefined;
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
		this.agents.set(host, client);
		return client;
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
	}): Promise<TrackedInstance> {
		const client = await this.agent(request.host);
		const registryUrl = await this.registryUrlFor();
		const instance = await client.spawn({
			cwd: request.cwd,
			bundle: request.bundle,
			...(request.bundleHash ? { bundleHash: request.bundleHash } : {}),
			env: { PI_FLEET_SERVER: registryUrl },
		});
		const tracked: TrackedInstance = {
			instanceId: instance.instanceId,
			host: request.host,
			cwd: request.cwd,
			bundle: request.bundle,
			state: "running",
			settled: false,
			lastAssistant: undefined,
			events: [],
		};
		this.instances.set(instance.instanceId, tracked);
		return tracked;
	}

	/** Send a prompt; resets the settle latch. */
	async prompt(instanceId: string, message: string): Promise<void> {
		const tracked = this.mustGet(instanceId);
		const client = await this.agent(tracked.host);
		tracked.settled = false;
		client.rpc(instanceId, { type: "prompt", message });
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
			| { type: "fs_diff"; ref?: string; staged?: boolean; stat?: boolean },
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

	async close(): Promise<void> {
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
		const tracked = this.instances.get(instanceId);
		if (!tracked) return;
		tracked.events.push(event);
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
			tracked.settled = true;
			const waiters = this.settleWaiters.get(instanceId) ?? [];
			this.settleWaiters.delete(instanceId);
			for (const waiter of waiters) waiter();
			if (waiters.length === 0) this.options.onSettled?.(tracked);
		}
	}
}
