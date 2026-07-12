import { describe, expect, it, vi } from "vitest";
import { BRIDGE_GLOBAL, createBridge, type BridgeManagerLike } from "../src/server/bridge.ts";

function fakeManager(overrides: Partial<BridgeManagerLike> = {}): BridgeManagerLike {
	return {
		spawn: vi.fn(async (req) => ({ instanceId: "i-1", host: req.host, bundle: req.bundle })),
		prompt: vi.fn(async () => undefined),
		rpcRequest: vi.fn(async () => ({ ok: true })),
		abort: vi.fn(async () => undefined),
		stop: vi.fn(async () => ({ forced: false })),
		status: vi.fn(() => [
			{ instanceId: "i-1", host: "h", bundle: "default", state: "running", settled: false },
		]),
		loadBaselines: vi.fn(async () => new Map()),
		fs: vi.fn(async () => ({ text: "abc123\n" })),
		...overrides,
	};
}

describe("createBridge", () => {
	it("spawnWorker delegates with bundle default and returns instance identity", async () => {
		const manager = fakeManager();
		const { bridge } = createBridge(() => manager);
		const result = await bridge.spawnWorker({ host: "h", cwd: "/w" });
		expect(result).toEqual({ instanceId: "i-1", host: "h", bundle: "default" });
		expect(manager.spawn).toHaveBeenCalledWith({ host: "h", cwd: "/w", bundle: "default" });
	});

	it("spawnWorker with fromBaseline clones and flags staleness", async () => {
		const manager = fakeManager({
			loadBaselines: vi.fn(
				async () =>
					new Map([
						[
							"api",
							{ label: "api", host: "bh", cwd: "/repo", bundle: "b", sessionPath: "/s.jsonl", gitHead: "def456" },
						],
					]),
			),
		});
		const { bridge } = createBridge(() => manager);
		const result = await bridge.spawnWorker({ host: "ignored", cwd: "/ignored", fromBaseline: "api" });
		expect(manager.spawn).toHaveBeenCalledWith({ host: "bh", cwd: "/repo", bundle: "b" });
		expect(manager.rpcRequest).toHaveBeenCalledWith("i-1", { type: "switch_session", sessionPath: "/s.jsonl" });
		expect(manager.rpcRequest).toHaveBeenCalledWith("i-1", { type: "clone" });
		expect(result.staleBaseline).toBe(true); // fs revParse "abc123" != gitHead "def456"
	});

	it("spawnWorker rejects unknown baseline", async () => {
		const { bridge } = createBridge(() => fakeManager());
		await expect(bridge.spawnWorker({ host: "h", cwd: "/w", fromBaseline: "nope" })).rejects.toThrow(
			"unknown baseline: nope",
		);
	});

	it("fans events out to per-instance subscribers with error isolation", () => {
		const { bridge, dispatchEvent } = createBridge(() => fakeManager());
		const seen: unknown[] = [];
		const bad = vi.fn(() => {
			throw new Error("consumer bug");
		});
		const unsubscribe = bridge.onEvent("i-1", (e) => seen.push(e));
		bridge.onEvent("i-1", bad);
		const other = vi.fn();
		bridge.onEvent("i-2", other);

		dispatchEvent("i-1", { type: "message_end" });
		expect(seen).toEqual([{ type: "message_end" }]);
		expect(bad).toHaveBeenCalled();
		expect(other).not.toHaveBeenCalled();

		unsubscribe();
		dispatchEvent("i-1", { type: "turn_end" });
		expect(seen).toHaveLength(1); // unsubscribed listener not called
		expect(bad).toHaveBeenCalledTimes(2); // remaining listener still called
	});

	it("stop clears subscribers for the instance", async () => {
		const { bridge, dispatchEvent } = createBridge(() => fakeManager());
		const listener = vi.fn();
		bridge.onEvent("i-1", listener);
		await bridge.stop("i-1");
		dispatchEvent("i-1", { type: "x" });
		expect(listener).not.toHaveBeenCalled();
	});

	it("status finds one instance by id", () => {
		const { bridge } = createBridge(() => fakeManager());
		expect(bridge.status("i-1")?.state).toBe("running");
		expect(bridge.status("missing")).toBeUndefined();
	});

	it("publish/unpublish own the global slot safely", () => {
		const a = createBridge(() => fakeManager());
		const b = createBridge(() => fakeManager());
		a.publish();
		expect((globalThis as Record<string, unknown>)[BRIDGE_GLOBAL]).toBe(a.bridge);
		b.publish(); // replacement (e.g. reload created a new instance)
		a.unpublish(); // a no longer owns the slot — must not delete b's bridge
		expect((globalThis as Record<string, unknown>)[BRIDGE_GLOBAL]).toBe(b.bridge);
		b.unpublish();
		expect((globalThis as Record<string, unknown>)[BRIDGE_GLOBAL]).toBeUndefined();
	});

	it("version is 1 for consumer feature detection", () => {
		const { bridge } = createBridge(() => fakeManager());
		expect(bridge.version).toBe(1);
	});
});
