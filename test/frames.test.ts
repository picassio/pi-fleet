import { describe, expect, it } from "vitest";
import {
	FrameDecoder,
	MAX_FRAME_BYTES,
	encodeFrame,
	parseFrame,
	type Frame,
} from "../src/core/frames.ts";

const samples: Frame[] = [
	{ v: 1, type: "hello", machine: "laptop", role: "server", packageVersion: "0.0.1", platform: "linux" },
	{ v: 1, type: "heartbeat" },
	{ v: 1, type: "error", code: "protocol", message: "bad frame" },
	{ v: 1, type: "spawn", cwd: "/home/ana/api", bundle: "default", traceId: "t-1" },
	{
		v: 1,
		type: "spawned",
		traceId: "t-1",
		instance: { instanceId: "i-1", cwd: "/home/ana/api", state: "provisioning" },
	},
	{ v: 1, type: "spawn_error", code: "no_usable_model", message: "tried anthropic, openai" },
	{ v: 1, type: "stop", instanceId: "i-1" },
	{ v: 1, type: "stopped", instanceId: "i-1", forced: false, sessionPath: "/s/x.jsonl" },
	{ v: 1, type: "list" },
	{ v: 1, type: "instances", instances: [] },
	{ v: 1, type: "rpc", instanceId: "i-1", command: { type: "prompt", message: "hi" } },
	{ v: 1, type: "event", instanceId: "i-1", event: { type: "agent_settled" } },
	{
		v: 1,
		type: "task_done",
		taskId: "t-42",
		instanceId: "i-1",
		seq: 3,
		status: "settled",
		summary: "fixed tests",
		stats: { turns: 7, cost: 0.42 },
	},
	{ v: 1, type: "task_done_ack", taskId: "t-42", seq: 3 },
	{ v: 1, type: "task_accept", taskId: "t-42", disposition: "stop", deliver: "branch" },
	{ v: 1, type: "task_reject", taskId: "t-42", feedback: "handle empty input" },
	{ v: 1, type: "deliver", taskId: "t-42", instanceId: "i-1", mode: "patch" },
	{ v: 1, type: "delivered", taskId: "t-42", mode: "branch", branch: "fleet/task-42" },
	{
		v: 1,
		type: "ui_request",
		instanceId: "i-1",
		requestId: "u-1",
		kind: "confirm",
		title: "Allow rm -rf?",
	},
	{ v: 1, type: "ui_response", instanceId: "i-1", requestId: "u-1", value: false, timedOut: true },
	{
		v: 1,
		type: "sessions_report",
		machine: "buildbox",
		full: true,
		sessions: [
			{
				sessionId: "s-1",
				path: "/s/baseline.jsonl",
				cwd: "/home/ana/api",
				kind: "baseline",
				pinned: true,
				updatedAt: 1770000000000,
			},
		],
	},
	{ v: 1, type: "session_search", query: "auth refactor" },
	{ v: 1, type: "session_hits", hits: [{ sessionId: "s-1", path: "/s/x.jsonl", snippet: "…auth…" }] },
	{ v: 1, type: "exec_start", mode: "shell", cwd: "/tmp", command: "uname -a", timeoutSeconds: 30 },
	{ v: 1, type: "exec_started", execId: "x-1", startedAt: 1770000000000 },
	{ v: 1, type: "exec_output", execId: "x-1", seq: 0, stream: "stdout", base64: "b2sK" },
	{ v: 1, type: "exec_exit", execId: "x-1", exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 10 },
	{ v: 1, type: "exec_abort", execId: "x-1" },
	{ v: 1, type: "exec_aborted", execId: "x-1" },
	{ v: 1, type: "exec_list" },
	{ v: 1, type: "exec_instances", executions: [{ execId: "x-1", mode: "shell", cwd: "/tmp", state: "exited", startedAt: 1, exitCode: 0 }] },
	{ v: 1, type: "fs_read", instanceId: "i-1", path: "src/index.ts", offset: 100, limit: 50 },
	{ v: 1, type: "fs_list", instanceId: "i-1", path: "src" },
	{ v: 1, type: "fs_grep", instanceId: "i-1", pattern: "TODO", glob: "**/*.ts" },
	{ v: 1, type: "fs_diff", instanceId: "i-1", stat: true },
	{
		v: 1,
		type: "fs_result",
		id: "r-1",
		done: true,
		entries: [{ name: "index.ts", kind: "file", bytes: 120 }],
	},
];

