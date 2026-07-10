/**
 * pi-fleet extension entry.
 *
 * Role detection (docs/plan.md "Roles and activation"):
 * - PI_FLEET_BUNDLE / PI_FLEET_SERVER set → worker mode: the async factory
 *   provisions the bundle BEFORE pi continues startup, so resources_discover
 *   and session_start already see the synced bundle (AC-1.1).
 * - otherwise → server-mode commands register lazily (Phase 2+); the factory
 *   has no side effects (AC-X.1).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FleetManager } from "./server/fleet.ts";
import { loadBundleExtensions, type BundleExtensionLoadResult } from "./worker/host.ts";
import {
	parseWorkerEnv,
	provisionBundle,
	resolveResources,
	type ProvisionResult,
	type ResolvedResources,
} from "./worker/bootstrap.ts";

export default async function piFleet(pi: ExtensionAPI): Promise<void> {
	const workerEnv = parseWorkerEnv(process.env);
	if (workerEnv === null) {
		registerServerMode(pi);
		return;
	}

	// --- Worker mode -------------------------------------------------------
	// Provision inside the async factory: pi awaits this before session_start
	// and resources_discover, so the bundle is fully materialized first.
	const provision: ProvisionResult = await provisionBundle(workerEnv);
	const resources: ResolvedResources = resolveResources(provision.manifest, provision.dir);

	// Host bundle extensions against our own ExtensionAPI handle.
	const extensionResults: BundleExtensionLoadResult[] = await loadBundleExtensions(
		resources.extensionPaths,
		pi,
	);

	pi.on("resources_discover", () => ({
		skillPaths: resources.skillPaths,
		promptPaths: resources.promptPaths,
	}));

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;

		// Tool allowlist from the manifest (AC-1.3).
		const active = provision.manifest.tools?.active;
		if (active && active.length > 0) {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools(active.filter((name) => registered.has(name)));
		}

		// Model policy: walk primary then fallbacks; setModel returns false
		// when this machine has no usable key for the model.
		const policy = provision.manifest.model;
		let selectedModel: string | null = null;
		if (policy) {
			const candidates = [policy.primary, ...(policy.fallbacks ?? [])];
			for (const candidate of candidates) {
				const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
				if (model && (await pi.setModel(model))) {
					selectedModel = `${candidate.provider}/${candidate.id}`;
					const thinking = "thinking" in candidate ? candidate.thinking : undefined;
					if (thinking) {
						pi.setThinkingLevel(thinking as Parameters<typeof pi.setThinkingLevel>[0]);
					}
					break;
				}
			}
			if (selectedModel === null) {
				const tried = candidates.map((c) => `${c.provider}/${c.id}`).join(", ");
				throw new Error(`pi-fleet: no_usable_model — tried: ${tried}`);
			}
		}

		// Provisioning audit record (AC-1.5).
		pi.appendEntry("pi-fleet-provision", {
			bundle: provision.manifest.name,
			bundleHash: provision.manifest.bundleHash,
			status: provision.status,
			origin: provision.origin,
			fetched: provision.fetched.length,
			reused: provision.reused.length,
			selectedModel,
			extensions: extensionResults,
			instanceId: workerEnv.instanceId ?? null,
			taskId: workerEnv.taskId ?? null,
			traceId: workerEnv.traceId ?? null,
		});

		if (provision.status === "degraded" && ctx.hasUI) {
			ctx.ui.notify(
				`pi-fleet: registry unreachable — running from cached bundle ${provision.manifest.name}@${provision.manifest.bundleHash.slice(0, 12)}`,
				"warning",
			);
		}
		for (const result of extensionResults) {
			if (!result.ok && ctx.hasUI) {
				ctx.ui.notify(`pi-fleet: bundle extension failed: ${result.path}: ${result.error}`, "error");
			}
		}
	});
}

function registerServerMode(pi: ExtensionAPI): void {
	let fleet: FleetManager | undefined;
	const getFleet = (): FleetManager => {
		fleet ??= new FleetManager();
		return fleet;
	};
	const text = (value: string) => ({
		content: [{ type: "text" as const, text: value }],
		details: {} as Record<string, unknown>,
	});
	const updateStatus = (ctx: { hasUI: boolean; ui: { setStatus(k: string, v?: string): void } }) => {
		if (!ctx.hasUI || !fleet) return;
		const instances = fleet.status();
		const running = instances.filter((entry) => entry.state === "running").length;
		ctx.ui.setStatus("fleet", instances.length === 0 ? undefined : `fleet: ${running}/${instances.length} running`);
	};

	pi.on("session_shutdown", async () => {
		await fleet?.close();
		fleet = undefined;
	});

	pi.registerCommand("fleet", {
		description: "Show pi-fleet status",
		handler: async (_args, ctx) => {
			const instances = fleet?.status() ?? [];
			const summary =
				instances.length === 0
					? "no workers"
					: instances
							.map((entry) => `${entry.instanceId} ${entry.host} ${entry.bundle} ${entry.state}${entry.settled ? " settled" : ""}`)
							.join("\n");
			if (ctx.hasUI) ctx.ui.notify(`pi-fleet:\n${summary}`, "info");
		},
	});

	pi.registerTool({
		name: "remote_spawn",
		label: "Remote Spawn",
		description:
			"Spawn a pi worker on a fleet agent machine (tailnet). Returns the instanceId. " +
			"The worker provisions itself from this server's bundle registry.",
		promptSnippet: "Spawn a pi worker on a remote machine",
		promptGuidelines: [
			"Use remote_spawn to delegate work to another machine, then remote_prompt to task it.",
		],
		parameters: Type.Object({
			host: Type.String({ description: "Agent tailnet IP or hostname" }),
			cwd: Type.String({ description: "Working directory on the remote machine" }),
			bundle: Type.Optional(Type.String({ description: "Bundle name (default: default)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const tracked = await getFleet().spawn({
				host: params.host,
				cwd: params.cwd,
				bundle: params.bundle ?? "default",
			});
			updateStatus(ctx);
			return {
				...text(`spawned ${tracked.instanceId} on ${tracked.host} (bundle ${tracked.bundle})`),
				details: { instanceId: tracked.instanceId },
			};
		},
	});

	pi.registerTool({
		name: "remote_prompt",
		label: "Remote Prompt",
		description:
			"Send a prompt to a fleet worker. wait=true (default) blocks until the worker settles " +
			"and returns its final assistant message; wait=false returns immediately (poll with remote_output).",
		promptSnippet: "Task a remote pi worker and get its result",
		parameters: Type.Object({
			instanceId: Type.String(),
			message: Type.String(),
			wait: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Max wait (default 600)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const manager = getFleet();
			await manager.prompt(params.instanceId, params.message);
			if (params.wait === false) return text(`prompt sent to ${params.instanceId} (not waiting)`);
			onUpdate?.(text("worker running..."));
			await manager.waitSettled(params.instanceId, (params.timeoutSeconds ?? 600) * 1000, signal);
			const result = manager.get(params.instanceId)?.lastAssistant ?? "(no assistant output captured)";
			return text(result.length > 20_000 ? `${result.slice(0, 20_000)}\n[truncated]` : result);
		},
	});

	pi.registerTool({
		name: "remote_output",
		label: "Remote Output",
		description: "Inspect a fleet worker: state, settled flag, last assistant message, recent event types.",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params) {
			const { instance, recentEventTypes } = getFleet().output(params.instanceId);
			return text(
				[
					`instance ${instance.instanceId} on ${instance.host} (${instance.bundle})`,
					`state: ${instance.state}${instance.settled ? ", settled" : ", busy"}`,
					`recent events: ${recentEventTypes.join(", ") || "none"}`,
					`last assistant message:`,
					instance.lastAssistant ?? "(none)",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "remote_abort",
		label: "Remote Abort",
		description: "Abort a fleet worker's current run (keeps the worker alive).",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params) {
			await getFleet().abort(params.instanceId);
			return text(`abort sent to ${params.instanceId}`);
		},
	});

	pi.registerTool({
		name: "remote_stop",
		label: "Remote Stop",
		description: "Gracefully stop a fleet worker (abort, close stdin, kill after grace).",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await getFleet().stop(params.instanceId);
			updateStatus(ctx);
			return text(`stopped ${params.instanceId}${result.forced ? " (forced)" : ""}`);
		},
	});

	pi.registerTool({
		name: "fleet_status",
		label: "Fleet Status",
		description: "List all fleet workers: instanceId, host, bundle, state, settled.",
		parameters: Type.Object({}),
		async execute() {
			const instances = getFleet().status();
			if (instances.length === 0) return text("no workers");
			return text(
				instances
					.map(
						(entry) =>
							`${entry.instanceId} host=${entry.host} bundle=${entry.bundle} state=${entry.state} ${entry.settled ? "settled" : "busy"}`,
					)
					.join("\n"),
			);
		},
	});
}
