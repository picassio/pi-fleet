import { randomBytes } from "node:crypto";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

const OUTPUT_CHUNK_BYTES = 48 * 1024;
const RECENT_LIMIT = 50;

export type ExecMode = "shell" | "argv";
export type ExecStream = "stdout" | "stderr";
export type ExecState = "running" | "exited";

export interface ExecRequest {
	mode: ExecMode;
	cwd: string;
	command?: string;
	executable?: string;
	args?: string[];
	timeoutSeconds?: number;
}

export interface ExecRecord {
	execId: string;
	owner: string;
	mode: ExecMode;
	cwd: string;
	command?: string;
	executable?: string;
	args?: string[];
	state: ExecState;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	aborted?: boolean;
	durationMs?: number;
}

export interface ExecSupervisorOptions {
	enabled?: boolean;
	roots?: string[];
	maxConcurrent?: number;
	defaultTimeoutSeconds?: number;
	maxTimeoutSeconds?: number;
	auditFile?: string;
	platform?: NodeJS.Platform;
	onOutput?: (execId: string, owner: string, seq: number, stream: ExecStream, data: Buffer) => void;
	onExit?: (record: ExecRecord) => void;
}

interface ManagedExec {
	record: ExecRecord;
	child: ChildProcessWithoutNullStreams;
	timer: NodeJS.Timeout;
	seq: number;
}

export class ExecSupervisor {
	private readonly active = new Map<string, ManagedExec>();
	private readonly recent: ExecRecord[] = [];
	private readonly options: ExecSupervisorOptions;

	constructor(options: ExecSupervisorOptions = {}) {
		this.options = options;
	}

	get enabled(): boolean {
		return this.options.enabled === true;
	}

