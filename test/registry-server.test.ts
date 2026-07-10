import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNativePath } from "../src/core/pathsafety.ts";
import { provisionBundle } from "../src/worker/bootstrap.ts";
import { HttpRegistry, publishBundle } from "../src/worker/registry.ts";
import { startRegistryServer, type RunningRegistryServer } from "../src/server/registry-server.ts";

let running: RunningRegistryServer;
let bundleHash: string;

beforeAll(async () => {
	const source = await mkdtemp(join(tmpdir(), "pf-http-src-"));
	await mkdir(join(source, "skills", "greet"), { recursive: true });
	await writeFile(
		toNativePath(source, "skills/greet/SKILL.md"),
		"---\nname: greet\ndescription: Greets\n---\nhi\n",
		"utf8",
	);
	const registryRoot = await mkdtemp(join(tmpdir(), "pf-http-reg-"));
	const manifest = await publishBundle({
		sourceDir: source,
		registryRoot,
		meta: { name: "default", skills: ["skills"] },
	});
	bundleHash = manifest.bundleHash;
	running = await startRegistryServer({ root: registryRoot, host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
	await running.close();
});

describe("registry server + HttpRegistry client", () => {
	it("serves health", async () => {
		const response = await fetch(`${running.url}/healthz`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, service: "pi-fleet-registry" });
	});

	it("serves a valid manifest", async () => {
		const registry = new HttpRegistry(running.url);
		const manifest = await registry.fetchManifest("default");
		expect(manifest.bundleHash).toBe(bundleHash);
	});

	it("404s unknown bundles as not_found", async () => {
		const registry = new HttpRegistry(running.url);
		await expect(registry.fetchManifest("ghost")).rejects.toMatchObject({ code: "not_found" });
	});

	it("serves files only by exact manifest path+hash", async () => {
		const registry = new HttpRegistry(running.url);
		const manifest = await registry.fetchManifest("default");
		const file = manifest.files[0];
		expect(file).toBeDefined();
		if (!file) return;

		const fetcher = registry.fileFetcher("default");
		const content = await fetcher(file.path, file.sha256);
		expect(content.toString("utf8")).toContain("Greets");

		// Wrong hash → refused.
		await expect(fetcher(file.path, "0".repeat(64))).rejects.toThrow(/404/);
	});

	it("refuses unsafe and unpublished paths without touching the filesystem", async () => {
		for (const path of ["../../etc/passwd", "/etc/passwd", "not/published.txt"]) {
			const response = await fetch(
				`${running.url}/v1/bundles/default/file?path=${encodeURIComponent(path)}&hash=${"0".repeat(64)}`,
			);
			expect([400, 404]).toContain(response.status);
		}
	});

	it("end-to-end: provisionBundle over HTTP", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-http-cache-"));
		const result = await provisionBundle({
			server: running.url,
			bundle: "default",
			cacheRoot,
		});
		expect(result.status).toBe("ready");
		expect(result.manifest.bundleHash).toBe(bundleHash);
		expect(result.fetched).toEqual(["skills/greet/SKILL.md"]);
	});
});
