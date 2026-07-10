/**
 * AC-3.4a/c/d: fs review channel — cwd containment, image round-trip,
 * truncation/paging, grep bounds, git diff. Loopback through the full
 * daemon + client stack.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { fsGrep, fsRead } from "../src/agent/fsservice.ts";
import { AgentClient } from "../src/server/agent-client.ts";

let running: RunningAgent | undefined;
let client: AgentClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await running?.close();
	running = undefined;
});

async function makeWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-fs-ws-"));
	await writeFile(join(dir, "hello.txt"), "line1\nline2\nline3\n", "utf8");
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "src", "app.ts"), "const TODO = 1;\nexport {};\n", "utf8");
	// 1x1 transparent PNG
	await writeFile(
		join(dir, "shot.png"),
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	return dir;
}

async function setup(cwd: string): Promise<AgentClient> {
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
		whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
		supervisor: {
			resolveCommand: async () => ({
				command: process.execPath,
				args: ["-e", "setInterval(()=>{},1000)"],
			}),
		},
	});
	client = await AgentClient.connect("127.0.0.1", running.port);
	await client.spawn({ cwd, bundle: "default" });
	return client;
}

async function spawnedId(agentClient: AgentClient): Promise<string> {
	const [instance] = await agentClient.list();
	if (!instance) throw new Error("no instance");
	return instance.instanceId;
}

describe("fs review channel over the control plane", () => {
	it("reads text files and pages with offset/limit", async () => {
		const workspace = await makeWorkspace();
		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);

		const full = await agentClient.fs({ type: "fs_read", instanceId, path: "hello.txt" });
		expect(full.text).toBe("line1\nline2\nline3\n");

		const page = await agentClient.fs({ type: "fs_read", instanceId, path: "hello.txt", offset: 1, limit: 1 });
		expect(page.text).toBe("line2");
		expect(page.truncated).toBe(true);
	});

	it("AC-3.4a: refuses escapes and unknown instances", async () => {
		const workspace = await makeWorkspace();
		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);

		const escape = await agentClient.fs({ type: "fs_read", instanceId, path: "../outside.txt" });
		expect(escape.error?.code).toBe("path_escape");

		const ghost = await agentClient.fs({ type: "fs_read", instanceId: "i-ghost", path: "hello.txt" });
		expect(ghost.error?.code).toBe("unknown_instance");
	});

	it("AC-3.4c: images return base64 + mime", async () => {
		const workspace = await makeWorkspace();
		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);
		const image = await agentClient.fs({ type: "fs_read", instanceId, path: "shot.png" });
		expect(image.mime).toBe("image/png");
		expect(Buffer.from(image.base64 ?? "", "base64").subarray(1, 4).toString()).toBe("PNG");
	});

	it("lists directories and greps with glob", async () => {
		const workspace = await makeWorkspace();
		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);

		const listing = await agentClient.fs({ type: "fs_list", instanceId, path: "." });
		expect(listing.entries?.map((entry) => entry.name).sort()).toEqual(["hello.txt", "shot.png", "src"]);

		const hits = await agentClient.fs({ type: "fs_grep", instanceId, pattern: "TODO", glob: "**/*.ts" });
		expect(hits.text).toContain("src/app.ts:1:");
	});

	it("git diff works in a repo workspace", async () => {
		const workspace = await makeWorkspace();
		execFileSync("git", ["init", "-q"], { cwd: workspace });
		execFileSync("git", ["add", "-A"], { cwd: workspace });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: workspace });
		await writeFile(join(workspace, "hello.txt"), "line1\nCHANGED\nline3\n", "utf8");

		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);
		const diff = await agentClient.fs({ type: "fs_diff", instanceId, stat: true });
		expect(diff.text).toContain("hello.txt");
		const fullDiff = await agentClient.fs({ type: "fs_diff", instanceId });
		expect(fullDiff.text).toContain("+CHANGED");
	});
});

describe("fsservice bounds (direct)", () => {
	it("caps grep matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pf-grep-"));
		await writeFile(join(dir, "big.txt"), Array.from({ length: 500 }, () => "match").join("\n"), "utf8");
		const result = await fsGrep(dir, "match");
		expect(result.truncated).toBe(true);
		expect(result.text?.split("\n")).toHaveLength(200);
	});

	it("truncates huge text reads by bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pf-big-"));
		await writeFile(join(dir, "huge.txt"), "x".repeat(200 * 1024), "utf8");
		const result = await fsRead(dir, "huge.txt");
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text ?? "", "utf8")).toBeLessThanOrEqual(50 * 1024);
	});
});

describe("fs_diff revParse", () => {
	it("returns the repo HEAD hash", async () => {
		const workspace = await makeWorkspace();
		execFileSync("git", ["init", "-q"], { cwd: workspace });
		execFileSync("git", ["add", "-A"], { cwd: workspace });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: workspace });
		const agentClient = await setup(workspace);
		const instanceId = await spawnedId(agentClient);
		const head = await agentClient.fs({ type: "fs_diff", instanceId, revParse: true });
		expect(head.text?.trim()).toMatch(/^[0-9a-f]{40}$/);
	});
});
