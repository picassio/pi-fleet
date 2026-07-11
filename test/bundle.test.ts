import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BundleSyncError,
	buildManifest,
	computeBundleHash,
	sha256Hex,
	syncBundle,
	validateManifest,
	type BundleFileFetcher,
	type BundleManifest,
} from "../src/core/bundle.ts";
import { toNativePath } from "../src/core/pathsafety.ts";

async function makeBundleDir(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-bundle-"));
	for (const [path, content] of Object.entries(files)) {
		const native = toNativePath(dir, path);
		await mkdir(join(native, ".."), { recursive: true });
		await writeFile(native, content, "utf8");
	}
	return dir;
}

/** file:// style registry fake backed by a directory. */
function directoryFetcher(dir: string): BundleFileFetcher & { calls: string[] } {
	const calls: string[] = [];
	const fetcher: BundleFileFetcher = async (path: string) => {
		calls.push(path);
		return readFile(toNativePath(dir, path));
	};
	return Object.assign(fetcher, { calls });
}

const meta = { name: "default" };

describe("AC-0.1 manifest determinism", () => {
	it("builds identical manifests and bundleHash from the same directory twice", async () => {
		const dir = await makeBundleDir({
			"skills/review/SKILL.md": "# Review",
			"extensions/reviewer.ts": "export default () => {};",
			"prompts/prime.md": "explore the repo",
		});
		const a = await buildManifest(dir, meta);
		const b = await buildManifest(dir, meta);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a.bundleHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("bundleHash is independent of file insertion order", () => {
		const files = [
			{ path: "b.txt", sha256: sha256Hex("b") },
			{ path: "a.txt", sha256: sha256Hex("a") },
		];
		expect(computeBundleHash(files)).toBe(computeBundleHash([...files].reverse()));
	});

	it("bundleHash changes when content changes", () => {
		const base = [{ path: "a.txt", sha256: sha256Hex("a") }];
		const changed = [{ path: "a.txt", sha256: sha256Hex("A") }];
		expect(computeBundleHash(base)).not.toBe(computeBundleHash(changed));
	});

	it("walks nested directories with sorted POSIX paths", async () => {
		const dir = await makeBundleDir({ "z.txt": "z", "a/deep/nested.txt": "n", "a/first.txt": "f" });
		const manifest = await buildManifest(dir, meta);
		expect(manifest.files.map((f) => f.path)).toEqual(["a/deep/nested.txt", "a/first.txt", "z.txt"]);
	});
});

describe("AC-0.2 sync correctness", () => {
	it("syncs a fresh bundle, fetching every file", async () => {
		const source = await makeBundleDir({ "a.txt": "alpha", "sub/b.txt": "beta" });
		const manifest = await buildManifest(source, meta);
		const fetcher = directoryFetcher(source);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));

		const result = await syncBundle({ manifest, fetchFile: fetcher, cacheRoot });
		expect(result.status).toBe("synced");
		expect(result.fetched.sort()).toEqual(["a.txt", "sub/b.txt"]);
		expect(await readFile(join(result.dir, "a.txt"), "utf8")).toBe("alpha");
		expect(await readFile(toNativePath(result.dir, "sub/b.txt"), "utf8")).toBe("beta");
	});

	it("cache hit performs zero fetches (AC-1.4 groundwork)", async () => {
		const source = await makeBundleDir({ "a.txt": "alpha" });
		const manifest = await buildManifest(source, meta);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		await syncBundle({ manifest, fetchFile: directoryFetcher(source), cacheRoot });

		const fetcher = directoryFetcher(source);
		const result = await syncBundle({ manifest, fetchFile: fetcher, cacheRoot });
		expect(result.status).toBe("cache_hit");
		expect(fetcher.calls).toHaveLength(0);
	});

	it("with a base cache, fetches exactly changed+added files and reuses the rest", async () => {
		const v1 = await makeBundleDir({ "same.txt": "same", "changed.txt": "old", "removed.txt": "bye" });
		const manifestV1 = await buildManifest(v1, meta);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const baseResult = await syncBundle({ manifest: manifestV1, fetchFile: directoryFetcher(v1), cacheRoot });

		const v2 = await makeBundleDir({ "same.txt": "same", "changed.txt": "new", "added.txt": "hi" });
		const manifestV2 = await buildManifest(v2, meta);
		const fetcher = directoryFetcher(v2);
		const result = await syncBundle({
			manifest: manifestV2,
			fetchFile: fetcher,
			cacheRoot,
			base: { dir: baseResult.dir, manifest: manifestV1 },
		});

		expect(result.status).toBe("synced");
		expect(result.fetched.sort()).toEqual(["added.txt", "changed.txt"]);
		expect(result.reused).toEqual(["same.txt"]);
		// Result matches manifest exactly: removed.txt is gone.
		const entries = await readdir(result.dir);
		expect(entries.sort()).toEqual(["added.txt", "changed.txt", "same.txt"]);
		expect(await readFile(join(result.dir, "changed.txt"), "utf8")).toBe("new");
	});

	it("verifies fetched content hashes", async () => {
		const source = await makeBundleDir({ "a.txt": "alpha" });
		const manifest = await buildManifest(source, meta);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const lyingFetcher: BundleFileFetcher = async () => Buffer.from("tampered");

		await expect(
			syncBundle({ manifest, fetchFile: lyingFetcher, cacheRoot }),
		).rejects.toThrow(BundleSyncError);
		// Atomicity: nothing landed in the cache.
		const entries = (await readdir(cacheRoot)).filter((e) => !e.startsWith(".sync-"));
		expect(entries).toHaveLength(0);
	});

	it("a failed sync leaves no active cache dir (atomic swap)", async () => {
		const source = await makeBundleDir({ "a.txt": "alpha", "b.txt": "beta" });
		const manifest = await buildManifest(source, meta);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const failingFetcher: BundleFileFetcher = async (path) => {
			if (path === "b.txt") throw new Error("network died"); // persistent, defeats retries
			return readFile(toNativePath(source, path));
		};

		await expect(syncBundle({ manifest, fetchFile: failingFetcher, cacheRoot })).rejects.toThrow(
			/network died|failed to fetch/,
		);
		expect(await readdir(cacheRoot)).toHaveLength(0);
	});
});

