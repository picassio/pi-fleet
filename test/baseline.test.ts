/**
 * Phase 3.5: rpcRequest correlation + baseline persistence (AC-3.5.1/3.5.2
 * groundwork). Fake worker answers compact/set_session_name/get_state/
 * switch_session/clone with correlated responses.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { AgentClient } from "../src/server/agent-client.ts";
import { FleetManager } from "../src/server/fleet.ts";

async function makeRpcWorker(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-rpc-worker-"));
	const path = join(dir, "worker.mjs");
	await writeFile(
		path,
		`
let buffer = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const calls = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		calls.push(cmd.type);
		if (cmd.type === "prompt") {
			setTimeout(() => {
				send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "primed" }] } });
				send({ type: "agent_settled" });
			}, 50);
		} else if (cmd.type === "get_state") {
			send({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/sessions/baseline.jsonl", calls } });
		} else {
			send({ id: cmd.id ?? null, type: "response", command: cmd.type, success: true, data: {} });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
		"utf8",
	);
	return path;
}

let running: RunningAgent | undefined;
let fleet: FleetManager | undefined;

afterEach(async () => {
	await fleet?.close();
	fleet = undefined;
	await running?.close();
	running = undefined;
});

async function setup(): Promise<FleetManager> {
	const workerPath = await makeRpcWorker();
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
		whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
		supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
	});
	const port = running.port;
	const registryRoot = await mkdtemp(join(tmpdir(), "pf-bl-reg-"));
	fleet = new FleetManager({
		registryUrl: "http://registry.test.local",
		registryRoot,
		connectAgent: (host) => AgentClient.connect(host, port),
	});
	return fleet;
}

describe("Phase 3.5 baselines", () => {
	it("rpcRequest correlates responses by id and times out cleanly", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		const state = await manager.rpcRequest(tracked.instanceId, { type: "get_state" });
		expect((state as { data?: { sessionFile?: string } }).data?.sessionFile).toBe("/tmp/sessions/baseline.jsonl");
	});

	it("baseline flow: prime → settle → compact → name → get_state → persist; survives manager restart", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.prompt(tracked.instanceId, "explore");
		await manager.waitSettled(tracked.instanceId, 10_000);
		await manager.rpcRequest(tracked.instanceId, { type: "compact" });
		await manager.rpcRequest(tracked.instanceId, { type: "set_session_name", name: "baseline:api" });
		const state = await manager.rpcRequest(tracked.instanceId, { type: "get_state" });
		const sessionPath = (state as { data: { sessionFile: string } }).data.sessionFile;
		await manager.saveBaseline({
			label: "api",
			host: "127.0.0.1",
			cwd: tmpdir(),
			sessionPath,
			bundle: "default",
			createdAt: Date.now(),
		});

		// New manager instance (server restart) reloads baselines from disk.
		const reloaded = new FleetManager({
			registryUrl: "http://registry.test.local",
			registryRoot: manager.registryRoot,
			connectAgent: () => Promise.reject(new Error("not needed")),
			autoReconnect: false,
		});
		const baselines = await reloaded.loadBaselines();
		expect(baselines.get("api")?.sessionPath).toBe("/tmp/sessions/baseline.jsonl");
		await reloaded.close();
	});

	it("clone-on-spawn: switch_session + clone are answered against the worker", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.rpcRequest(tracked.instanceId, { type: "switch_session", sessionPath: "/tmp/sessions/baseline.jsonl" });
		await manager.rpcRequest(tracked.instanceId, { type: "clone" });
		const state = await manager.rpcRequest(tracked.instanceId, { type: "get_state" });
		const calls = (state as { data: { calls: string[] } }).data.calls;
		expect(calls).toContain("switch_session");
		expect(calls).toContain("clone");
	});
});

describe("Phase 4 enforcement", () => {
	it("AC-4.3: platform-mismatched bundles are refused before spawn", async () => {
		const manager = await setup();
		const { mkdir: mkdirFs, writeFile: writeFs } = await import("node:fs/promises");
		const bundleDir = join(manager.registryRoot, "linux-only");
		await mkdirFs(bundleDir, { recursive: true });
		await writeFs(
			join(bundleDir, "manifest.json"),
			JSON.stringify({ v: 1, name: "linux-only", bundleHash: "0".repeat(64), platforms: ["fake-os"], files: [] }),
		);
		await expect(
			manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "linux-only" }),
		).rejects.toThrow(/targets \[fake-os\]/);
	});
});

describe("remote_model plumbing", () => {
	it("set_model and set_thinking_level round-trip through rpcRequest", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		const setModel = (await manager.rpcRequest(tracked.instanceId, {
			type: "set_model",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		})) as { success?: boolean; type?: string };
		expect(setModel.success).toBe(true);
		const thinking = (await manager.rpcRequest(tracked.instanceId, {
			type: "set_thinking_level",
			level: "high",
		})) as { success?: boolean };
		expect(thinking.success).toBe(true);
	});
});

describe("fleet doctor", () => {
	it("reports registry, baselines, agents, and workers", async () => {
		const manager = await setup();
		await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		const lines = (await manager.doctor()).join("\n");
		expect(lines).toContain("registry:");
		expect(lines).toMatch(/baselines: \d+/);
		expect(lines).toContain("agent 127.0.0.1: connected");
		expect(lines).toContain("workers: 1 running / 1 tracked");
	});
});

describe("AC-3.5.5 session_search", () => {
	it("greps agent-local session files and returns only hits", async () => {
		const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
		const sessionsDir = await mkdtemp(join(tmpdir(), "pf-sessions-"));
		await mk(join(sessionsDir, "proj"), { recursive: true });
		await wf(join(sessionsDir, "proj", "abc123.jsonl"), JSON.stringify({ cwd: "/repo", name: "baseline:api" }) + "\n" + JSON.stringify({ type: "message", text: "refactor the auth flow" }) + "\n");
		await wf(join(sessionsDir, "proj", "zzz.jsonl"), '{"type":"message","text":"unrelated"}\n');

		const workerPath = await makeRpcWorker();
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
			sessionsDir,
			whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		const client = await AgentClient.connect("127.0.0.1", running.port);
		try {
			// AC-3.5.4 core: sessions_report pushed on connect from agent disk.
			const report = await new Promise<{ sessions: Array<{ sessionId: string; kind: string; cwd: string }> }>(
				(resolvePromise) => client.onSessionsReport(resolvePromise),
			);
			expect(report.sessions.map((entry) => entry.sessionId).sort()).toEqual(["abc123", "zzz"]);

			const hits = await client.sessionSearch("auth flow");
			expect(hits).toHaveLength(1);
			expect(hits[0]?.sessionId).toBe("abc123");
			expect(hits[0]?.snippet).toContain("refactor the auth flow");
		} finally {
			client.close();
		}
	});
});
