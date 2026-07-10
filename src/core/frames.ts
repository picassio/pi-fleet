/**
 * pi-fleet frame protocol v1.
 *
 * JSONL over TCP. Typebox schemas are the single source of truth: they
 * generate the TypeScript types AND validate every frame at the wire
 * boundary (AC-X.5). Strict `\n` delimiter, tolerate trailing `\r`,
 * never Node readline. See docs/plan.md (Frame protocol v1) and AC-0.4.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const base = {
	v: Type.Literal(PROTOCOL_VERSION),
	/** Request/response correlation id. */
	id: Type.Optional(Type.String()),
	/** Task-scoped trace id, minted at spawn (AC-X.4). */
	traceId: Type.Optional(Type.String()),
};

const Peer = Type.Object({
	machine: Type.String(),
	user: Type.String(),
});

const ModelRef = Type.Object({
	provider: Type.String(),
	id: Type.String(),
	thinking: Type.Optional(Type.String()),
});

const InstanceInfo = Type.Object({
	instanceId: Type.String(),
	pid: Type.Optional(Type.Number()),
	cwd: Type.String(),
	bundle: Type.Optional(Type.String()),
	bundleHash: Type.Optional(Type.String()),
	sessionPath: Type.Optional(Type.String()),
	state: Type.String(),
	model: Type.Optional(ModelRef),
});

