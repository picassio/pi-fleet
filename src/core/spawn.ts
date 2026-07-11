/**
 * Cross-platform `pi` process spawning.
 *
 * npm installs `pi` as `pi.cmd` on Windows, and modern Node refuses to spawn
 * `.cmd` files without a shell. We resolve the real command with `where` and
 * spawn `cmd.exe /c <path> ...` with argument arrays — never shell-interpolated
 * strings. See docs/plan.md (Cross-platform commitments).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface ResolvedCommand {
	command: string;
	/** Args to prepend before pi's own arguments. */
	prefixArgs: string[];
}

export type LookupFn = (executable: string) => Promise<string[]>;

export class PiNotFoundError extends Error {
	constructor(detail: string) {
		super(`pi executable not found: ${detail}`);
		this.name = "PiNotFoundError";
	}
}

/**
 * Resolve how to invoke pi on this platform.
 *
 * - POSIX: `pi` from PATH.
 * - Windows: `where pi` → prefer `.exe`, then `.cmd`/`.bat` via `cmd.exe /c`.
 */
export async function resolvePiCommand(options: {
	platform?: NodeJS.Platform;
	lookup?: LookupFn;
} = {}): Promise<ResolvedCommand> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		// PATH first; services (systemd/launchd) often lack the user shell PATH,
		// so fall back to node's own bin dir where npm -g installs pi.
		const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
		for (const dir of pathDirs) {
			if (existsSync(join(dir, "pi"))) return { command: join(dir, "pi"), prefixArgs: [] };
		}
		const sibling = join(dirname(process.execPath), "pi");
		if (existsSync(sibling)) return { command: sibling, prefixArgs: [] };
		return { command: "pi", prefixArgs: [] };
	}

	const lookup = options.lookup ?? defaultWindowsLookup;
	const candidates = (await lookup("pi")).map((line) => line.trim()).filter((line) => line.length > 0);
	if (candidates.length === 0) throw new PiNotFoundError("`where pi` returned no results");

	const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
	if (exe) return { command: exe, prefixArgs: [] };

	const script = candidates.find(
		(c) => c.toLowerCase().endsWith(".cmd") || c.toLowerCase().endsWith(".bat"),
	);
	if (script) return { command: "cmd.exe", prefixArgs: ["/c", script] };

	throw new PiNotFoundError(`no usable candidate in: ${candidates.join(", ")}`);
}

/** Build the full argv for a worker: `pi --mode rpc [...extra]`. */
export function buildPiRpcInvocation(
	resolved: ResolvedCommand,
	extraArgs: readonly string[] = [],
): { command: string; args: string[] } {
	return {
		command: resolved.command,
		args: [...resolved.prefixArgs, "--mode", "rpc", ...extraArgs],
	};
}

function defaultWindowsLookup(executable: string): Promise<string[]> {
	return new Promise((resolvePromise) => {
		execFile("where", [executable], { windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? [] : stdout.split(/\r?\n/));
		});
	});
}