	async start(request: ExecRequest, owner: string): Promise<ExecRecord> {
		if (!this.enabled) throw new Error("remote execution is disabled on this agent");
		if (this.active.size >= (this.options.maxConcurrent ?? 4)) {
			throw new Error(`execution capacity reached: ${this.active.size}/${this.options.maxConcurrent ?? 4}`);
		}
		this.validateRequest(request);
		const cwd = await realpath(request.cwd);
		await this.validateCwd(cwd);

		const platform = this.options.platform ?? process.platform;
		const command = this.resolveCommand(request, platform);
		const timeoutSeconds = Math.min(
			request.timeoutSeconds ?? this.options.defaultTimeoutSeconds ?? 300,
			this.options.maxTimeoutSeconds ?? 3600,
		);
		const execId = `x-${randomBytes(6).toString("hex")}`;
		const startedAt = Date.now();
		const record: ExecRecord = {
			execId,
			owner,
			mode: request.mode,
			cwd,
			...(request.command !== undefined ? { command: request.command } : {}),
			...(request.executable !== undefined ? { executable: request.executable } : {}),
			...(request.args !== undefined ? { args: [...request.args] } : {}),
			state: "running",
			startedAt,
		};
		await this.audit("start", record);
		const child = spawn(command.executable, command.args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: platform !== "win32",
		});
		child.stdin.end();
		const timer = setTimeout(() => {
			const managed = this.active.get(execId);
			if (!managed) return;
			managed.record.timedOut = true;
			void this.killTree(managed.child, platform);
		}, timeoutSeconds * 1000);
		timer.unref?.();
		const managed: ManagedExec = { record, child, timer, seq: 0 };
		this.active.set(execId, managed);
		this.emitChunks(managed, "stdout", child.stdout);
		this.emitChunks(managed, "stderr", child.stderr);
		child.once("error", (error) => {
			this.options.onOutput?.(execId, owner, managed.seq++, "stderr", Buffer.from(error.message, "utf8"));
			// ENOENT and other spawn errors do not emit `exit`; finish explicitly.
			this.finish(execId, null, null);
		});
		child.once("exit", (code, signal) => this.finish(execId, code, signal));
		return { ...record, ...(record.args ? { args: [...record.args] } : {}) };
	}

	list(): ExecRecord[] {
		return [
			...[...this.active.values()].map(({ record }) => ({ ...record, ...(record.args ? { args: [...record.args] } : {}) })),
			...this.recent.map((record) => ({ ...record, ...(record.args ? { args: [...record.args] } : {}) })),
		];
	}

	async abort(execId: string): Promise<boolean> {
		const managed = this.active.get(execId);
		if (!managed) return false;
		managed.record.aborted = true;
		await this.killTree(managed.child, this.options.platform ?? process.platform);
		return true;
	}

	async abortOwner(owner: string): Promise<void> {
		await Promise.all(
			[...this.active.values()]
				.filter(({ record }) => record.owner === owner)
				.map(({ record }) => this.abort(record.execId)),
		);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.active.keys()].map((execId) => this.abort(execId)));
	}

	private validateRequest(request: ExecRequest): void {
		if (!Number.isFinite(request.timeoutSeconds ?? 1) || (request.timeoutSeconds ?? 1) <= 0) {
			throw new Error("timeoutSeconds must be positive");
		}
		if (request.mode === "shell") {
			if (!request.command) throw new Error("shell execution requires command");
			return;
		}
		if (!request.executable) throw new Error("argv execution requires executable");
	}

	private async validateCwd(cwd: string): Promise<void> {
		const roots = this.options.roots;
		if (!roots || roots.length === 0) return;
		for (const configured of roots) {
			try {
				const root = await realpath(configured);
				const rel = relative(root, cwd);
				if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
			} catch {
				// A missing configured root must not hide a later valid root.
			}
		}
		throw new Error(`cwd is outside configured exec roots: ${cwd}`);
	}

	private resolveCommand(request: ExecRequest, platform: NodeJS.Platform): { executable: string; args: string[] } {
		if (request.mode === "argv") return { executable: request.executable as string, args: request.args ?? [] };
		if (platform === "win32") {
			return {
				executable: "powershell.exe",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command as string],
			};
		}
		return { executable: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-lc", request.command as string] };
	}

	private emitChunks(managed: ManagedExec, stream: ExecStream, readable: NodeJS.ReadableStream): void {
		readable.on("data", (value: Buffer | string) => {
			const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
			for (let offset = 0; offset < data.byteLength; offset += OUTPUT_CHUNK_BYTES) {
				this.options.onOutput?.(
					managed.record.execId,
					managed.record.owner,
					managed.seq++,
					stream,
					data.subarray(offset, offset + OUTPUT_CHUNK_BYTES),
				);
			}
		});
	}

	private finish(execId: string, code: number | null, signal: NodeJS.Signals | null): void {
		const managed = this.active.get(execId);
		if (!managed) return;
		clearTimeout(managed.timer);
		this.active.delete(execId);
		managed.record.state = "exited";
		managed.record.finishedAt = Date.now();
		managed.record.exitCode = code;
		managed.record.signal = signal;
		managed.record.timedOut ??= false;
		managed.record.aborted ??= false;
		managed.record.durationMs = managed.record.finishedAt - managed.record.startedAt;
		this.recent.unshift(managed.record);
		if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
		void this.audit("exit", managed.record).catch(() => {});
		this.options.onExit?.({ ...managed.record, ...(managed.record.args ? { args: [...managed.record.args] } : {}) });
	}

	private async killTree(child: ChildProcessWithoutNullStreams, platform: NodeJS.Platform): Promise<void> {
		if (child.pid === undefined) return;
		if (platform === "win32") {
			await new Promise<void>((resolvePromise) => {
				execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => resolvePromise());
			});
			return;
		}
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill();
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
		if (child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
	}

	private async audit(event: "start" | "exit", record: ExecRecord): Promise<void> {
		const path = this.options.auditFile ?? join(homedir(), ".pi", "agent", "fleet-agent", "exec-audit.jsonl");
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...record })}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
}
