/**
 * HTTP bundle registry server — the HTTP half of the server-mode listener
 * (docs/plan.md "Bundle registry"). Serves an on-disk registry produced by
 * publishBundle():
 *
 *   GET /healthz
 *   GET /v1/bundles/<name>/manifest
 *   GET /v1/bundles/<name>/file?path=<posix-path>&hash=<sha256>
 *
 * Every requested file path is validated (path safety) and looked up in the
 * bundle's manifest by exact path+hash before any filesystem access — the
 * manifest is the allowlist, so traversal or probing outside published
 * content is impossible by construction.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest, type BundleManifest } from "../core/bundle.ts";
import { toNativePath, validateManifestPath } from "../core/pathsafety.ts";

export interface RegistryServerOptions {
	/** Registry root directory (publishBundle layout). */
	root: string;
	/** Interface to bind — the tailscale IP in production, 127.0.0.1 in tests. */
	host: string;
	port: number;
	/** Optional connection observer (logging). */
	onRequest?: (info: { remoteAddress: string; method: string; url: string }) => void;
	/** Optional gate: return false to refuse (403). Failing gates deny. */
	allow?: (remoteAddress: string) => Promise<boolean>;
}

export interface RunningRegistryServer {
	server: Server;
	host: string;
	port: number;
	url: string;
	close(): Promise<void>;
}

const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/i;

export async function startRegistryServer(
	options: RegistryServerOptions,
): Promise<RunningRegistryServer> {
	const { root, host, port, onRequest, allow } = options;

	const server = createServer((request, response) => {
		void handleGated(root, request, response, onRequest, allow).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(port, host, () => {
			server.removeListener("error", rejectPromise);
			resolvePromise();
		});
	});

	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;
	return {
		server,
		host,
		port: boundPort,
		url: `http://${host}:${boundPort}`,
		close: () =>
			new Promise<void>((resolvePromise, rejectPromise) => {
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
			}),
	};
}

async function handleGated(
	root: string,
	request: IncomingMessage,
	response: ServerResponse,
	onRequest: RegistryServerOptions["onRequest"],
	allow: RegistryServerOptions["allow"],
): Promise<void> {
	if (allow) {
		const ip = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
		let ok = false;
		try {
			ok = await allow(ip);
		} catch {
			ok = false;
		}
		if (!ok) {
			response.writeHead(403, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "forbidden" }));
			return;
		}
	}
	return handle(root, request, response, onRequest);
}

async function handle(
	root: string,
	request: IncomingMessage,
	response: ServerResponse,
	onRequest: RegistryServerOptions["onRequest"],
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://registry.local");
	onRequest?.({
		remoteAddress: request.socket.remoteAddress ?? "",
		method: request.method ?? "",
		url: url.pathname,
	});

	if (request.method !== "GET") {
		return sendJson(response, 405, { error: "method_not_allowed" });
	}
	if (url.pathname === "/healthz") {
		return sendJson(response, 200, { ok: true, service: "pi-fleet-registry" });
	}

	const match = url.pathname.match(/^\/v1\/bundles\/([^/]+)\/(manifest|file)$/);
	if (!match) return sendJson(response, 404, { error: "not_found" });
	const bundle = decodeURIComponent(match[1] ?? "");
	const kind = match[2];
	if (!BUNDLE_NAME_PATTERN.test(bundle)) {
		return sendJson(response, 400, { error: "invalid_bundle_name" });
	}

	const manifest = await loadManifest(root, bundle);
	if (manifest === null) return sendJson(response, 404, { error: "bundle_not_found" });

	if (kind === "manifest") {
		return sendJson(response, 200, manifest);
	}

	const path = url.searchParams.get("path") ?? "";
	const hash = url.searchParams.get("hash") ?? "";
	if (validateManifestPath(path) !== null) {
		return sendJson(response, 400, { error: "unsafe_path" });
	}
	// The manifest is the allowlist: exact path+hash must be published.
	const entry = manifest.files.find((file) => file.path === path && file.sha256 === hash);
	if (!entry) return sendJson(response, 404, { error: "file_not_in_manifest" });

	let content: Buffer;
	try {
		content = await readFile(toNativePath(join(root, bundle, "files"), path));
	} catch {
		return sendJson(response, 404, { error: "file_missing" });
	}
	response.writeHead(200, {
		"content-type": "application/octet-stream",
		"content-length": content.byteLength,
	});
	response.end(content);
}

async function loadManifest(root: string, bundle: string): Promise<BundleManifest | null> {
	let raw: string;
	try {
		raw = await readFile(join(root, bundle, "manifest.json"), "utf8");
	} catch {
		return null;
	}
	try {
		const value = JSON.parse(raw) as unknown;
		return validateManifest(value).ok ? (value as BundleManifest) : null;
	} catch {
		return null;
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}
