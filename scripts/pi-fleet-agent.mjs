#!/usr/bin/env node
// Fleet agent CLI.
//   pi-fleet-agent serve --server <pinned-machine> [--port 9788]
//   pi-fleet-agent install-service --server <pinned-machine> [--port 9788]
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { startAgentDaemon, AGENT_DEFAULT_PORT } = await jiti.import(join(here, "../src/agent/daemon.ts"));
const { Tailscale } = await jiti.import(join(here, "../src/core/tailscale.ts"));
const { generateSystemdUnit, generateLaunchdPlist, generateSchtasksCommand } = await jiti.import(
	join(here, "../src/agent/service.ts"),
);

const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function flags(name) {
	const values = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === `--${name}` && args[index + 1] !== undefined) values.push(args[index + 1]);
	}
	return values;
}

const pinnedServer = flag("server");
const port = Number(flag("port", String(AGENT_DEFAULT_PORT)));

if (command === "serve") {
	if (!pinnedServer) {
		console.error("pi-fleet-agent serve requires --server <pinned-machine-name>");
		process.exit(1);
	}
	const tailscale = new Tailscale();
	const host = await tailscale.ip4();
	const running = await startAgentDaemon({
		host,
		port,
		machine: hostname(),
		pinnedServer,
		whois: (ip) => tailscale.whois(ip),
		ipProvider: { current: () => tailscale.ip4() },
		...(flag("max-workers") ? { maxWorkers: Number(flag("max-workers")) } : {}),
		exec: {
			enabled: flag("exec-policy", "off") === "full",
			roots: flags("exec-root"),
			...(flag("max-execs") ? { maxConcurrent: Number(flag("max-execs")) } : {}),
			...(flag("exec-timeout") ? { defaultTimeoutSeconds: Number(flag("exec-timeout")) } : {}),
			...(flag("exec-audit-file") ? { auditFile: flag("exec-audit-file") } : {}),
		},
		log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
	});
	console.log(`pi-fleet agent on ${running.host}:${running.port} (pinned: ${pinnedServer})`);
	const shutdown = async () => {
		await running.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
} else if (command === "install-service") {
	if (!pinnedServer) {
		console.error("pi-fleet-agent install-service requires --server <pinned-machine-name>");
		process.exit(1);
	}
	const spec = {
		nodePath: process.execPath,
		entryPath: resolve(here, "pi-fleet-agent.mjs"),
		pinnedServer,
		port,
		execPolicy: flag("exec-policy", "off") === "full" ? "full" : "off",
		execRoots: flags("exec-root"),
		...(flag("max-execs") ? { maxExecs: Number(flag("max-execs")) } : {}),
		...(flag("exec-timeout") ? { execTimeoutSeconds: Number(flag("exec-timeout")) } : {}),
		privileged: args.includes("--privileged"),
	};
	if (process.platform === "linux") {
		const unit = generateSystemdUnit(spec);
		console.log(`# write to ~/${unit.path} then:`);
		console.log("#   systemctl --user daemon-reload && systemctl --user enable --now pi-fleet-agent");
		console.log(unit.content);
	} else if (process.platform === "darwin") {
		const plist = generateLaunchdPlist(spec);
		console.log(`# write to ~/${plist.path} then:`);
		console.log(`#   launchctl load ~/${plist.path}`);
		console.log(plist.content);
	} else {
		console.log("# run in an elevated-enough shell:");
		console.log(generateSchtasksCommand(spec));
	}
} else {
	console.error("usage: pi-fleet-agent <serve|install-service> --server <machine> [--port N] [--exec-policy full] [--exec-root PATH] [--max-execs N] [--exec-timeout SEC] [--privileged]");
	process.exit(1);
}
