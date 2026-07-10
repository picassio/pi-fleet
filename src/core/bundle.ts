/**
 * Bundle manifest v1: build, validate, and sync.
 *
 * Manifest paths are POSIX; the sync engine validates every path (AC-0.3),
 * fetches only missing/changed files (AC-0.2), verifies hashes, and swaps
 * the cache directory atomically. See docs/plan.md (Bundle manifest).
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { toNativePath, validateManifestPaths, type PathSafetyError } from "./pathsafety.ts";

// ---------------------------------------------------------------------------
// Manifest schema (typebox = types + validation)
// ---------------------------------------------------------------------------

const BundleFileSchema = Type.Object({
	path: Type.String(),
	sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	bytes: Type.Number(),
});

export const BundleManifestSchema = Type.Object({
	v: Type.Literal(1),
	name: Type.String({ minLength: 1 }),
	bundleHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	platforms: Type.Optional(Type.Array(Type.String())),
	files: Type.Array(BundleFileSchema),
	extensions: Type.Optional(Type.Array(Type.String())),
	skills: Type.Optional(Type.Array(Type.String())),
	prompts: Type.Optional(Type.Array(Type.String())),
	tools: Type.Optional(Type.Object({ active: Type.Optional(Type.Array(Type.String())) })),
	model: Type.Optional(
		Type.Object({
			primary: Type.Object({
				provider: Type.String(),
				id: Type.String(),
				thinking: Type.Optional(Type.String()),
			}),
			fallbacks: Type.Optional(
				Type.Array(Type.Object({ provider: Type.String(), id: Type.String() })),
			),
			pin: Type.Optional(Type.Boolean()),
		}),
	),
	review: Type.Optional(Type.Object({ maxRejects: Type.Optional(Type.Number()) })),
	budget: Type.Optional(
		Type.Object({
			maxCost: Type.Optional(Type.Number()),
			maxTurns: Type.Optional(Type.Number()),
			maxMinutes: Type.Optional(Type.Number()),
		}),
	),
	ui: Type.Optional(
		Type.Object({
			autoAnswer: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean()]))),
		}),
	),
});

export type BundleManifest = Static<typeof BundleManifestSchema>;
export type BundleFile = Static<typeof BundleFileSchema>;

export interface ManifestValidationResult {
	ok: boolean;
	schemaError?: string;
	pathErrors: PathSafetyError[];
}

export function validateManifest(value: unknown): ManifestValidationResult {
	if (!Value.Check(BundleManifestSchema, value)) {
		const first = Value.Errors(BundleManifestSchema, value)[0];
		const where = first?.instancePath ? ` at ${first.instancePath}` : "";
		return { ok: false, schemaError: `${first?.message ?? "schema violation"}${where}`, pathErrors: [] };
	}
	const manifest = value as BundleManifest;
	const pathErrors = validateManifestPaths(manifest.files.map((f) => f.path));
	return { ok: pathErrors.length === 0, pathErrors };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic bundle hash: sha256 over sorted `<path>\n<sha256>\n` pairs.
 * Independent of platform path separators and directory walk order (AC-0.1).
 */
export function computeBundleHash(files: readonly Pick<BundleFile, "path" | "sha256">[]): string {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const hash = createHash("sha256");
	for (const file of sorted) hash.update(`${file.path}\n${file.sha256}\n`);
	return hash.digest("hex");
}

export type ManifestMeta = Omit<BundleManifest, "v" | "bundleHash" | "files">;

/** Build a manifest from a bundle directory. Walks recursively, sorted, POSIX paths. */
export async function buildManifest(dir: string, meta: ManifestMeta): Promise<BundleManifest> {
	const files: BundleFile[] = [];
	await walk(dir, "", files);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const pathErrors = validateManifestPaths(files.map((f) => f.path));
	if (pathErrors.length > 0) {
		const first = pathErrors[0];
		throw new Error(`bundle contains unsafe path (${first?.code}): ${first?.path}`);
	}
	return { v: 1, ...meta, bundleHash: computeBundleHash(files), files };
}

