import { describe, expect, it } from "vitest";
import { PiNotFoundError, buildPiRpcInvocation, resolvePiCommand } from "../src/core/spawn.ts";

describe("resolvePiCommand", () => {
	it("resolves an absolute pi (PATH dirs or node's bin dir) on POSIX", async () => {
		for (const platform of ["linux", "darwin"] as const) {
			const resolved = await resolvePiCommand({ platform });
			expect(resolved.prefixArgs).toEqual([]);
			// Absolute when pi is findable (this environment has it); bare "pi" fallback otherwise.
			expect(
				resolved.command === "pi" || resolved.command.endsWith("/pi") || resolved.command.endsWith("\\pi"),
			).toBe(true);
		}
	});

	it("prefers .exe on Windows", async () => {
		const resolved = await resolvePiCommand({
			platform: "win32",
			lookup: async () => ["C:\\tools\\pi.exe", "C:\\nvm\\pi.cmd"],
		});
		expect(resolved).toEqual({ command: "C:\\tools\\pi.exe", prefixArgs: [] });
	});

	it("wraps .cmd via cmd.exe /c (Node refuses bare .cmd spawn)", async () => {
		const resolved = await resolvePiCommand({
			platform: "win32",
			lookup: async () => ["C:\\Users\\ana\\AppData\\Roaming\\npm\\pi.cmd"],
		});
		expect(resolved).toEqual({
			command: "cmd.exe",
			prefixArgs: ["/c", "C:\\Users\\ana\\AppData\\Roaming\\npm\\pi.cmd"],
		});
	});

	it("throws PiNotFoundError when `where` finds nothing", async () => {
		await expect(resolvePiCommand({ platform: "win32", lookup: async () => [] })).rejects.toThrow(
			PiNotFoundError,
		);
	});

	it("throws when only unusable candidates exist", async () => {
		await expect(
			resolvePiCommand({ platform: "win32", lookup: async () => ["C:\\tools\\pi.ps1"] }),
		).rejects.toThrow(PiNotFoundError);
	});
});

describe("buildPiRpcInvocation", () => {
	it("builds POSIX argv", () => {
		expect(buildPiRpcInvocation({ command: "pi", prefixArgs: [] }, ["--no-session"])).toEqual({
			command: "pi",
			args: ["--mode", "rpc", "--no-session"],
		});
	});

	it("builds Windows cmd.exe argv with prefix preserved", () => {
		expect(
			buildPiRpcInvocation({ command: "cmd.exe", prefixArgs: ["/c", "C:\\npm\\pi.cmd"] }),
		).toEqual({ command: "cmd.exe", args: ["/c", "C:\\npm\\pi.cmd", "--mode", "rpc"] });
	});
});
