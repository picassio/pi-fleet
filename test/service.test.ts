import { describe, expect, it } from "vitest";
import {
	generateLaunchdPlist,
	generateSchtasksCommand,
	generateSystemdUnit,
	type ServiceSpec,
} from "../src/agent/service.ts";

const spec: ServiceSpec = {
	nodePath: "/usr/bin/node",
	entryPath: "/home/ana/pi-fleet/scripts/pi-fleet-agent.mjs",
	pinnedServer: "claude3-10",
	port: 9788,
};

describe("AC-2.6 service generators", () => {
	it("systemd unit pins the server and restarts on failure", () => {
		const unit = generateSystemdUnit(spec);
		expect(unit.path).toBe(".config/systemd/user/pi-fleet-agent.service");
		expect(unit.content).toContain("--server claude3-10");
		expect(unit.content).toContain("--port 9788");
		expect(unit.content).toContain("Restart=on-failure");
		expect(unit.content).toContain("After=network-online.target tailscaled.service");
	});

	it("launchd plist runs at load and keeps alive on failure", () => {
		const plist = generateLaunchdPlist(spec);
		expect(plist.path).toBe("Library/LaunchAgents/dev.pi-fleet.agent.plist");
		expect(plist.content).toContain("<string>claude3-10</string>");
		expect(plist.content).toContain("<key>RunAtLoad</key><true/>");
		expect(plist.content).toContain("SuccessfulExit");
	});

	it("schtasks command runs on logon with limited privileges", () => {
		const command = generateSchtasksCommand(spec);
		expect(command).toContain("/sc onlogon");
		expect(command).toContain("/rl limited");
		expect(command).toContain("--server claude3-10");
	});
});