describe("AC-0.3 sync path safety", () => {
	function manifestWith(path: string): BundleManifest {
		const files = [{ path, sha256: sha256Hex("x"), bytes: 1 }];
		return { v: 1, name: "evil", bundleHash: computeBundleHash(files), files };
	}

	it("rejects traversal without writing anything", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const fetcher: BundleFileFetcher = async () => Buffer.from("x");
		await expect(
			syncBundle({ manifest: manifestWith("../escape.txt"), fetchFile: fetcher, cacheRoot }),
		).rejects.toMatchObject({ code: "unsafe_path" });
		expect(await readdir(cacheRoot)).toHaveLength(0);
	});

	it("rejects absolute paths, reserved names, and case collisions", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		const fetcher: BundleFileFetcher = async () => Buffer.from("x");
		for (const path of ["/etc/passwd", "CON.txt"]) {
			await expect(
				syncBundle({ manifest: manifestWith(path), fetchFile: fetcher, cacheRoot }),
			).rejects.toMatchObject({ code: "unsafe_path" });
		}
		const files = [
			{ path: "Foo.ts", sha256: sha256Hex("x"), bytes: 1 },
			{ path: "foo.ts", sha256: sha256Hex("y"), bytes: 1 },
		];
		const colliding: BundleManifest = { v: 1, name: "evil", bundleHash: computeBundleHash(files), files };
		await expect(
			syncBundle({ manifest: colliding, fetchFile: fetcher, cacheRoot }),
		).rejects.toMatchObject({ code: "unsafe_path" });
	});
});

describe("manifest schema validation", () => {
	it("accepts a valid manifest", async () => {
		const dir = await makeBundleDir({ "a.txt": "a" });
		const manifest = await buildManifest(dir, {
			name: "default",
			platforms: ["linux", "darwin"],
			tools: { active: ["read", "grep"] },
			model: { primary: { provider: "anthropic", id: "claude-sonnet-4-5" }, pin: true },
			budget: { maxCost: 5 },
		});
		expect(validateManifest(manifest).ok).toBe(true);
	});

	it("rejects wrong version, bad hashes, missing fields", () => {
		expect(validateManifest({ v: 2, name: "x", bundleHash: "0".repeat(64), files: [] }).ok).toBe(false);
		expect(validateManifest({ v: 1, name: "x", bundleHash: "nope", files: [] }).ok).toBe(false);
		expect(validateManifest({ v: 1, files: [] }).ok).toBe(false);
		const bad = validateManifest({ v: 1, name: "x", bundleHash: "0".repeat(64), files: [{ path: "a", sha256: "short", bytes: 1 }] });
		expect(bad.ok).toBe(false);
		expect(bad.schemaError).toBeTruthy();
	});
});

describe("perf audit: transient fetch retry", () => {
	it("recovers from a transient failure without failing the sync", async () => {
		const source = await makeBundleDir({ "a.txt": "alpha" });
		const manifest = await buildManifest(source, meta);
		const cacheRoot = await mkdtemp(join(tmpdir(), "pf-cache-"));
		let failures = 1;
		const flakyFetcher: BundleFileFetcher = async (path) => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("transient blip");
			}
			return readFile(toNativePath(source, path));
		};
		const result = await syncBundle({ manifest, fetchFile: flakyFetcher, cacheRoot });
		expect(result.status).toBe("synced");
		expect(result.fetched).toEqual(["a.txt"]);
	});
});
