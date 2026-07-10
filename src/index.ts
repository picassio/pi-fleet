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
	pi.registerCommand("fleet", {
		description: "pi-fleet status (server mode arrives in Phase 2)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify("pi-fleet: worker mode inactive (no PI_FLEET_* env); server mode lands in Phase 2", "info");
			}
		},
	});
}
