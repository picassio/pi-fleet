/**
 * Agent-side pi session search (AC-3.5.5): greps JSONL session files locally;
 * only matching refs + snippets cross the wire.
 */
import { readdir, readFile, stat } from "node:fs/promises";
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
