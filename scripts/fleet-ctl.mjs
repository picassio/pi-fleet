#!/usr/bin/env node
// Raw control of a fleet agent (Phase 2 exit tool).
//   fleet-ctl <host:port> list
//   fleet-ctl <host:port> spawn --cwd <path> --bundle <name> --registry <url>
//   fleet-ctl <host:port> rpc <instanceId> '<json>'   (streams events for 10s)
//   fleet-ctl <host:port> stop <instanceId>
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { AgentClient } = await jiti.import(join(here, "../src/server/agent-client.ts"));

const [target, command, ...rest] = process.argv.slice(2);
if (!target || !command) {
	console.error("usage: fleet-ctl <host:port> <list|spawn|rpc|stop> ...");
	process.exit(1);
}
const [host, portText] = target.split(":");
const client = await AgentClient.connect(host, Number(portText ?? 9788));
const hello = await client.hello();
console.error(`connected: ${hello.machine} (${hello.platform}, v${hello.packageVersion})`);

function flag(name) {
	const index = rest.indexOf(`--${name}`);
	return index !== -1 ? rest[index + 1] : undefined;
}

if (command === "list") {
	console.log(JSON.stringify(await client.list(), null, 2));
	client.close();
} else if (command === "spawn") {
	const cwd = flag("cwd");
	const bundle = flag("bundle") ?? "default";
	const registry = flag("registry");
	if (!cwd || !registry) {
		console.error("spawn requires --cwd and --registry");
		process.exit(1);
	}
	const instance = await client.spawn({ cwd, bundle, env: { PI_FLEET_SERVER: registry } });
	console.log(JSON.stringify(instance, null, 2));
	client.close();
} else if (command === "rpc") {
	const [instanceId, json] = rest;
	client.onEvent((id, event) => {
		if (id === instanceId) console.log(JSON.stringify(event));
	});
	client.rpc(instanceId, JSON.parse(json));
	setTimeout(() => client.close(), Number(process.env.FLEET_CTL_WAIT_MS ?? 10_000));
} else if (command === "stop") {
	const [instanceId] = rest;
	console.log(JSON.stringify(await client.stop(instanceId)));
	client.close();
} else {
	console.error(`unknown command: ${command}`);
	client.close();
	process.exit(1);
}