const SessionInfo = Type.Object({
	sessionId: Type.String(),
	path: Type.String(),
	name: Type.Optional(Type.String()),
	cwd: Type.String(),
	kind: Type.Union([Type.Literal("baseline"), Type.Literal("task"), Type.Literal("scratch")]),
	pinned: Type.Boolean(),
	parentSession: Type.Optional(Type.String()),
	bundle: Type.Optional(Type.String()),
	bundleHash: Type.Optional(Type.String()),
	gitHead: Type.Optional(Type.String()),
	taskIds: Type.Optional(Type.Array(Type.String())),
	labels: Type.Optional(Type.Array(Type.String())),
	updatedAt: Type.Number(),
	attachedInstanceId: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const frameSchemas = {
	// Connection
	hello: Type.Object({
		...base,
		type: Type.Literal("hello"),
		machine: Type.String(),
		role: Type.Union([Type.Literal("server"), Type.Literal("agent")]),
		packageVersion: Type.String(),
		platform: Type.String(),
		availableModels: Type.Optional(Type.Array(ModelRef)),
	}),
	heartbeat: Type.Object({ ...base, type: Type.Literal("heartbeat") }),
	error: Type.Object({
		...base,
		type: Type.Literal("error"),
		code: Type.String(),
		message: Type.String(),
	}),

	// Instance lifecycle (server -> agent, agent -> server)
	spawn: Type.Object({
		...base,
		type: Type.Literal("spawn"),
		cwd: Type.String(),
		bundle: Type.String(),
		bundleHash: Type.Optional(Type.String()),
		fromSession: Type.Optional(Type.String()),
		model: Type.Optional(ModelRef),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		budget: Type.Optional(Type.Object({ maxCost: Type.Optional(Type.Number()) })),
	}),
	spawned: Type.Object({
		...base,
		type: Type.Literal("spawned"),
		instance: InstanceInfo,
	}),
	spawn_error: Type.Object({
		...base,
		type: Type.Literal("spawn_error"),
		code: Type.String(),
		message: Type.String(),
	}),
	stop: Type.Object({ ...base, type: Type.Literal("stop"), instanceId: Type.String() }),
	stopped: Type.Object({
		...base,
		type: Type.Literal("stopped"),
		instanceId: Type.String(),
		forced: Type.Boolean(),
		sessionPath: Type.Optional(Type.String()),
	}),
	list: Type.Object({ ...base, type: Type.Literal("list") }),
	instances: Type.Object({
		...base,
		type: Type.Literal("instances"),
		instances: Type.Array(InstanceInfo),
	}),

	// pi RPC passthrough (payloads are pi's native RPC commands/events)
	rpc: Type.Object({
		...base,
		type: Type.Literal("rpc"),
		instanceId: Type.String(),
		command: Type.Unknown(),
		/** When set on a prompt command, the agent tracks it as a task and emits a durable task_done on settle. */
		taskId: Type.Optional(Type.String()),
	}),
	event: Type.Object({
		...base,
		type: Type.Literal("event"),
		instanceId: Type.String(),
		event: Type.Unknown(),
	}),

	// Task completion & verification
	task_done: Type.Object({
		...base,
		type: Type.Literal("task_done"),
		taskId: Type.String(),
		instanceId: Type.String(),
		seq: Type.Number(),
		status: Type.Union([
			Type.Literal("settled"),
			Type.Literal("budget_exceeded"),
			Type.Literal("aborted"),
		]),
		summary: Type.String(),
		lastAssistantMessage: Type.Optional(Type.String()),
		stats: Type.Optional(
			Type.Object({
				turns: Type.Optional(Type.Number()),
				toolCalls: Type.Optional(Type.Number()),
				filesChanged: Type.Optional(Type.Number()),
				cost: Type.Optional(Type.Number()),
			}),
		),
	}),
	task_done_ack: Type.Object({
		...base,
		type: Type.Literal("task_done_ack"),
		taskId: Type.String(),
		seq: Type.Number(),
	}),
	task_accept: Type.Object({
		...base,
		type: Type.Literal("task_accept"),
		taskId: Type.String(),
		disposition: Type.Union([Type.Literal("stop"), Type.Literal("keep_idle")]),
		deliver: Type.Union([
			Type.Literal("branch"),
			Type.Literal("pr"),
			Type.Literal("patch"),
			Type.Literal("none"),
		]),
	}),
	task_reject: Type.Object({
		...base,
		type: Type.Literal("task_reject"),
		taskId: Type.String(),
		feedback: Type.String(),
	}),

	// Work delivery
	deliver: Type.Object({
		...base,
		type: Type.Literal("deliver"),
		taskId: Type.String(),
		instanceId: Type.String(),
		mode: Type.Union([Type.Literal("branch"), Type.Literal("pr"), Type.Literal("patch")]),
	}),
	delivered: Type.Object({
		...base,
		type: Type.Literal("delivered"),
		taskId: Type.String(),
		mode: Type.Union([Type.Literal("branch"), Type.Literal("pr"), Type.Literal("patch")]),
		branch: Type.Optional(Type.String()),
		prUrl: Type.Optional(Type.String()),
		patch: Type.Optional(Type.String()),
	}),

	// Worker extension-UI forwarding
	ui_request: Type.Object({
		...base,
		type: Type.Literal("ui_request"),
		instanceId: Type.String(),
		requestId: Type.String(),
		kind: Type.Union([
			Type.Literal("confirm"),
			Type.Literal("select"),
			Type.Literal("input"),
		]),
		title: Type.String(),
		message: Type.Optional(Type.String()),
		options: Type.Optional(Type.Array(Type.String())),
	}),
	ui_response: Type.Object({
		...base,
		type: Type.Literal("ui_response"),
		instanceId: Type.String(),
		requestId: Type.String(),
		value: Type.Union([Type.String(), Type.Boolean(), Type.Null()]),
		timedOut: Type.Optional(Type.Boolean()),
	}),

	// Session registry
	sessions_report: Type.Object({
		...base,
		type: Type.Literal("sessions_report"),
		machine: Type.String(),
		full: Type.Boolean(),
		sessions: Type.Array(SessionInfo),
	}),
	session_search: Type.Object({
		...base,
		type: Type.Literal("session_search"),
		query: Type.String(),
		cwd: Type.Optional(Type.String()),
	}),
	session_hits: Type.Object({
		...base,
		type: Type.Literal("session_hits"),
		hits: Type.Array(
			Type.Object({
				sessionId: Type.String(),
				path: Type.String(),
				snippet: Type.String(),
			}),
		),
	}),

	// Read-only file service (answered by the agent)
	fs_read: Type.Object({
		...base,
		type: Type.Literal("fs_read"),
		instanceId: Type.String(),
		path: Type.String(),
		offset: Type.Optional(Type.Number()),
		limit: Type.Optional(Type.Number()),
	}),
	fs_list: Type.Object({
		...base,
		type: Type.Literal("fs_list"),
		instanceId: Type.String(),
		path: Type.String(),
	}),
	fs_grep: Type.Object({
		...base,
		type: Type.Literal("fs_grep"),
		instanceId: Type.String(),
		pattern: Type.String(),
		glob: Type.Optional(Type.String()),
	}),
	fs_diff: Type.Object({
		...base,
		type: Type.Literal("fs_diff"),
		instanceId: Type.String(),
		ref: Type.Optional(Type.String()),
		staged: Type.Optional(Type.Boolean()),
		stat: Type.Optional(Type.Boolean()),
		/** Return `git rev-parse HEAD` instead of a diff. */
		revParse: Type.Optional(Type.Boolean()),
	}),
	fs_result: Type.Object({
		...base,
		type: Type.Literal("fs_result"),
		done: Type.Boolean(),
		text: Type.Optional(Type.String()),
		base64: Type.Optional(Type.String()),
		mime: Type.Optional(Type.String()),
		entries: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String(),
					kind: Type.Union([Type.Literal("file"), Type.Literal("dir")]),
					bytes: Type.Optional(Type.Number()),
				}),
			),
		),
		truncated: Type.Optional(Type.Boolean()),
		error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
	}),
} as const;

