/**
 * Tailscale integration via the CLI only — never the LocalAPI socket, whose
 * location differs per OS (unix socket / named pipe). `tailscale ip -4`,
 * `status --json`, and `whois --json` behave identically on all platforms.
 * See docs/plan.md (Cross-platform commitments).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export interface TailscaleIdentity {
	machine: string;
	user: string;
}

export interface TailscalePeer {
	hostName: string;
	dnsName: string;
	online: boolean;
	tailscaleIPs: string[];
}

const defaultExec: ExecFn = (command, args) =>
	new Promise((resolvePromise) => {
		execFile(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
				? ((error as unknown as { code: number }).code)
				: error
					? 1
					: 0;
			resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
		});
	});

/** Platform fallback locations when `tailscale` is not on PATH. */
export function tailscaleFallbackPaths(platform: NodeJS.Platform): string[] {
	switch (platform) {
		case "win32":
			return ["C:\\Program Files\\Tailscale\\tailscale.exe"];
		case "darwin":
			return [
				"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
				"/usr/local/bin/tailscale",
				"/opt/homebrew/bin/tailscale",
			];
		default:
			return ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
	}
}

export interface TailscaleOptions {
	exec?: ExecFn;
	platform?: NodeJS.Platform;
	fileExists?: (path: string) => boolean;
}

export class Tailscale {
	private readonly exec: ExecFn;
	private readonly platform: NodeJS.Platform;
	private readonly fileExists: (path: string) => boolean;
	private binary: string | undefined;

	constructor(options: TailscaleOptions = {}) {
		this.exec = options.exec ?? defaultExec;
		this.platform = options.platform ?? process.platform;
		this.fileExists = options.fileExists ?? existsSync;
	}

	/** Locate the tailscale binary: PATH first, then platform fallbacks. */
	async findBinary(): Promise<string | null> {
		if (this.binary !== undefined) return this.binary;
		const onPath = await this.exec("tailscale", ["version"]);
		if (onPath.code === 0) {
			this.binary = "tailscale";
			return this.binary;
		}
		for (const candidate of tailscaleFallbackPaths(this.platform)) {
			if (this.fileExists(candidate)) {
				const probe = await this.exec(candidate, ["version"]);
				if (probe.code === 0) {
					this.binary = candidate;
					return this.binary;
				}
			}
		}
		return null;
	}

	/** The machine's own tailnet IPv4 address. */
	async ip4(): Promise<string> {
		const result = await this.run(["ip", "-4"]);
		const ip = result.stdout.trim().split("\n")[0]?.trim();
		if (!ip) throw new Error("tailscale ip -4 returned no address");
		return ip;
	}

	/** Online peers with their MagicDNS names, for /join and spawn-target pickers. */
	async peers(): Promise<TailscalePeer[]> {
		const result = await this.run(["status", "--json"]);
		const status = JSON.parse(result.stdout) as {
			Peer?: Record<string, { HostName?: string; DNSName?: string; Online?: boolean; TailscaleIPs?: string[] }>;
		};
		return Object.values(status.Peer ?? {}).map((peer) => ({
			hostName: peer.HostName ?? "",
			dnsName: peer.DNSName ?? "",
			online: peer.Online ?? false,
			tailscaleIPs: peer.TailscaleIPs ?? [],
		}));
	}

	/**
	 * Identify the tailnet machine and user behind an IP. This is the trust
	 * primitive: WireGuard-backed, unforgeable within the tailnet.
	 */
	async whois(ip: string): Promise<TailscaleIdentity> {
		const result = await this.run(["whois", "--json", ip]);
		const parsed = JSON.parse(result.stdout) as {
			Node?: { ComputedName?: string; Name?: string };
			UserProfile?: { LoginName?: string };
		};
		const machine = parsed.Node?.ComputedName ?? parsed.Node?.Name ?? "";
		const user = parsed.UserProfile?.LoginName ?? "";
		if (!machine || !user) throw new Error(`tailscale whois returned incomplete identity for ${ip}`);
		return { machine, user };
	}

	private async run(args: string[]): Promise<ExecResult> {
		const binary = await this.findBinary();
		if (binary === null) {
			throw new Error("tailscale CLI not found (PATH and platform fallbacks checked)");
		}
		const result = await this.exec(binary, args);
		if (result.code !== 0) {
			throw new Error(`tailscale ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
		}
		return result;
	}
}
