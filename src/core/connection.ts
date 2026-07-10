/**
 * FrameConnection: JSONL frame transport over a net.Socket with heartbeats.
 *
 * Both ends send `heartbeat` every intervalMs and drop the connection when
 * nothing (frame or heartbeat) arrives for timeoutMs (docs/plan.md: 15s/45s).
 * Malformed frames produce protocol `error` frames but do not kill the
 * connection; oversized records are handled by FrameDecoder.
 */
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame, type Frame, type ProtocolError } from "./frames.ts";

export interface FrameConnectionOptions {
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	/** Suppress sending heartbeats (tests). */
	sendHeartbeats?: boolean;
}

export type FrameHandler = (frame: Frame) => void;
export type CloseHandler = (reason: "close" | "timeout" | "error") => void;

export class FrameConnection {
	readonly socket: Socket;
	private readonly decoder = new FrameDecoder();
	private frameHandler: FrameHandler | undefined;
	private closeHandler: CloseHandler | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private timeoutTimer: NodeJS.Timeout | undefined;
	private readonly intervalMs: number;
	private readonly timeoutMs: number;
	private closed = false;

	constructor(socket: Socket, options: FrameConnectionOptions = {}) {
		this.socket = socket;
		this.intervalMs = options.heartbeatIntervalMs ?? 15_000;
		this.timeoutMs = options.heartbeatTimeoutMs ?? 45_000;

		socket.on("data", (chunk: Buffer) => {
			this.armTimeout();
			for (const result of this.decoder.feed(chunk)) {
				if (result.ok) {
					if (result.frame.type === "heartbeat") continue;
					this.frameHandler?.(result.frame);
				} else {
					this.sendProtocolError(result.error);
				}
			}
		});
		socket.on("close", () => this.teardown("close"));
		socket.on("error", () => this.teardown("error"));

		if (options.sendHeartbeats !== false) {
			this.heartbeatTimer = setInterval(() => {
				this.trySend({ v: 1, type: "heartbeat" });
			}, this.intervalMs);
			this.heartbeatTimer.unref?.();
		}
		this.armTimeout();
	}

	onFrame(handler: FrameHandler): void {
		this.frameHandler = handler;
	}

	onClose(handler: CloseHandler): void {
		this.closeHandler = handler;
	}

	send(frame: Frame): void {
		if (this.closed) throw new Error("connection closed");
		this.socket.write(encodeFrame(frame));
	}

	trySend(frame: Frame): boolean {
		if (this.closed) return false;
		try {
			this.socket.write(encodeFrame(frame));
			return true;
		} catch {
			return false;
		}
	}

	close(): void {
		this.teardown("close");
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private sendProtocolError(error: ProtocolError): void {
		this.trySend({ v: 1, type: "error", code: error.code, message: error.message });
	}

	private armTimeout(): void {
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		this.timeoutTimer = setTimeout(() => this.teardown("timeout"), this.timeoutMs);
		this.timeoutTimer.unref?.();
	}

	private teardown(reason: "close" | "timeout" | "error"): void {
		if (this.closed) return;
		this.closed = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		this.socket.destroy();
		this.closeHandler?.(reason);
	}
}
