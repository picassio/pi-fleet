/**
 * bridge.ts — Programmatic bridge for sibling pi extensions (e.g. pi-squad).
 *
 * INDEPENDENCE CONTRACT (docs/squad-bridge.md):
 * - pi-fleet works fully without any bridge consumer. Publishing the bridge
 *   is additive: a global handle other extensions in the SAME pi process may
 *   feature-detect. No behavior changes when nobody consumes it.
 * - Consumers MUST feature-detect and version-check:
 *     const b = (globalThis as Record<string, unknown>).__piFleetBridge;
 *     if (b && (b as { version?: number }).version === 1) { ... }
 *   and MUST degrade gracefully when absent (pi-fleet not installed) or
 *   version-mismatched (treat as absent).
 * - pi-fleet removes the global on session_shutdown (only if it still owns it).
 */

export const BRIDGE_GLOBAL = "__piFleetBridge";

/** Worker lifecycle snapshot exposed to bridge consumers. */
export interface BridgeInstanceStatus {
	instanceId: string;
	host: string;
	bundle: string;
	state: string;
	settled: boolean;
}

/**
 * Version 1 of the cross-extension fleet bridge.
 * Everything delegates to the live FleetManager of this pi process.
 */
export interface PiFleetBridgeV1 {
	version: 1;
	/** Spawn a worker on a fleet machine. Supports warm-start from a baseline. */
	spawnWorker(options: {
		host: string;
		cwd: string;
		bundle?: string;
		fromBaseline?: string;
		maxCost?: number;
	}): Promise<{ instanceId: string; host: string; bundle: string; staleBaseline?: boolean }>;
	/** Send a prompt to a worker (fire-and-forget; observe progress via onEvent). */
	prompt(instanceId: string, message: string): Promise<void>;
	/** Raw pi RPC passthrough (steer, abort, set_model, get_state, ...). */
	rpc(instanceId: string, command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
	/** Subscribe to a worker's pi RPC event stream. Returns unsubscribe. */
	onEvent(instanceId: string, listener: (event: unknown) => void): () => void;
	/** Abort the worker's current run (keeps the worker alive). */
	abort(instanceId: string): Promise<void>;
	/** Gracefully stop the worker. */
	stop(instanceId: string): Promise<void>;
	/** Status of one instance, or undefined when unknown. */
	status(instanceId: string): BridgeInstanceStatus | undefined;
}

/** Minimal FleetManager surface the bridge needs (kept narrow for tests). */
export interface BridgeManagerLike {
	spawn(request: { host: string; cwd: string; bundle: string; maxCost?: number }): Promise<{
		instanceId: string;
		host: string;
		bundle: string;
	}>;
	prompt(instanceId: string, message: string, taskId?: string): Promise<void>;
	rpcRequest(instanceId: string, command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
	abort(instanceId: string): Promise<void>;
	stop(instanceId: string): Promise<{ forced: boolean }>;
	status(): Array<{ instanceId: string; host: string; bundle: string; state: string; settled: boolean }>;
	loadBaselines(): Promise<
		Map<string, { label: string; host: string; cwd: string; bundle: string; sessionPath: string; gitHead?: string }>
	>;
	fs(instanceId: string, request: Record<string, unknown>): Promise<{ text?: string }>;
}

export interface CreatedBridge {
	bridge: PiFleetBridgeV1;
	/** Fan an instance event out to bridge subscribers (wire into onInstanceEvent). */
	dispatchEvent(instanceId: string, event: unknown): void;
	/** Publish onto globalThis. Idempotent. */
	publish(): void;
	/** Remove from globalThis if this bridge still owns the slot. */
	unpublish(): void;
}

/**
 * Create the bridge around a (lazily obtained) FleetManager.
 * `getManager` mirrors index.ts's lazy `getFleet()` so the registry is only
 * started when a consumer actually spawns something.
 */
export function createBridge(getManager: () => BridgeManagerLike): CreatedBridge {
	const listeners = new Map<string, Set<(event: unknown) => void>>();

	const bridge: PiFleetBridgeV1 = {
		version: 1,

		async spawnWorker(options) {
			const manager = getManager();
			let baseline;
			if (options.fromBaseline) {
				baseline = (await manager.loadBaselines()).get(options.fromBaseline);
				if (!baseline) throw new Error(`unknown baseline: ${options.fromBaseline}`);
			}
			const tracked = await manager.spawn({
				host: baseline?.host ?? options.host,
				cwd: baseline?.cwd ?? options.cwd,
				bundle: options.bundle ?? baseline?.bundle ?? "default",
				...(options.maxCost !== undefined ? { maxCost: options.maxCost } : {}),
			});
			let staleBaseline: boolean | undefined;
			if (baseline) {
				// Clone-on-spawn: baseline session is pinned; work happens in a clone.
				await manager.rpcRequest(tracked.instanceId, { type: "switch_session", sessionPath: baseline.sessionPath });
				await manager.rpcRequest(tracked.instanceId, { type: "clone" });
				if (baseline.gitHead) {
					try {
						const head = await manager.fs(tracked.instanceId, { type: "fs_diff", revParse: true });
						const current = head.text?.trim();
						if (current && current !== baseline.gitHead) staleBaseline = true;
					} catch {
						// staleness check is best-effort
					}
				}
			}
			return {
				instanceId: tracked.instanceId,
				host: tracked.host,
				bundle: tracked.bundle,
				...(staleBaseline !== undefined ? { staleBaseline } : {}),
			};
		},

		async prompt(instanceId, message) {
			await getManager().prompt(instanceId, message);
		},

		async rpc(instanceId, command, timeoutMs) {
			return getManager().rpcRequest(instanceId, command, timeoutMs);
		},

		onEvent(instanceId, listener) {
			let set = listeners.get(instanceId);
			if (!set) {
				set = new Set();
				listeners.set(instanceId, set);
			}
			set.add(listener);
			return () => {
				set?.delete(listener);
				if (set && set.size === 0) listeners.delete(instanceId);
			};
		},

		async abort(instanceId) {
			await getManager().abort(instanceId);
		},

		async stop(instanceId) {
			await getManager().stop(instanceId);
			listeners.delete(instanceId);
		},

		status(instanceId) {
			return getManager()
				.status()
				.find((entry) => entry.instanceId === instanceId);
		},
	};

	return {
		bridge,
		dispatchEvent(instanceId, event) {
			const set = listeners.get(instanceId);
			if (!set) return;
			for (const listener of set) {
				try {
					listener(event);
				} catch {
					// consumer errors must never break fleet event handling
				}
			}
		},
		publish() {
			(globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] = bridge;
		},
		unpublish() {
			const slot = globalThis as Record<string, unknown>;
			if (slot[BRIDGE_GLOBAL] === bridge) delete slot[BRIDGE_GLOBAL];
		},
	};
}
