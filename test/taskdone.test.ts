/**
 * AC-3.5/3.6: durable task_done — outbox persistence, ack deletion, replay
 * to a late-connecting server, dedupe of replayed duplicates.
 */
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { AgentClient } from "../src/server/agent-client.ts";
import { FleetManager } from "../src/server/fleet.ts";

async function makePromptWorker(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-td-worker-"));
	const path = join(dir, "worker.mjs");
	await writeFile(
		path,
		`
let buffer = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		if (cmd.type === "prompt") {
			setTimeout(() => {
				send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done: " + cmd.message }] } });
				send({ type: "agent_settled" });
			}, 80);
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
const managers: FleetManager[] = [];

afterEach(async () => {
	for (const manager of managers) await manager.close();
	managers.length = 0;
	await running?.close();
	running = undefined;
});

async function startAgent(outboxDir: string): Promise<RunningAgent> {
	const workerPath = await makePromptWorker();
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
		whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
		outboxDir,
		supervisor: {
			resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }),
		},
	});
	return running;
}

function makeManager(port: number, onTaskDone?: (frame: { taskId: string }) => void): FleetManager {
	const manager = new FleetManager({
		registryUrl: "http://registry.test.local",
		connectAgent: (host) => AgentClient.connect(host, port),
		...(onTaskDone ? { onTaskDone } : {}),
	});
	managers.push(manager);
	return manager;
}

async function poll(condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	const start = Date.now();
	while (!(await condition())) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
}

describe("durable task_done", () => {
	it("emits task_done for tracked prompts, acks delete the outbox entry", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const agent = await startAgent(outboxDir);
		const received: Array<{ taskId: string }> = [];
		const manager = makeManager(agent.port, (frame) => received.push(frame));

		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.prompt(tracked.instanceId, "fix it", "t-abc");

		await poll(() => received.length === 1);
		expect(received[0]?.taskId).toBe("t-abc");
		expect(manager.get(tracked.instanceId)?.review).toBe("awaiting");

		// Ack is automatic; outbox drains.
		await poll(async () => (await readdir(outboxDir)).length === 0);
	});

	it("untracked prompts (no taskId) emit no task_done", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const agent = await startAgent(outboxDir);
		const received: unknown[] = [];
		const manager = makeManager(agent.port, (frame) => received.push(frame));
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.prompt(tracked.instanceId, "quick thing");
		await manager.waitSettled(tracked.instanceId, 8_000);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
		expect(received).toHaveLength(0);
	});

	it("AC-3.5: task_done survives server absence and is replayed on reconnect, deduped", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const agent = await startAgent(outboxDir);

		// First manager: spawn + tracked prompt, then disconnect BEFORE settle.
		const first = makeManager(agent.port);
		const tracked = await first.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await first.prompt(tracked.instanceId, "long job", "t-offline");
		await first.close();

		// Worker settles with no server connected → outbox holds the entry.
		await poll(async () => (await readdir(outboxDir)).length === 1);

		// Second manager (server restart): replay delivers exactly once.
		const received: Array<{ taskId: string }> = [];
		const second = makeManager(agent.port, (frame) => received.push(frame));
		await second.agent("127.0.0.1");
		await poll(() => received.length >= 1);
		expect(received[0]?.taskId).toBe("t-offline");

		// Ack drains the outbox; a reconnect replays nothing new.
		await poll(async () => (await readdir(outboxDir)).length === 0);
		expect(received).toHaveLength(1);
	});
});

describe("AC-3.12 budget enforcement", () => {
	it("aborts on cost breach and reports task_done budget_exceeded", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		// Worker: each prompt emits a $2 message_end without settling; abort settles it.
		const dir = await mkdtemp(join(tmpdir(), "pf-budget-worker-"));
		const workerPath = join(dir, "worker.mjs");
		await writeFile(
			workerPath,
			`
let buffer = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		if (cmd.type === "prompt") {
			setTimeout(() => send({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 2 } }, content: [{ type: "text", text: "spending..." }] } }), 50);
			setTimeout(() => send({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 2 } }, content: [{ type: "text", text: "more spending" }] } }), 120);
		} else if (cmd.type === "abort") {
			send({ type: "agent_settled" });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
			"utf8",
		);
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
			whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
			outboxDir,
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		const received: Array<{ taskId: string; status?: string }> = [];
		const manager = makeManager(running.port, (frame) => received.push(frame as { taskId: string; status?: string }));
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default", maxCost: 3 });
		await manager.prompt(tracked.instanceId, "burn tokens", "t-budget");
		await poll(() => received.length === 1, 10_000);
		expect(received[0]?.taskId).toBe("t-budget");
		expect(received[0]?.status).toBe("budget_exceeded");
	});
});

