/**
 * Read-only file service answered by the agent (docs/plan.md "Remote file
 * access"): reviews cost zero worker tokens and never touch the worker's
 * session. Paths resolve inside the instance cwd via realpath containment
 * (AC-3.4a); there is deliberately no write operation.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { resolveWithin } from "../core/pathsafety.ts";
import type { FrameOf } from "../core/frames.ts";

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_TEXT_LINES = 2000;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set([".git", "node_modules", ".fleet-worktrees"]);

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

type FsResultPayload = Omit<FrameOf<"fs_result">, "v" | "type" | "id" | "traceId">;

function failure(code: string, message: string): FsResultPayload {
	return { done: true, error: { code, message } };
}

export async function fsRead(
	cwd: string,
	path: string,
	options: { offset?: number; limit?: number } = {},
): Promise<FsResultPayload> {
	let resolved: string;
	try {
		resolved = await resolveWithin(cwd, path);
	} catch (error) {
		return failure("path_escape", error instanceof Error ? error.message : String(error));
	}

	let info;
	try {
		info = await stat(resolved);
	} catch {
		return failure("not_found", `no such file: ${path}`);
	}
	if (!info.isFile()) return failure("not_a_file", path);

	const mime = IMAGE_MIME[extname(resolved).toLowerCase()];
	if (mime) {
		if (info.size > MAX_BINARY_BYTES) {
			return failure("too_large", `${path} is ${info.size} bytes (cap ${MAX_BINARY_BYTES})`);
		}
		const content = await readFile(resolved);
		return { done: true, base64: content.toString("base64"), mime };
	}

	const content = await readFile(resolved, "utf8");
	const lines = content.split("\n");
	const offset = Math.max(0, options.offset ?? 0);
	const limit = options.limit ?? MAX_TEXT_LINES;
	let selected = lines.slice(offset, offset + Math.min(limit, MAX_TEXT_LINES));
	let text = selected.join("\n");
	let truncated = offset + selected.length < lines.length;
	if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
		text = Buffer.from(text, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
		truncated = true;
	}
	return { done: true, text, ...(truncated ? { truncated: true } : {}) };
}

export async function fsList(cwd: string, path: string): Promise<FsResultPayload> {
	let resolved: string;
	try {
		resolved = await resolveWithin(cwd, path);
	} catch (error) {
		return failure("path_escape", error instanceof Error ? error.message : String(error));
	}
	let entries;
	try {
		entries = await readdir(resolved, { withFileTypes: true });
	} catch {
		return failure("not_found", `no such directory: ${path}`);
	}
	const listed = await Promise.all(
		entries.map(async (entry) => {
			const kind = entry.isDirectory() ? ("dir" as const) : ("file" as const);
			let bytes: number | undefined;
			if (kind === "file") {
				try {
					bytes = (await stat(join(resolved, entry.name))).size;
				} catch {
					// unreadable entry; report without size
				}
			}
			return { name: entry.name, kind, ...(bytes !== undefined ? { bytes } : {}) };
		}),
	);
	return { done: true, entries: listed };
}

export async function fsGrep(cwd: string, pattern: string, glob?: string): Promise<FsResultPayload> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (error) {
		return failure("bad_pattern", error instanceof Error ? error.message : String(error));
	}
	const globRegex = glob ? globToRegExp(glob) : null;
	const matches: string[] = [];

	async function walk(dir: string): Promise<void> {
		if (matches.length >= MAX_GREP_MATCHES) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (matches.length >= MAX_GREP_MATCHES) return;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = relative(cwd, full).split("\\").join("/");
			if (globRegex && !globRegex.test(rel)) continue;
			let info;
			try {
				info = await stat(full);
			} catch {
				continue;
			}
			if (info.size > 1024 * 1024) continue;
			let content: string;
			try {
				content = await readFile(full, "utf8");
			} catch {
				continue;
			}
			if (content.includes("\u0000")) continue;
			const lines = content.split("\n");
			for (let index = 0; index < lines.length && matches.length < MAX_GREP_MATCHES; index += 1) {
				const line = lines[index] ?? "";
				if (regex.test(line)) matches.push(`${rel}:${index + 1}:${line.slice(0, 300)}`);
			}
		}
	}

	await walk(cwd);
	return {
		done: true,
		text: matches.join("\n"),
		...(matches.length >= MAX_GREP_MATCHES ? { truncated: true } : {}),
	};
}

export async function fsDiff(
	cwd: string,
	options: { ref?: string; staged?: boolean; stat?: boolean } = {},
): Promise<FsResultPayload> {
	const args = ["diff"];
	if (options.staged) args.push("--staged");
	if (options.stat) args.push("--stat");
	if (options.ref) args.push(options.ref);
	const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise) => {
		execFile(
			"git",
			args,
			{ cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: error ? 1 : 0 });
			},
		);
	});
	if (result.code !== 0) return failure("git_failed", result.stderr.trim() || "git diff failed");
	let text = result.stdout;
	let truncated = false;
	if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
		text = Buffer.from(text, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
		truncated = true;
	}
	return { done: true, text, ...(truncated ? { truncated: true } : {}) };
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
				index += glob[index + 2] === "/" ? 2 : 1;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += (char ?? "").replace(/[.+^${}()|[\]\\]/, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}
