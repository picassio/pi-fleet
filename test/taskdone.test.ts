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