export type FrameType = keyof typeof frameSchemas;

export type FrameOf<T extends FrameType> = Static<(typeof frameSchemas)[T]>;

export type Frame = { [T in FrameType]: FrameOf<T> }[FrameType];

export { Peer, InstanceInfo, SessionInfo, ModelRef };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ProtocolError {
	code:
		| "invalid_json"
		| "not_an_object"
		| "unknown_frame_type"
		| "unsupported_version"
		| "schema_violation"
		| "frame_too_large";
	message: string;
	frameType?: string;
}

export type ParseResult = { ok: true; frame: Frame } | { ok: false; error: ProtocolError };

/** Validate an already-JSON-parsed value as a v1 frame. */
export function parseFrame(value: unknown): ParseResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: { code: "not_an_object", message: "frame must be a JSON object" } };
	}
	const record = value as Record<string, unknown>;
	const type = record.type;
	if (typeof type !== "string" || !(type in frameSchemas)) {
		return {
			ok: false,
			error: {
				code: "unknown_frame_type",
				message: `unknown frame type: ${String(type)}`,
				...(typeof type === "string" ? { frameType: type } : {}),
			},
		};
	}
	if (record.v !== PROTOCOL_VERSION) {
		return {
			ok: false,
			error: {
				code: "unsupported_version",
				message: `unsupported protocol version: ${String(record.v)} (expected ${PROTOCOL_VERSION})`,
				frameType: type,
			},
		};
	}
	const schema = frameSchemas[type as FrameType];
	if (!Value.Check(schema, value)) {
		const first = Value.Errors(schema, value)[0];
		const where = first?.instancePath ? ` at ${first.instancePath}` : "";
		return {
			ok: false,
			error: {
				code: "schema_violation",
				message: `invalid ${type} frame${where}: ${first?.message ?? "schema violation"}`,
				frameType: type,
			},
		};
	}
	return { ok: true, frame: value as Frame };
}

// ---------------------------------------------------------------------------
// JSONL codec
// ---------------------------------------------------------------------------

/** Encode a frame as a JSONL record. Throws if the frame exceeds MAX_FRAME_BYTES. */
export function encodeFrame(frame: Frame): Buffer {
	const json = JSON.stringify(frame);
	const buffer = Buffer.from(json + "\n", "utf8");
	if (buffer.byteLength > MAX_FRAME_BYTES) {
		throw new Error(
			`frame too large: ${buffer.byteLength} bytes (max ${MAX_FRAME_BYTES}), type ${frame.type}`,
		);
	}
	return buffer;
}

/**
 * Incremental JSONL frame decoder.
 *
 * Splits on `\n` only, strips a trailing `\r`, enforces MAX_FRAME_BYTES on
 * the raw line, and validates every record with parseFrame. An oversized or
 * malformed record yields an error result; decoding continues with the next
 * line (oversized data is skipped until the next `\n`).
 */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private skippingOversized = false;

	feed(chunk: Buffer | string): ParseResult[] {
		this.buffer = Buffer.concat([
			this.buffer,
			typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
		]);
		const results: ParseResult[] = [];

		for (;;) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline === -1) {
				if (this.buffer.byteLength > MAX_FRAME_BYTES) {
					if (!this.skippingOversized) {
						this.skippingOversized = true;
						results.push({
							ok: false,
							error: {
								code: "frame_too_large",
								message: `record exceeds ${MAX_FRAME_BYTES} bytes`,
							},
						});
					}
					this.buffer = Buffer.alloc(0);
				}
				return results;
			}

			const line = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);

			if (this.skippingOversized) {
				// Remainder of the oversized record; drop it silently.
				this.skippingOversized = false;
				continue;
			}
			if (line.byteLength > MAX_FRAME_BYTES) {
				results.push({
					ok: false,
					error: {
						code: "frame_too_large",
						message: `record exceeds ${MAX_FRAME_BYTES} bytes`,
					},
				});
				continue;
			}

			let text = line.toString("utf8");
			if (text.endsWith("\r")) text = text.slice(0, -1);
			if (text.length === 0) continue;

			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch {
				results.push({
					ok: false,
					error: { code: "invalid_json", message: "record is not valid JSON" },
				});
				continue;
			}
			results.push(parseFrame(value));
		}
	}
}
