import { describe, expect, it } from "vitest";
import { Tailscale, tailscaleFallbackPaths, type ExecFn } from "../src/core/tailscale.ts";

function fakeExec(handlers: Record<string, (args: string[]) => { stdout?: string; code?: number }>): ExecFn & { calls: Array<[string, string[]]> } {
	const calls: Array<[string, string[]]> = [];
	const exec = (async (command: string, args: string[]) => {
		calls.push([command, args]);
		const handler = handlers[command];
		const result = handler ? handler(args) : { code: 127 };
		return { stdout: result.stdout ?? "", stderr: "", code: result.code ?? 0 };
	}) as ExecFn & { calls: Array<[string, string[]]> };
	exec.calls = calls;
	return exec;
}

describe("binary discovery", () => {
	it("prefers PATH", async () => {
		const exec = fakeExec({ tailscale: () => ({ stdout: "1.80.0" }) });
		const ts = new Tailscale({ exec, platform: "linux", fileExists: () => true });
		expect(await ts.findBinary()).toBe("tailscale");
	});

	it("falls back to platform locations when PATH misses", async () => {
		const macBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
		const exec = fakeExec({
			tailscale: () => ({ code: 127 }),
			[macBinary]: () => ({ stdout: "1.80.0" }),
		});
		const ts = new Tailscale({ exec, platform: "darwin", fileExists: (p) => p === macBinary });
		expect(await ts.findBinary()).toBe(macBinary);
	});

	it("returns null when nothing is found", async () => {
		const exec = fakeExec({});
		const ts = new Tailscale({ exec, platform: "linux", fileExists: () => false });
		expect(await ts.findBinary()).toBeNull();
	});

	it("fallback paths are platform-appropriate", () => {
		expect(tailscaleFallbackPaths("win32")[0]).toContain("Program Files");
		expect(tailscaleFallbackPaths("darwin")[0]).toContain("Tailscale.app");
		expect(tailscaleFallbackPaths("linux")[0]).toBe("/usr/bin/tailscale");
	});
});

describe("CLI wrappers", () => {
	it("ip4 returns the first IPv4", async () => {
		const exec = fakeExec({
			tailscale: (args) =>
				args[0] === "version" ? { stdout: "1.80.0" } : { stdout: "100.64.1.5\nfd7a::1\n" },
		});
		const ts = new Tailscale({ exec, platform: "linux" });
		expect(await ts.ip4()).toBe("100.64.1.5");
	});

	it("peers parses status --json", async () => {
		const status = {
			Peer: {
				key1: { HostName: "buildbox", DNSName: "buildbox.tail.ts.net.", Online: true, TailscaleIPs: ["100.64.1.9"] },
				key2: { HostName: "winbox", Online: false },
			},
		};
		const exec = fakeExec({
			tailscale: (args) =>
				args[0] === "version" ? { stdout: "1.80.0" } : { stdout: JSON.stringify(status) },
		});
		const ts = new Tailscale({ exec, platform: "linux" });
		const peers = await ts.peers();
		expect(peers).toHaveLength(2);
		expect(peers[0]).toEqual({
			hostName: "buildbox",
			dnsName: "buildbox.tail.ts.net.",
			online: true,
			tailscaleIPs: ["100.64.1.9"],
		});
	});

	it("whois returns machine and user identity", async () => {
		const whois = { Node: { ComputedName: "buildbox" }, UserProfile: { LoginName: "ana@github" } };
		const exec = fakeExec({
			tailscale: (args) =>
				args[0] === "version" ? { stdout: "1.80.0" } : { stdout: JSON.stringify(whois) },
		});
		const ts = new Tailscale({ exec, platform: "linux" });
		expect(await ts.whois("100.64.1.9")).toEqual({ machine: "buildbox", user: "ana@github" });
	});

	it("whois rejects incomplete identities", async () => {
		const exec = fakeExec({
			tailscale: (args) => (args[0] === "version" ? { stdout: "1.80.0" } : { stdout: "{}" }),
		});
		const ts = new Tailscale({ exec, platform: "linux" });
		await expect(ts.whois("100.64.1.9")).rejects.toThrow(/incomplete identity/);
	});

	it("surfaces CLI failures with command context", async () => {
		const exec = fakeExec({
			tailscale: (args) => (args[0] === "version" ? { stdout: "1.80.0" } : { code: 1 }),
		});
		const ts = new Tailscale({ exec, platform: "linux" });
		await expect(ts.ip4()).rejects.toThrow(/tailscale ip -4 failed/);
	});
});
