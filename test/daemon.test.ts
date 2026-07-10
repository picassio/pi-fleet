/**
 * Loopback control-plane tests: AC-2.2/2.2a (whois gate + pinning),
 * AC-2.3 (spawn round-trip), AC-2.4 (RPC forwarding, ordered, tagged),
 * AC-2.5 (heartbeat expiry), AC-2.7 (graceful stop).
 *
 * Workers are a fake node script speaking minimal pi RPC — no real pi,
 * no LLM, no tokens.
 */
import { connect } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { AgentClient } from "../src/server/agent-client.ts";
import type { TailscaleIdentity } from "../src/core/tailscale.ts";

const SERVER_IDENTITY: TailscaleIdentity = { machine: "claude3-10", user: "ana@github" };

async function makeFakeWorker(behavior: "normal" | "ignore-abort" = "normal"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pf-fake-worker-"));
	const path = join(dir, "worker.mjs");
	await writeFile(
		path,
		`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdout.write(JSON.stringify({ type: "worker_ready", bundle: process.env.PI_FLEET_BUNDLE ?? null, instanceId: process.env.PI_FLEET_INSTANCE_ID ?? null }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		if (cmd.type === "abort" && ${JSON.stringify(behavior)} === "ignore-abort") continue;
		process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, id: cmd.id ?? null, success: true }) + "\\n");
	}
});
process.stdin.on("end", () => { if (${JSON.stringify(behavior)} !== "ignore-abort") process.exit(0); });
setInterval(() => {}, 1000);
`,
		"utf8",
	);
	return path;
}

let running: RunningAgent | undefined;
let client: AgentClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await running?.close();
	running = undefined;
});

async function startAgent(options: {
	whoisIdentity?: TailscaleIdentity | "fail";
	workerBehavior?: "normal" | "ignore-abort";
	stopGraceMs?: number;
	heartbeatTimeoutMs?: number;
} = {}): Promise<RunningAgent> {
	const workerPath = await makeFakeWorker(options.workerBehavior ?? "normal");
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		whois: async () => {
			if (options.whoisIdentity === "fail") throw new Error("whois unavailable");
			return options.whoisIdentity ?? SERVER_IDENTITY;
		},
		supervisor: {
			resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }),
			stopGraceMs: options.stopGraceMs ?? 3_000,
		},
		...(options.heartbeatTimeoutMs !== undefined
			? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
			: {}),
	});
	return running;
}

describe("AC-2.2a whois gate and server pinning", () => {
	it("accepts the pinned server and sends hello", async () => {
		const agent = await startAgent();
		client = await AgentClient.connect("127.0.0.1", agent.port);
		const hello = await client.hello();
		expect(hello.machine).toBe("buildbox");
		expect(hello.role).toBe("agent");
	});

	it("refuses a non-pinned machine without prompting", async () => {
		const agent = await startAgent({ whoisIdentity: { machine: "intruder", user: "eve@x" } });
		const socket = connect(agent.port, "127.0.0.1");
		const closed = await new Promise<boolean>((resolvePromise) => {
			socket.once("close", () => resolvePromise(true));
			socket.once("data", () => resolvePromise(false));
			setTimeout(() => resolvePromise(false), 3_000);
		});
		expect(closed).toBe(true);
	});

	it("refuses when whois fails (deny-by-default)", async () => {
		const agent = await startAgent({ whoisIdentity: "fail" });
		const socket = connect(agent.port, "127.0.0.1");
		const closed = await new Promise<boolean>((resolvePromise) => {
			socket.once("close", () => resolvePromise(true));
			socket.once("data", () => resolvePromise(false));
			setTimeout(() => resolvePromise(false), 3_000);
		});
		expect(closed).toBe(true);
	});
});