async function walk(root: string, prefix: string, out: BundleFile[]): Promise<void> {
	const entries = await readdir(join(root, ...(prefix ? prefix.split("/") : [])), {
		withFileTypes: true,
	});
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			await walk(root, relative, out);
		} else if (entry.isFile()) {
			const content = await readFile(join(root, ...relative.split("/")));
			out.push({ path: relative, sha256: sha256Hex(content), bytes: content.byteLength });
		}
	}
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Fetches one bundle file's bytes from a registry. */
export type BundleFileFetcher = (path: string, sha256: string) => Promise<Buffer>;

export interface SyncBase {
	dir: string;
	manifest: BundleManifest;
}

export interface SyncResult {
	status: "cache_hit" | "synced";
	dir: string;
	/** Manifest paths actually fetched from the registry. */
	fetched: string[];
	/** Manifest paths copied from the base cache. */
	reused: string[];
}

export class BundleSyncError extends Error {
	readonly code:
		| "unsafe_path"
		| "invalid_manifest"
		| "hash_mismatch"
		| "fetch_failed";

	constructor(code: BundleSyncError["code"], message: string) {
		super(message);
		this.code = code;
		this.name = "BundleSyncError";
	}
}

/**
 * Sync a bundle into `cacheRoot/<bundleHash>/`.
 *
 * - Validates the manifest (schema + every path) before writing anything.
 * - Cache hit when the target directory already exists.
 * - With `base` (a previous cache dir + its manifest), unchanged files are
 *   copied locally; only changed/added files are fetched (AC-0.2).
 * - Every fetched file's sha256 is verified against the manifest.
 * - The complete bundle is staged in a temp dir and renamed into place
 *   atomically; a killed sync never leaves a half-updated active cache.
 */
export async function syncBundle(options: {
	manifest: BundleManifest;
	fetchFile: BundleFileFetcher;
	cacheRoot: string;
	base?: SyncBase;
}): Promise<SyncResult> {
	const { manifest, fetchFile, cacheRoot, base } = options;

	const validation = validateManifest(manifest);
	if (!validation.ok) {
		if (validation.pathErrors.length > 0) {
			const first = validation.pathErrors[0];
			throw new BundleSyncError("unsafe_path", `unsafe manifest path (${first?.code}): ${first?.path}`);
		}
		throw new BundleSyncError("invalid_manifest", validation.schemaError ?? "invalid manifest");
	}

	const target = join(cacheRoot, manifest.bundleHash);
	if (await exists(target)) {
		return { status: "cache_hit", dir: target, fetched: [], reused: [] };
	}

	await mkdir(cacheRoot, { recursive: true });
	const temp = await mkdtemp(join(cacheRoot, ".sync-"));
	const fetched: string[] = [];
	const reused: string[] = [];

	try {
		const baseHashes = new Map<string, string>();
		if (base) {
			for (const file of base.manifest.files) baseHashes.set(file.path, file.sha256);
		}

		for (const file of manifest.files) {
			const destination = toNativePath(temp, file.path);
			await mkdir(join(destination, ".."), { recursive: true });

			if (base && baseHashes.get(file.path) === file.sha256) {
				await copyFile(toNativePath(base.dir, file.path), destination);
				reused.push(file.path);
				continue;
			}

			let content: Buffer;
			try {
				content = await fetchFile(file.path, file.sha256);
			} catch (error) {
				throw new BundleSyncError(
					"fetch_failed",
					`failed to fetch ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (sha256Hex(content) !== file.sha256) {
				throw new BundleSyncError("hash_mismatch", `hash mismatch for ${file.path}`);
			}
			await writeFile(destination, content);
			fetched.push(file.path);
		}

		try {
			await rename(temp, target);
		} catch (error) {
			// Lost a race with a concurrent sync of the same bundle: treat as hit.
			if (await exists(target)) {
				await rm(temp, { recursive: true, force: true });
				return { status: "cache_hit", dir: target, fetched: [], reused: [] };
			}
			throw error;
		}
		return { status: "synced", dir: target, fetched, reused };
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
}

/** Write a manifest next to a built bundle (registry-side helper). */
export async function writeManifest(path: string, manifest: BundleManifest): Promise<void> {
	await writeFile(path, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
