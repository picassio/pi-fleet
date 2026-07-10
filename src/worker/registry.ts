/**
 * Bundle registry clients.
 *
 * A registry serves bundle manifests and file bytes. Two implementations:
 * - DirectoryRegistry: `file://` URL or plain path (Phase 1, also used by tests
 *   as the local registry fake and by the server as its on-disk layout)
 * - HttpRegistry: the server's HTTP endpoints (Phase 2 wire-up)
 *
 * On-disk registry layout (one directory per bundle):
 *   <root>/<name>/manifest.json
 *   <root>/<name>/files/<manifest path>
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildManifest,
	validateManifest,
	writeManifest,
	type BundleFileFetcher,
	type BundleManifest,
	type ManifestMeta,
} from "../core/bundle.ts";
import { toNativePath } from "../core/pathsafety.ts";

export interface RegistryClient {
	/** Fetch and validate a bundle's manifest. */
	fetchManifest(bundle: string): Promise<BundleManifest>;
	/** File fetcher scoped to one bundle, for syncBundle. */
	fileFetcher(bundle: string): BundleFileFetcher;
	/** Human-readable origin for errors and audit records. */
	readonly origin: string;
}

export class RegistryError extends Error {
	readonly code: "unreachable" | "not_found" | "invalid_manifest";

	constructor(code: RegistryError["code"], message: string) {
		super(message);
		this.code = code;
		this.name = "RegistryError";
	}
}

/** Create a registry client from a PI_FLEET_SERVER value. */
export function createRegistry(server: string): RegistryClient {
	if (server.startsWith("file://")) return new DirectoryRegistry(fileURLToPath(server));
	if (server.startsWith("http://") || server.startsWith("https://")) {
		return new HttpRegistry(server);
	}
	// Plain path (useful locally and in tests).
	return new DirectoryRegistry(server);
}

function parseManifest(raw: string, origin: string): BundleManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new RegistryError("invalid_manifest", `manifest from ${origin} is not valid JSON`);
	}
	const validation = validateManifest(value);
	if (!validation.ok) {
		const detail = validation.schemaError ?? validation.pathErrors[0]?.code ?? "invalid";
		throw new RegistryError("invalid_manifest", `manifest from ${origin} is invalid: ${detail}`);
	}
	return value as BundleManifest;
}

export class DirectoryRegistry implements RegistryClient {
	readonly root: string;
	readonly origin: string;

	constructor(root: string) {
		this.root = root;
		this.origin = pathToFileURL(root).href;
	}

	async fetchManifest(bundle: string): Promise<BundleManifest> {
		const path = join(this.root, bundle, "manifest.json");
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			throw new RegistryError(
				code === "ENOENT" ? "not_found" : "unreachable",
				`cannot read manifest for bundle "${bundle}" at ${path}: ${code ?? String(error)}`,
			);
		}
		return parseManifest(raw, this.origin);
	}

	fileFetcher(bundle: string): BundleFileFetcher {
		const filesRoot = join(this.root, bundle, "files");
		return (path) => readFile(toNativePath(filesRoot, path));
	}
}

export class HttpRegistry implements RegistryClient {
	readonly baseUrl: string;
	readonly origin: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.origin = this.baseUrl;
	}

	async fetchManifest(bundle: string): Promise<BundleManifest> {
		const url = `${this.baseUrl}/v1/bundles/${encodeURIComponent(bundle)}/manifest`;
		const response = await this.get(url);
		if (response.status === 404) {
			throw new RegistryError("not_found", `bundle "${bundle}" not found at ${this.origin}`);
		}
		if (!response.ok) {
			throw new RegistryError("unreachable", `manifest fetch failed: HTTP ${response.status}`);
		}
		return parseManifest(await response.text(), this.origin);
	}

	fileFetcher(bundle: string): BundleFileFetcher {
		return async (path, sha256) => {
			const url =
				`${this.baseUrl}/v1/bundles/${encodeURIComponent(bundle)}/file` +
				`?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(sha256)}`;
			const response = await this.get(url);
			if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${path}`);
			return Buffer.from(await response.arrayBuffer());
		};
	}

	private async get(url: string): Promise<Response> {
		try {
			return await fetch(url);
		} catch (error) {
			throw new RegistryError(
				"unreachable",
				`cannot reach registry ${this.origin}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * Publish a bundle source directory into an on-disk registry (server-side
 * helper, also used by tests to build local registries).
 */
export async function publishBundle(options: {
	sourceDir: string;
	registryRoot: string;
	meta: ManifestMeta;
}): Promise<BundleManifest> {
	const { sourceDir, registryRoot, meta } = options;
	const manifest = await buildManifest(sourceDir, meta);
	const bundleRoot = join(registryRoot, manifest.name);
	const filesRoot = join(bundleRoot, "files");
	for (const file of manifest.files) {
		const destination = toNativePath(filesRoot, file.path);
		await mkdir(join(destination, ".."), { recursive: true });
		await copyFile(toNativePath(sourceDir, file.path), destination);
	}
	await mkdir(bundleRoot, { recursive: true });
	await writeManifest(join(bundleRoot, "manifest.json"), manifest);
	return manifest;
}
