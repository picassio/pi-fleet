/**
 * Agent-side pi session search (AC-3.5.5): greps JSONL session files locally;
 * only matching refs + snippets cross the wire.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MAX_HITS = 30;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function searchSessions(
	root: string | undefined,
	query: string,
): Promise<Array<{ sessionId: string; path: string; snippet: string }>> {
	const base = root ?? join(homedir(), ".pi", "agent", "sessions");
	const hits: Array<{ sessionId: string; path: string; snippet: string }> = [];
	const needle = query.toLowerCase();

	async function walk(dir: string): Promise<void> {
		if (hits.length >= MAX_HITS) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (hits.length >= MAX_HITS) return;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					if ((await stat(full)).size > MAX_FILE_BYTES) continue;
					const content = await readFile(full, "utf8");
					const index = content.toLowerCase().indexOf(needle);
					if (index === -1) continue;
					hits.push({
						sessionId: basename(entry.name, ".jsonl"),
						path: full,
						snippet: content.slice(Math.max(0, index - 80), index + query.length + 80).replace(/\s+/g, " "),
					});
				} catch {
					// unreadable file: skip
				}
			}
		}
	}
	await walk(base);
	return hits;
}

export interface SessionListing {
	sessionId: string;
	path: string;
	name?: string;
	cwd: string;
	kind: "baseline" | "task" | "scratch";
	pinned: boolean;
	updatedAt: number;
}

/** Best-effort session inventory: JSONL headers parsed, never pi imports. */
export async function listSessions(root: string | undefined): Promise<SessionListing[]> {
	const base = root ?? join(homedir(), ".pi", "agent", "sessions");
	const sessions: SessionListing[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					const info = await stat(full);
					const handle = await open(full, "r");
					let head: string;
					try {
						const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
						head = buffer.subarray(0, bytesRead).toString("utf8");
					} finally {
						await handle.close();
					}
					const firstLine = head.split("\n", 1)[0] ?? "";
					const header = JSON.parse(firstLine) as { cwd?: string; name?: string };
					const name = typeof header.name === "string" ? header.name : undefined;
					sessions.push({
						sessionId: basename(entry.name, ".jsonl"),
						path: full,
						...(name ? { name } : {}),
						cwd: typeof header.cwd === "string" ? header.cwd : "(unknown)",
						kind: name?.startsWith("baseline:") ? "baseline" : name?.startsWith("task:") ? "task" : "scratch",
						pinned: name?.startsWith("baseline:") ?? false,
						updatedAt: info.mtimeMs,
					});
				} catch {
					// unparseable session: skip
				}
			}
		}
	}
	await walk(base);
	return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
