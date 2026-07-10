import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toNativePath } from "../src/core/pathsafety.ts";
import {
	parseWorkerEnv,
	provisionBundle,
	resolveResources,
	type WorkerEnv,
} from "../src/worker/bootstrap.ts";
import { DirectoryRegistry, publishBundle } from "../src/worker/registry.ts";

async function makeSourceDir(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-src-"));
	for (const [path, content] of Object.entries(files)) {
		const native = toNativePath(dir, path);
		await mkdir(join(native, ".."), { recursive: true });
		await writeFile(native, content, "utf8");
	}
	return dir;
}

async function makeRegistry(files: Record<string, string>, name = "default") {
	const source = await makeSourceDir(files);
	const registryRoot = await mkdtemp(join(tmpdir(), "pf-reg-"));
	const manifest = await publishBundle({
		sourceDir: source,
		registryRoot,
		meta: { name, skills: ["skills"], extensions: ["extensions/hello.ts"] },
	});
	return { registryRoot, manifest };
}

function envFor(registryRoot: string, cacheRoot: string, bundle = "default"): WorkerEnv {
	return { server: registryRoot, bundle, cacheRoot };
}

const bundleFiles = {
	"skills/greet/SKILL.md": "---\nname: greet\ndescription: Greets\n---\nSay hi.",
	"extensions/hello.ts": "export default function (pi) {}",
	"prompts/prime.md": "explore",
};

describe("parseWorkerEnv", () => {
	it("returns null when no fleet env is set", () => {
		expect(parseWorkerEnv({})).toBeNull();
	});

	it("requires both server and bundle", () => {
		expect(() => parseWorkerEnv({ PI_FLEET_BUNDLE: "default" })).toThrow(/PI_FLEET_SERVER/);
		expect(() => parseWorkerEnv({ PI_FLEET_SERVER: "file:///x" })).toThrow(/PI_FLEET_BUNDLE/);
	});

	it("parses the full contract", () => {
		const env = parseWorkerEnv({
			PI_FLEET_SERVER: "http://100.64.1.5:9787",
			PI_FLEET_BUNDLE: "default",
			PI_FLEET_CACHE: "/tmp/cache",
			PI_FLEET_BUNDLE_HASH: "a".repeat(64),
			PI_FLEET_INSTANCE_ID: "i-1",
			PI_FLEET_TASK_ID: "t-1",
			PI_FLEET_TRACE_ID: "tr-1",
		});
		expect(env).toEqual({
			server: "http://100.64.1.5:9787",
			bundle: "default",
			cacheRoot: "/tmp/cache",
			pinnedHash: "a".repeat(64),
			instanceId: "i-1",
			taskId: "t-1",
			traceId: "tr-1",
		});
	});

	it("defaults cacheRoot under the home directory", () => {
		const env = parseWorkerEnv({ PI_FLEET_SERVER: "file:///x", PI_FLEET_BUNDLE: "default" });
		expect(env?.cacheRoot).toContain(".pi");
	});
});

describe("AC-1.1/1.4/1.6 provisionBundle", () => {
	it("provisions fresh from a directory registry", async () => {
		const { registryRoot, manifest } = await makeRegistry(bundleFiles);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const result = await provisionBundle(envFor(registryRoot, cacheRoot));
		expect(result.status).toBe("ready");
		expect(result.manifest.bundleHash).toBe(manifest.bundleHash);
		expect(result.fetched.length).toBe(3);
		expect(result.dir).toBe(join(cacheRoot, manifest.bundleHash));
	});

	it("AC-1.4: unchanged respawn is a cache hit with zero file fetches", async () => {
		const { registryRoot } = await makeRegistry(bundleFiles);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await provisionBundle(envFor(registryRoot, cacheRoot));
		const second = await provisionBundle(envFor(registryRoot, cacheRoot));
		expect(second.status).toBe("ready");
		expect(second.fetched).toHaveLength(0);
	});

	it("changed bundle fetches only changed files via the pointer base", async () => {
		const source = await makeSourceDir(bundleFiles);
		const registryRoot = await mkdtemp(join(tmpdir(), "pf-reg-"));
		const meta = { name: "default", skills: ["skills"] };
		await publishBundle({ sourceDir: source, registryRoot, meta });
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await provisionBundle(envFor(registryRoot, cacheRoot));

		// Change one file, republish.
		await writeFile(toNativePath(source, "prompts/prime.md"), "explore deeper", "utf8");
		await publishBundle({ sourceDir: source, registryRoot, meta });

		const result = await provisionBundle(envFor(registryRoot, cacheRoot));
		expect(result.status).toBe("ready");
		expect(result.fetched).toEqual(["prompts/prime.md"]);
		expect(result.reused.sort()).toEqual(["extensions/hello.ts", "skills/greet/SKILL.md"]);
	});

	it("AC-1.6: registry unreachable + cache exists → degraded start from cache", async () => {
		const { registryRoot, manifest } = await makeRegistry(bundleFiles);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await provisionBundle(envFor(registryRoot, cacheRoot));

		await rm(registryRoot, { recursive: true, force: true });
		const result = await provisionBundle(envFor(registryRoot, cacheRoot));
		expect(result.status).toBe("degraded");
		expect(result.manifest.bundleHash).toBe(manifest.bundleHash);
	});

	it("AC-1.6: registry unreachable + no cache → fails fast with actionable error", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await expect(
			provisionBundle(envFor("/nonexistent/registry", cacheRoot)),
		).rejects.toThrow(/registry unreachable and no cached copy/);
	});

	it("AC-4.4 groundwork: pinned hash mismatch refuses to provision", async () => {
		const { registryRoot } = await makeRegistry(bundleFiles);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const env = { ...envFor(registryRoot, cacheRoot), pinnedHash: "f".repeat(64) };
		await expect(provisionBundle(env)).rejects.toThrow(/hash mismatch/);
	});

	it("rejects a registry serving an invalid manifest", async () => {
		const registryRoot = await mkdtemp(join(tmpdir(), "pf-reg-"));
		await mkdir(join(registryRoot, "default"), { recursive: true });
		await writeFile(join(registryRoot, "default", "manifest.json"), '{"v":1}', "utf8");
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await expect(provisionBundle(envFor(registryRoot, cacheRoot))).rejects.toThrow(/invalid/);
	});
});

describe("resolveResources", () => {
	it("maps manifest resource declarations to absolute native paths", async () => {
		const { registryRoot } = await makeRegistry(bundleFiles);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const result = await provisionBundle(envFor(registryRoot, cacheRoot));
		const resources = resolveResources(result.manifest, result.dir);
		expect(resources.skillPaths).toEqual([join(result.dir, "skills")]);
		expect(resources.extensionPaths).toEqual([join(result.dir, "extensions", "hello.ts")]);
		expect(resources.promptPaths).toEqual([]);
	});
});

describe("DirectoryRegistry", () => {
	it("reports not_found for missing bundles", async () => {
		const registryRoot = await mkdtemp(join(tmpdir(), "pf-reg-"));
		const registry = new DirectoryRegistry(registryRoot);
		await expect(registry.fetchManifest("ghost")).rejects.toMatchObject({ code: "not_found" });
	});
});
