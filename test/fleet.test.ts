/**
 * FleetManager loopback tests (Phase 3): spawn → prompt → settle → result,
 * async prompt + output polling, abort/stop, status. Fake worker emits
 * pi-shaped events (message_end + agent_settled) — no real pi, no LLM.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { AgentClient } from "../src/server/agent-client.ts";
import { FleetManager } from "../src/server/fleet.ts";

async function makePromptWorker(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-prompt-worker-"));
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
			send({ type: "response", command: "prompt", success: true });
			setTimeout(() => {
				send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "work complete: " + cmd.message }] } });
				send({ type: "agent_settled" });
			}, 100);
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
	const workerPath = await makePromptWorker();
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		instancesFile: join(tmpdir(), `pf-if-${Math.random().toString(36).slice(2)}.json`),
		whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
		exec: { enabled: true, auditFile: join(tmpdir(), `pf-exec-audit-${Math.random().toString(36).slice(2)}.jsonl`) },
		supervisor: {
			resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }),
			stopGraceMs: 2_000,
		},
	});
	const port = running.port;
	fleet = new FleetManager({
		registryUrl: "http://registry.test.local",
		connectAgent: (host) => AgentClient.connect(host, port),
	});
	return fleet;
}

describe("Phase 3: FleetManager orchestration", () => {
	it("spawn → prompt → waitSettled returns the worker's final assistant message", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		expect(tracked.state).toBe("running");

		await manager.prompt(tracked.instanceId, "fix the tests");
		await manager.waitSettled(tracked.instanceId, 10_000);
		expect(manager.get(tracked.instanceId)?.lastAssistant).toBe("work complete: fix the tests");
		expect(manager.get(tracked.instanceId)?.settled).toBe(true);
	});

	it("async prompt: output shows busy then settled with recent event types", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		await manager.prompt(tracked.instanceId, "long task");
		expect(manager.output(tracked.instanceId).instance.settled).toBe(false);

		await manager.waitSettled(tracked.instanceId, 10_000);
		const output = manager.output(tracked.instanceId);
		expect(output.instance.settled).toBe(true);
		expect(output.recentEventTypes).toContain("message_end");
		expect(output.recentEventTypes).toContain("agent_settled");
	});

	it("two workers run in parallel and settle independently", async () => {
		const manager = await setup();
		const a = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		const b = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "other" });
		await manager.prompt(a.instanceId, "task A");
		await manager.prompt(b.instanceId, "task B");
		await Promise.all([
			manager.waitSettled(a.instanceId, 10_000),
			manager.waitSettled(b.instanceId, 10_000),
		]);
		expect(manager.get(a.instanceId)?.lastAssistant).toBe("work complete: task A");
		expect(manager.get(b.instanceId)?.lastAssistant).toBe("work complete: task B");
		expect(manager.status()).toHaveLength(2);
	});

	it("waitSettled times out when the worker never settles", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		// No prompt sent → never settles.
		await expect(manager.waitSettled(tracked.instanceId, 300)).rejects.toThrow(/did not settle/);
	});

	it("stop marks the instance stopped", async () => {
		const manager = await setup();
		const tracked = await manager.spawn({ host: "127.0.0.1", cwd: tmpdir(), bundle: "default" });
		const result = await manager.stop(tracked.instanceId);
		expect(result.forced).toBe(false);
		expect(manager.get(tracked.instanceId)?.state).toBe("stopped");
	});

	it("executes directly without spawning a worker and returns output", async () => {
		const manager = await setup();
		const execution = await manager.exec({
			host: "127.0.0.1",
			mode: "argv",
			cwd: tmpdir(),
			executable: process.execPath,
			args: ["-e", "console.log('direct-fleet')"],
		});
		const finished = await manager.waitExec(execution.execId, 10_000);
		expect(finished.exitCode).toBe(0);
		expect(finished.stdout.toString()).toContain("direct-fleet");
		expect(manager.status()).toHaveLength(0);
	});

	it("unknown instances raise clear errors", async () => {
		const manager = await setup();
		expect(() => manager.output("i-ghost")).toThrow(/unknown instance/);
		await expect(manager.prompt("i-ghost", "x")).rejects.toThrow(/unknown instance/);
	});
});
