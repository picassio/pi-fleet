/**
 * Worker-mode provisioning: env contract, bundle sync with degraded-cache
 * fallback, and resource path resolution. Pure logic — no pi dependency —
 * so the whole flow is unit-testable. See docs/roadmap.md Phase 1 and
 * AC-1.1..AC-1.6.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncBundle, type BundleManifest } from "../core/bundle.ts";
import { toNativePath } from "../core/pathsafety.ts";
import { createRegistry, RegistryError, type RegistryClient } from "./registry.ts";

export interface WorkerEnv {
	server: string;
	bundle: string;
	cacheRoot: string;
	pinnedHash?: string;
	instanceId?: string;
	taskId?: string;
	traceId?: string;
}

/** Parse the worker env contract. Returns null when not in worker mode. */
export function parseWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv | null {
	const bundle = env.PI_FLEET_BUNDLE;
	const server = env.PI_FLEET_SERVER;
	if (!bundle && !server) return null;
	if (!bundle || !server) {
		throw new Error(
			"pi-fleet worker mode requires both PI_FLEET_SERVER and PI_FLEET_BUNDLE " +
				`(got server=${server ? "set" : "missing"}, bundle=${bundle ? "set" : "missing"})`,
		);
	}
	const result: WorkerEnv = {
		server,
		bundle,
		cacheRoot: env.PI_FLEET_CACHE ?? join(homedir(), ".pi", "agent", "fleet-cache"),
	};
	if (env.PI_FLEET_BUNDLE_HASH) result.pinnedHash = env.PI_FLEET_BUNDLE_HASH;
	if (env.PI_FLEET_INSTANCE_ID) result.instanceId = env.PI_FLEET_INSTANCE_ID;
	if (env.PI_FLEET_TASK_ID) result.taskId = env.PI_FLEET_TASK_ID;
	if (env.PI_FLEET_TRACE_ID) result.traceId = env.PI_FLEET_TRACE_ID;
	return result;
}

export interface ProvisionResult {
	manifest: BundleManifest;
	/** Active cache directory containing the bundle files. */
	dir: string;
	/** ready = synced from registry; degraded = registry unreachable, cache used. */
	status: "ready" | "degraded";
	fetched: string[];
	reused: string[];
	origin: string;
}

interface BundlePointer {
	bundleHash: string;
	manifest: BundleManifest;
}

function pointerPath(cacheRoot: string, bundle: string): string {
	return join(cacheRoot, "by-name", `${bundle}.json`);
}

async function readPointer(cacheRoot: string, bundle: string): Promise<BundlePointer | null> {
	try {
		const raw = await readFile(pointerPath(cacheRoot, bundle), "utf8");
		return JSON.parse(raw) as BundlePointer;
	} catch {
		return null;
	}
}

async function writePointer(cacheRoot: string, bundle: string, pointer: BundlePointer): Promise<void> {
	const path = pointerPath(cacheRoot, bundle);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(pointer), "utf8");
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Provision a bundle for a worker:
 * 1. Fetch the manifest from the registry.
 * 2. Sync into the content-addressed cache, reusing the previous version's
 *    files (per-bundle pointer) so unchanged respawns fetch nothing (AC-1.4).
 * 3. If the registry is unreachable: start degraded from the last cached
 *    version when one exists, otherwise fail fast (AC-1.6).
 */
export async function provisionBundle(
	env: WorkerEnv,
	options: { registry?: RegistryClient } = {},
): Promise<ProvisionResult> {
	const registry = options.registry ?? createRegistry(env.server);

	let manifest: BundleManifest;
	try {
		manifest = await registry.fetchManifest(env.bundle);
	} catch (error) {
		if (error instanceof RegistryError && error.code !== "invalid_manifest") {
			const pointer = await readPointer(env.cacheRoot, env.bundle);
			const cachedDir = pointer ? join(env.cacheRoot, pointer.bundleHash) : null;
			if (pointer && cachedDir && (await exists(cachedDir))) {
				return {
					manifest: pointer.manifest,
					dir: cachedDir,
					status: "degraded",
					fetched: [],
					reused: [],
					origin: registry.origin,
				};
			}
			throw new Error(
				`pi-fleet: registry unreachable and no cached copy of bundle "${env.bundle}" exists. ` +
					`Registry: ${registry.origin}. Underlying error: ${error.message}`,
			);
		}
		throw error;
	}

	if (env.pinnedHash && manifest.bundleHash !== env.pinnedHash) {
		throw new Error(
			`pi-fleet: bundle "${env.bundle}" hash mismatch: pinned ${env.pinnedHash}, ` +
				`registry serves ${manifest.bundleHash} (AC-4.4)`,
		);
	}

	const pointer = await readPointer(env.cacheRoot, env.bundle);
	const baseDir = pointer ? join(env.cacheRoot, pointer.bundleHash) : null;
	const base =
		pointer && baseDir && (await exists(baseDir))
			? { dir: baseDir, manifest: pointer.manifest }
			: undefined;

	const result = await syncBundle({
		manifest,
		fetchFile: registry.fileFetcher(env.bundle),
		cacheRoot: env.cacheRoot,
		...(base ? { base } : {}),
	});

	await writePointer(env.cacheRoot, env.bundle, { bundleHash: manifest.bundleHash, manifest });

	return {
		manifest,
		dir: result.dir,
		status: "ready",
		fetched: result.fetched,
		reused: result.reused,
		origin: registry.origin,
	};
}

export interface ResolvedResources {
	skillPaths: string[];
	promptPaths: string[];
	/** Absolute paths to bundle extension entry modules. */
	extensionPaths: string[];
}

/** Map manifest resource declarations to absolute paths in the cache dir. */
export function resolveResources(manifest: BundleManifest, dir: string): ResolvedResources {
	return {
		skillPaths: (manifest.skills ?? []).map((p) => toNativePath(dir, p)),
		promptPaths: (manifest.prompts ?? []).map((p) => toNativePath(dir, p)),
		extensionPaths: (manifest.extensions ?? []).map((p) => toNativePath(dir, p)),
	};
}