describe("AC-2.3 spawn round-trip / AC-2.4 RPC forwarding", () => {
	it("spawns, lists, forwards RPC, and streams tagged events in order", async () => {
		const agent = await startAgent();
		client = await AgentClient.connect("127.0.0.1", agent.port);

		const events: Array<{ instanceId: string; event: { type?: string } }> = [];
		client.onEvent((instanceId, event) => events.push({ instanceId, event: event as { type?: string } }));

		const instance = await client.spawn({
			cwd: tmpdir(),
			bundle: "default",
			env: { PI_FLEET_SERVER: "http://registry.local" },
		});
		expect(instance.state).toBe("running");
		expect(instance.pid).toBeGreaterThan(0);

		const listed = await client.list();
		expect(listed.map((entry) => entry.instanceId)).toContain(instance.instanceId);

		// RPC forwarding: two commands, replies arrive tagged and in order.
		client.rpc(instance.instanceId, { type: "get_state", id: "a" });
		client.rpc(instance.instanceId, { type: "get_commands", id: "b" });
		await expectPoll(() => events.filter((entry) => (entry.event as { id?: string }).id).length >= 2);

		const tagged = events.filter((entry) => (entry.event as { id?: string }).id);
		expect(tagged.every((entry) => entry.instanceId === instance.instanceId)).toBe(true);
		expect(tagged.map((entry) => (entry.event as { id?: string }).id)).toEqual(["a", "b"]);

		// worker_ready event carried the injected env.
		const ready = events.find((entry) => entry.event.type === "worker_ready") as
			| { event: { bundle?: string; instanceId?: string } }
			| undefined;
		expect(ready?.event.bundle).toBe("default");
		expect(ready?.event.instanceId).toBe(instance.instanceId);
	});

	it("rpc to an unknown instance yields an error frame, not a crash", async () => {
		const agent = await startAgent();
		client = await AgentClient.connect("127.0.0.1", agent.port);
		await client.hello();
		await expect(client.stop("i-nope")).rejects.toThrow(/unknown_instance/);
	});
});

describe("AC-2.7 graceful stop", () => {
	it("stops a cooperative worker without force", async () => {
		const agent = await startAgent();
		client = await AgentClient.connect("127.0.0.1", agent.port);
		const instance = await client.spawn({ cwd: tmpdir(), bundle: "default" });
		const result = await client.stop(instance.instanceId);
		expect(result.forced).toBe(false);
		const listed = await client.list();
		expect(listed.find((entry) => entry.instanceId === instance.instanceId)?.state).toBe("stopped");
	});

	it("escalates to kill only after the grace window", async () => {
		const agent = await startAgent({ workerBehavior: "ignore-abort", stopGraceMs: 500 });
		client = await AgentClient.connect("127.0.0.1", agent.port);
		const instance = await client.spawn({ cwd: tmpdir(), bundle: "default" });
		const result = await client.stop(instance.instanceId);
		expect(result.forced).toBe(true);
	});
});

describe("AC-2.5 heartbeat expiry", () => {
	it("drops the connection when the peer goes silent; workers keep running", async () => {
		const agent = await startAgent({ heartbeatTimeoutMs: 600 });
		// Raw socket that never sends heartbeats.
		const socket = connect(agent.port, "127.0.0.1");
		await new Promise<void>((resolvePromise) => socket.once("data", () => resolvePromise()));

		// Spawn through a real client first so an instance exists.
		client = await AgentClient.connect("127.0.0.1", agent.port, { heartbeatIntervalMs: 200 });
		const instance = await client.spawn({ cwd: tmpdir(), bundle: "default" });

		const silentClosed = await new Promise<boolean>((resolvePromise) => {
			socket.once("close", () => resolvePromise(true));
			setTimeout(() => resolvePromise(false), 3_000);
		});
		expect(silentClosed).toBe(true);

		// The heartbeating client survives and the worker is still running.
		const listed = await client.list();
		expect(listed.find((entry) => entry.instanceId === instance.instanceId)?.state).toBe("running");
	});
});

async function expectPoll(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
}

describe("AC-3.14 maxWorkers", () => {
	it("refuses spawns beyond the cap with the current count, no process started", async () => {
		const workerPath = await makeFakeWorker();
		running = await startAgentDaemon({
			host: "127.0.0.1",
			port: 0,
			machine: "buildbox",
			pinnedServer: "claude3-10",
			maxWorkers: 1,
			whois: async () => SERVER_IDENTITY,
			supervisor: { resolveCommand: async () => ({ command: process.execPath, args: [workerPath] }) },
		});
		client = await AgentClient.connect("127.0.0.1", running.port);
		await client.spawn({ cwd: tmpdir(), bundle: "default" });
		await expect(client.spawn({ cwd: tmpdir(), bundle: "default" })).rejects.toThrow(/max_workers.*1\/1/);
		expect((await client.list()).filter((entry) => entry.state === "running")).toHaveLength(1);
	});
});
