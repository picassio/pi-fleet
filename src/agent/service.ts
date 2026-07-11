/**
 * OS service generators for the fleet agent (AC-2.6): systemd user unit,
 * launchd plist, and Windows scheduled task command. Pure string builders —
 * installation is performed by the agent CLI.
 */

export interface ServiceSpec {
	/** Absolute path to the node binary. */
	nodePath: string;
	/** Absolute path to the agent entry script. */
	entryPath: string;
	pinnedServer: string;
	port: number;
	execPolicy?: "off" | "full";
	execRoots?: string[];
	maxExecs?: number;
	execTimeoutSeconds?: number;
	privileged?: boolean;
}

function serviceArgs(spec: ServiceSpec): string[] {
	return [
		"serve", "--server", spec.pinnedServer, "--port", String(spec.port),
		...(spec.execPolicy === "full" ? ["--exec-policy", "full"] : []),
		...(spec.execRoots ?? []).flatMap((root) => ["--exec-root", root]),
		...(spec.maxExecs !== undefined ? ["--max-execs", String(spec.maxExecs)] : []),
		...(spec.execTimeoutSeconds !== undefined ? ["--exec-timeout", String(spec.execTimeoutSeconds)] : []),
	];
}

export function generateSystemdUnit(spec: ServiceSpec): { path: string; content: string } {
	return {
		path: ".config/systemd/user/pi-fleet-agent.service",
		content: `[Unit]
Description=pi-fleet agent (pinned server: ${spec.pinnedServer})
After=network-online.target tailscaled.service

[Service]
Environment=PATH=${spec.nodePath.substring(0, spec.nodePath.lastIndexOf("/"))}:/usr/local/bin:/usr/bin:/bin
ExecStart=${spec.nodePath} ${spec.entryPath} ${serviceArgs(spec).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
	};
}

export function generateLaunchdPlist(spec: ServiceSpec): { path: string; content: string } {
	return {
		path: "Library/LaunchAgents/dev.pi-fleet.agent.plist",
		content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.pi-fleet.agent</string>
	<key>ProgramArguments</key>
	<array>
		<string>${spec.nodePath}</string>
		<string>${spec.entryPath}</string>
${serviceArgs(spec).map((argument) => `\t\t<string>${argument}</string>`).join("\n")}
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`,
	};
}

export function generateSchtasksCommand(spec: ServiceSpec): string {
	const action = `"${spec.nodePath}" "${spec.entryPath}" ${serviceArgs(spec).join(" ")}`;
	return `schtasks /create /tn "pi-fleet-agent" /sc onlogon /rl ${spec.privileged ? "highest" : "limited"} /tr '${action}'`;
}
