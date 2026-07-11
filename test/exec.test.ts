import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecSupervisor, type ExecRecord } from "../src/agent/exec.ts";
import { startAgentDaemon, type RunningAgent } from "../src/agent/daemon.ts";
import { AgentClient } from "../src/server/agent-client.ts";

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for value");
		await delay(20);
	}
}

function nodeSleepArgs(ms: number): string[] {
	return ["-e", `setTimeout(() => {}, ${ms})`];
}

describe("direct execution supervisor", () => {
	it("is disabled by default", async () => {
		const supervisor = new ExecSupervisor();
		await expect(supervisor.start({ mode: "argv", cwd: tmpdir(), executable: process.execPath }, "owner"))
			.rejects.toThrow(/disabled/);
	});

	it("preserves argv exactly and separates stdout/stderr", async () => {
		const chunks: Array<{ stream: string; data: string }> = [];
		let exited: ExecRecord | undefined;
		const auditFile = join(await mkdtemp(join(tmpdir(), "pf-exec-")), "audit.jsonl");
		const supervisor = new ExecSupervisor({
			enabled: true,
			auditFile,
			onOutput: (_id, _owner, _seq, stream, data) => chunks.push({ stream, data: data.toString() }),
			onExit: (record) => { exited = record; },
		});
		const record = await supervisor.start({
			mode: "argv",
			cwd: tmpdir(),
			executable: process.execPath,
			args: ["-e", "console.log(JSON.stringify(process.argv.slice(1))); console.error('problem')", "a b", "$HOME"],
		}, "server-user");
		const result = await waitFor(() => exited);
		expect(result.execId).toBe(record.execId);
		expect(result.exitCode).toBe(0);
		expect(chunks.filter((entry) => entry.stream === "stdout").map((entry) => entry.data).join(""))
			.toContain('["a b","$HOME"]');
		expect(chunks.filter((entry) => entry.stream === "stderr").map((entry) => entry.data).join(""))
			.toContain("problem");
		await delay(100);
		const audit = await readFile(auditFile, "utf8");
		expect(audit).toContain('"event":"start"');
		expect(audit).toContain('"event":"exit"');
		expect(audit).not.toContain('"stdout"');
		expect(audit).not.toContain('"stderr"');
	});

	it("bounds wire chunks and completes missing-executable failures", async () => {
		const sizes: number[] = [];
		let exits: ExecRecord[] = [];
		const supervisor = new ExecSupervisor({
			enabled: true,
			auditFile: join(tmpdir(), `pf-audit-${Date.now()}-chunks.jsonl`),
			onOutput: (_id, _owner, _seq, _stream, data) => sizes.push(data.byteLength),
			onExit: (record) => { exits = [...exits, record]; },
		});
		const large = await supervisor.start({ mode: "argv", cwd: tmpdir(), executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(150000))"] }, "owner");
		expect((await waitFor(() => exits.find((entry) => entry.execId === large.execId))).exitCode).toBe(0);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(48 * 1024);

		const missing = await supervisor.start({ mode: "argv", cwd: tmpdir(), executable: `definitely-missing-${Date.now()}` }, "owner");
		const failed = await waitFor(() => exits.find((entry) => entry.execId === missing.execId));
		expect(failed.exitCode).toBeNull();
		expect(supervisor.list().find((entry) => entry.execId === missing.execId)?.state).toBe("exited");
	});

	it("runs the native shell and reports a nonzero exit", async () => {
		let output = "";
		let exited: ExecRecord | undefined;
		const supervisor = new ExecSupervisor({
			enabled: true,
			auditFile: join(tmpdir(), `pf-audit-${Date.now()}.jsonl`),
			onOutput: (_id, _owner, _seq, _stream, data) => { output += data.toString(); },
			onExit: (record) => { exited = record; },
		});
		const command = process.platform === "win32" ? "Write-Output fleet-shell; exit 7" : "printf fleet-shell; exit 7";
		await supervisor.start({ mode: "shell", cwd: tmpdir(), command }, "owner");
		const result = await waitFor(() => exited);
		expect(output).toContain("fleet-shell");
		expect(result.exitCode).toBe(7);
	});

	it("enforces cwd roots, timeout, abort, and concurrency", async () => {
		const root = await mkdtemp(join(tmpdir(), "pf-root-"));
		const outside = await mkdtemp(join(tmpdir(), "pf-outside-"));
		const exits: ExecRecord[] = [];
		const supervisor = new ExecSupervisor({
			enabled: true,
			roots: [root],
			maxConcurrent: 1,
			defaultTimeoutSeconds: 0.1,
			auditFile: join(root, "audit.jsonl"),
			onExit: (record) => exits.push(record),
		});
		await expect(supervisor.start({ mode: "argv", cwd: outside, executable: process.execPath }, "owner"))
			.rejects.toThrow(/outside configured exec roots/);
		const first = await supervisor.start({ mode: "argv", cwd: root, executable: process.execPath, args: nodeSleepArgs(10_000) }, "owner");
		await expect(supervisor.start({ mode: "argv", cwd: root, executable: process.execPath }, "owner"))
			.rejects.toThrow(/capacity/);
		const timedOut = await waitFor(() => exits.find((entry) => entry.execId === first.execId), 8_000);
		expect(timedOut.timedOut).toBe(true);

		const second = await supervisor.start({ mode: "argv", cwd: root, executable: process.execPath, args: nodeSleepArgs(10_000), timeoutSeconds: 10 }, "owner");
		expect(await supervisor.abort(second.execId)).toBe(true);
		const aborted = await waitFor(() => exits.find((entry) => entry.execId === second.execId), 8_000);
		expect(aborted.aborted).toBe(true);
		expect((await realpath(root)).length).toBeGreaterThan(0);
	});
});

let running: RunningAgent | undefined;
let client: AgentClient | undefined;
afterEach(async () => {
	client?.close();
	client = undefined;
	await running?.close();
	running = undefined;
});

async function daemon(execEnabled: boolean): Promise<AgentClient> {
	const dir = await mkdtemp(join(tmpdir(), "pf-exec-daemon-"));
	running = await startAgentDaemon({
		host: "127.0.0.1",
		port: 0,
		machine: "buildbox",
		pinnedServer: "claude3-10",
		whois: async () => ({ machine: "claude3-10", user: "ana@github" }),
		instancesFile: join(dir, "instances.json"),
		outboxDir: join(dir, "outbox"),
		exec: { enabled: execEnabled, auditFile: join(dir, "audit.jsonl") },
	});
	client = await AgentClient.connect("127.0.0.1", running.port);
	return client;
}

describe("direct execution protocol", () => {
	it("advertises capability only when enabled and rejects disabled starts", async () => {
		const disabled = await daemon(false);
		expect((await disabled.hello()).capabilities).toBeUndefined();
		await expect(disabled.execStart({ mode: "argv", cwd: tmpdir(), executable: process.execPath }))
			.rejects.toThrow(/exec_disabled/);
	});

	it("aborts commands owned by a disconnected server", async () => {
		const enabled = await daemon(true);
		const started = await enabled.execStart({ mode: "argv", cwd: tmpdir(), executable: process.execPath, args: nodeSleepArgs(10_000) });
		enabled.close();
		client = undefined;
		const record = await waitFor(
			() => running?.execSupervisor.list().find((entry) => entry.execId === started.execId && entry.state === "exited"),
			8_000,
		);
		expect(record.aborted).toBe(true);
	});

	it("streams output, exits, lists, and aborts over AgentClient", async () => {
		const enabled = await daemon(true);
		expect((await enabled.hello()).capabilities).toContain("exec-v1");
		const output: string[] = [];
		const exits: ExecRecord[] = [];
		enabled.onExecOutput((frame) => output.push(Buffer.from(frame.base64, "base64").toString()));
		enabled.onExecExit((frame) => exits.push({ ...frame, owner: "", mode: "argv", cwd: "", state: "exited", startedAt: 0 }));
		const started = await enabled.execStart({
			mode: "argv",
			cwd: tmpdir(),
			executable: process.execPath,
			args: ["-e", "console.log('over-wire')"],
		});
		const exited = await waitFor(() => exits.find((entry) => entry.execId === started.execId));
		expect(exited.exitCode).toBe(0);
		expect(output.join("")).toContain("over-wire");
		expect((await enabled.execList()).find((entry) => entry.execId === started.execId)?.state).toBe("exited");

		const long = await enabled.execStart({ mode: "argv", cwd: tmpdir(), executable: process.execPath, args: nodeSleepArgs(10_000) });
		await enabled.execAbort(long.execId);
		expect((await waitFor(() => exits.find((entry) => entry.execId === long.execId), 8_000)).aborted).toBe(true);
	});
});