describe("AC-0.4 frame codec round-trip", () => {
	it("round-trips every v1 frame type", () => {
		const decoder = new FrameDecoder();
		for (const frame of samples) {
			const results = decoder.feed(encodeFrame(frame));
			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({ ok: true, frame });
		}
	});

	it("covers every declared frame type in the samples", () => {
		const seen = new Set(samples.map((s) => s.type));
		// spot check the full protocol surface
		for (const type of [
			"hello", "heartbeat", "error", "spawn", "spawned", "spawn_error", "stop", "stopped",
			"list", "instances", "rpc", "event", "task_done", "task_done_ack", "task_accept",
			"task_reject", "deliver", "delivered", "ui_request", "ui_response", "sessions_report",
			"session_search", "session_hits", "exec_start", "exec_started", "exec_output", "exec_exit",
			"exec_abort", "exec_aborted", "exec_list", "exec_instances", "fs_read", "fs_list", "fs_grep", "fs_diff", "fs_result",
		]) {
			expect(seen.has(type as Frame["type"]), type).toBe(true);
		}
	});
});

describe("AC-0.4 framing", () => {
	it("splits on \\n only and survives U+2028/U+2029 inside strings", () => {
		const frame: Frame = {
			v: 1,
			type: "error",
			code: "x",
			message: "line\u2028sep\u2029arators stay intact",
		};
		const decoder = new FrameDecoder();
		const results = decoder.feed(encodeFrame(frame));
		expect(results).toHaveLength(1);
		expect(results[0]?.ok && results[0].frame.type === "error" && results[0].frame.message).toBe(
			"line\u2028sep\u2029arators stay intact",
		);
	});

	it("handles chunked delivery across feed() calls", () => {
		const decoder = new FrameDecoder();
		const encoded = encodeFrame({ v: 1, type: "heartbeat" });
		const first = decoder.feed(encoded.subarray(0, 5));
		expect(first).toHaveLength(0);
		const rest = decoder.feed(encoded.subarray(5));
		expect(rest).toHaveLength(1);
		expect(rest[0]?.ok).toBe(true);
	});

	it("handles multiple records in one chunk and tolerates \\r\\n", () => {
		const decoder = new FrameDecoder();
		const chunk = `{"v":1,"type":"heartbeat"}\r\n{"v":1,"type":"list"}\n`;
		const results = decoder.feed(chunk);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
	});

	it("does not split multi-byte UTF-8 across chunk boundaries", () => {
		const frame: Frame = { v: 1, type: "error", code: "x", message: "héllo wörld ✓" };
		const encoded = encodeFrame(frame);
		const decoder = new FrameDecoder();
		const results: ReturnType<FrameDecoder["feed"]> = [];
		for (const byte of encoded) results.push(...decoder.feed(Buffer.from([byte])));
		expect(results).toHaveLength(1);
		expect(results[0]?.ok && results[0].frame.type === "error" && results[0].frame.message).toBe(
			"héllo wörld ✓",
		);
	});
});

describe("AC-0.4 / AC-X.5 rejection", () => {
	it("rejects invalid JSON without crashing and continues", () => {
		const decoder = new FrameDecoder();
		const results = decoder.feed('not json\n{"v":1,"type":"heartbeat"}\n');
		expect(results[0]?.ok).toBe(false);
		expect(!results[0]?.ok && results[0]?.error.code).toBe("invalid_json");
		expect(results[1]?.ok).toBe(true);
	});

	it("rejects unknown frame types", () => {
		const result = parseFrame({ v: 1, type: "teleport" });
		expect(!result.ok && result.error.code).toBe("unknown_frame_type");
	});

	it("AC-X.6: rejects unsupported protocol versions with a named error", () => {
		const result = parseFrame({ v: 2, type: "heartbeat" });
		expect(!result.ok && result.error.code).toBe("unsupported_version");
	});

	it("rejects schema violations naming frame type and path", () => {
		const result = parseFrame({ v: 1, type: "spawn", cwd: "/x" }); // missing bundle
		expect(!result.ok && result.error.code).toBe("schema_violation");
		expect(!result.ok && result.error.message).toContain("spawn");
	});

	it("rejects non-object records", () => {
		expect(!parseFrame([1, 2]).ok).toBe(true);
		expect(!parseFrame(null).ok).toBe(true);
		expect(!parseFrame("x").ok).toBe(true);
	});

	it("rejects oversized frames on encode", () => {
		const frame: Frame = { v: 1, type: "error", code: "x", message: "y".repeat(MAX_FRAME_BYTES) };
		expect(() => encodeFrame(frame)).toThrow(/frame too large/);
	});

	it("rejects oversized records on decode exactly once and recovers", () => {
		const decoder = new FrameDecoder();
		const big = Buffer.from(`{"pad":"${"y".repeat(MAX_FRAME_BYTES + 64)}"`, "utf8");
		const results: ReturnType<FrameDecoder["feed"]> = [];
		// Feed the oversized record in chunks (no newline yet).
		for (let i = 0; i < big.byteLength; i += 256 * 1024) {
			results.push(...decoder.feed(big.subarray(i, i + 256 * 1024)));
		}
		results.push(...decoder.feed('}\n{"v":1,"type":"heartbeat"}\n'));
		const errors = results.filter((r) => !r.ok);
		expect(errors).toHaveLength(1);
		expect(!errors[0]?.ok && errors[0]?.error.code).toBe("frame_too_large");
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});
});