describe("gap fix: worker crash mid-task", () => {
	it("emits task_done aborted so the orchestrator is never left waiting", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const dir = await mkdtemp(join(tmpdir(), "pf-crash-worker-"));
		const workerPath = join(dir, "worker.mjs");
		await writeFile(
			workerPath,
			`
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => setTimeout(() => process.exit(1), 60)); // crash on any command
setInterval(() => {}, 1000);
`,
			"utf8",
		);
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
			whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
			outboxDir,
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		const received: Array<{ taskId: string; status?: string }> = [];
		const manager = makeManager(running.port, (frame) => received.push(frame as { taskId: string; status?: string }));
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.prompt(tracked.instanceId, "doomed", "t-crash");
		await poll(() => received.length === 1, 10_000);
		expect(received[0]?.status).toBe("aborted");
	});
});

describe("gap fix: agent restart with previous-life instances", () => {
	it("reports lost instances with session paths and emits aborted task_done", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const instancesFile = join(await mkdtemp(join(tmpdir(), "pf-inst-")), "instances.json");
		await writeFile(
			instancesFile,
			JSON.stringify([
				{ instanceId: "i-old1", pid: 99999999, cwd: "/w", bundle: "default", taskId: "t-lost", sessionPath: "/s/old1.jsonl" },
				{ instanceId: "i-old2", cwd: "/w", bundle: "default", sessionPath: "/s/old2.jsonl" },
			]),
		);
		const workerPath = await makePromptWorker();
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
			whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
			outboxDir,
			instancesFile,
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		const received: Array<{ taskId: string; status?: string }> = [];
		const manager = makeManager(running.port, (frame) => received.push(frame as { taskId: string; status?: string }));
		const client = await (manager as unknown as { agent(host: string): Promise<import("../src/server/agent-client.ts").AgentClient> }).agent("127.0.0.1");

		await poll(() => received.length === 1);
		expect(received[0]).toMatchObject({ taskId: "t-lost", status: "aborted" });

		const listed = await client.list();
		const lost = listed.filter((entry) => entry.state === "lost");
		expect(lost.map((entry) => entry.instanceId).sort()).toEqual(["i-old1", "i-old2"]);
		expect(lost.find((entry) => entry.instanceId === "i-old1")?.sessionPath).toBe("/s/old1.jsonl");
	});
});

describe("gap fix: task ownership delivery", () => {
	it("delivers task_done only to the submitting connection while it lives", async () => {
		const outboxDir = await mkdtemp(join(tmpdir(), "pf-outbox-"));
		const workerPath = await makePromptWorker();
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
			whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
			outboxDir,
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		const gotA: string[] = [];
		const gotB: string[] = [];
		const managerA = makeManager(running.port, (frame) => gotA.push(frame.taskId));
		const managerB = makeManager(running.port, (frame) => gotB.push(frame.taskId));
		await managerB.agent("127.0.0.1"); // second orchestrator connected

		const tracked = await managerA.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await managerA.prompt(tracked.instanceId, "job", "t-owned");
		await poll(() => gotA.length === 1);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
		expect(gotA).toEqual(["t-owned"]);
		expect(gotB).toEqual([]); // no double-review
	});
});
