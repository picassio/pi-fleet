/**
 * Disk-backed task_done outbox (docs/plan.md "Task completion & verification"
 * step 2): entries survive agent restarts and server downtime, are replayed
 * on every new server connection, and are deleted only on task_done_ack.
 * At-least-once delivery; the server dedupes by (instanceId, taskId, seq).
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FrameOf } from "../core/frames.ts";

export type TaskDoneFrame = FrameOf<"task_done">;

export class TaskOutbox {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private fileFor(taskId: string, seq: number): string {
		return join(this.dir, `${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${seq}.json`);
	}

	async put(frame: TaskDoneFrame): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await writeFile(this.fileFor(frame.taskId, frame.seq), JSON.stringify(frame), "utf8");
	}

	async ack(taskId: string, seq: number): Promise<void> {
		await rm(this.fileFor(taskId, seq), { force: true });
	}

	async pending(): Promise<TaskDoneFrame[]> {
		let files: string[];
		try {
			files = await readdir(this.dir);
		} catch {
			return [];
		}
		const frames: TaskDoneFrame[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				frames.push(JSON.parse(await readFile(join(this.dir, file), "utf8")) as TaskDoneFrame);
			} catch {
				// corrupt entry: skip, never crash replay
			}
		}
		return frames.sort((a, b) => a.seq - b.seq);
	}
}
