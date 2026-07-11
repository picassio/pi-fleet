/**
 * Worker instance supervisor: spawns and manages `pi --mode rpc` children.
 *
 * - stdout JSONL lines are forwarded as pi events (tagged with instanceId)
 * - stdin carries pi RPC commands
 * - graceful stop = RPC abort + stdin end; kill only after a timeout (AC-2.7)
 *
 * The spawn command is injectable so tests supervise a fake worker script
 * instead of real pi.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiRpcInvocation, resolvePiCommand } from "../core/spawn.ts";

/** The fleet extension entry the agent injects into every worker via `-e`. */
export function fleetExtensionEntry(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
}

export interface SpawnRequest {
	cwd: string;
	bundle: string;
	bundleHash?: string;
	env?: Record<string, string>;
	traceId?: string;
}

export interface InstanceRecord {
	instanceId: string;
	pid: number | undefined;
	cwd: string;
	bundle: string;
	state: "running" | "stopped" | "exited";
	traceId?: string;
	sessionPath?: string;
}

export interface SupervisorOptions {
	/** Resolve the worker command; defaults to real pi. */
	resolveCommand?: () => Promise<{ command: string; args: string[] }>;
	/** Grace window before SIGKILL on stop (ms). */
	stopGraceMs?: number;
	onEvent?: (instanceId: string, event: unknown) => void;
	onExit?: (instanceId: string, code: number | null) => void;
}

interface Managed {
	record: InstanceRecord;
	child: ChildProcessWithoutNullStreams;
	stdoutBuffer: string;
	stderrTail: string;
}

export class InstanceSupervisor {
	private readonly instances = new Map<string, Managed>();
	private readonly options: SupervisorOptions;

	constructor(options: SupervisorOptions = {}) {
		this.options = options;
	}

	async spawn(request: SpawnRequest): Promise<InstanceRecord> {
		const resolve =
			this.options.resolveCommand ??
			(async () => {
				const resolved = await resolvePiCommand();
				// Workers need no pi-fleet install: the agent injects its own copy.
				return buildPiRpcInvocation(resolved, ["-e", fleetExtensionEntry()]);
			});
		const { command, args } = await resolve();
		const instanceId = `i-${randomBytes(6).toString("hex")}`;

		const child = spawn(command, args, {
			cwd: request.cwd,
			env: {
				...process.env,
				...request.env,
				PI_FLEET_BUNDLE: request.bundle,
				...(request.bundleHash ? { PI_FLEET_BUNDLE_HASH: request.bundleHash } : {}),
				PI_FLEET_INSTANCE_ID: instanceId,
				...(request.traceId ? { PI_FLEET_TRACE_ID: request.traceId } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const record: InstanceRecord = {
			instanceId,
			pid: child.pid,
			cwd: request.cwd,
			bundle: request.bundle,
			state: "running",
			...(request.traceId ? { traceId: request.traceId } : {}),
		};
		const managed: Managed = { record, child, stdoutBuffer: "", stderrTail: "" };
		this.instances.set(instanceId, managed);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			managed.stdoutBuffer += chunk;
			for (;;) {
				const newline = managed.stdoutBuffer.indexOf("\n");
				if (newline === -1) return;
				let line = managed.stdoutBuffer.slice(0, newline);
				managed.stdoutBuffer = managed.stdoutBuffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length === 0) continue;
				try {
					this.options.onEvent?.(instanceId, JSON.parse(line));
				} catch {
					// Non-JSON worker output is dropped (worker logs go to stderr).
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			// Keep the last 4KB so crashes are diagnosable (perf audit fix).
			managed.stderrTail = (managed.stderrTail + chunk).slice(-4096);
		});
		child.on("exit", (code) => {
			record.state = record.state === "stopped" ? "stopped" : "exited";
			record.pid = undefined;
			this.options.onExit?.(instanceId, code);
		});

		// Wait for spawn confirmation or immediate failure.
		await new Promise<void>((resolvePromise, rejectPromise) => {
			child.once("spawn", () => resolvePromise());
			child.once("error", (error) => {
				this.instances.delete(instanceId);
				rejectPromise(error);
			});
		});
		return record;
	}

	writeRpc(instanceId: string, command: unknown): boolean {
		const managed = this.instances.get(instanceId);
		if (!managed || managed.record.state !== "running") return false;
		managed.child.stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	}

	/** Graceful stop: RPC abort, end stdin, kill after the grace window. */
	async stop(instanceId: string): Promise<{ forced: boolean } | null> {
		const managed = this.instances.get(instanceId);
		if (!managed) return null;
		if (managed.record.state !== "running") return { forced: false };

		managed.record.state = "stopped";
		const { child } = managed;
		try {
			child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
			child.stdin.end();
		} catch {
			// stdin may already be closed
		}

		const graceMs = this.options.stopGraceMs ?? 5_000;
		const exited = await new Promise<boolean>((resolvePromise) => {
			if (child.exitCode !== null) return resolvePromise(true);
			const timer = setTimeout(() => resolvePromise(false), graceMs);
			child.once("exit", () => {
				clearTimeout(timer);
				resolvePromise(true);
			});
		});
		if (!exited) child.kill();
		return { forced: !exited };
	}

	list(): InstanceRecord[] {
		return [...this.instances.values()].map((managed) => ({ ...managed.record }));
	}

	get(instanceId: string): InstanceRecord | undefined {
		const managed = this.instances.get(instanceId);
		return managed ? { ...managed.record } : undefined;
	}

	stderrTail(instanceId: string): string {
		return this.instances.get(instanceId)?.stderrTail ?? "";
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
	}
}
