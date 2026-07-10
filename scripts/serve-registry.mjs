#!/usr/bin/env node
// Serve an on-disk bundle registry over HTTP, bound to the tailscale IP.
// Usage: node scripts/serve-registry.mjs <registryRoot> [port]
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startRegistryServer } = await jiti.import("../src/server/registry-server.ts");
const { Tailscale } = await jiti.import("../src/core/tailscale.ts");

const root = process.argv[2];
const port = Number(process.argv[3] ?? 9787);
if (!root) {
	console.error("usage: serve-registry.mjs <registryRoot> [port]");
	process.exit(1);
}

const tailscale = new Tailscale();
const host = await tailscale.ip4();
const whoisCache = new Map();

const running = await startRegistryServer({
	root,
	host,
	port,
	onRequest: ({ remoteAddress, method, url }) => {
		const ip = remoteAddress.replace(/^::ffff:/, "");
		const cached = whoisCache.get(ip);
		if (cached) {
			console.log(`[${new Date().toISOString()}] ${cached} ${method} ${url}`);
			return;
		}
		tailscale
			.whois(ip)
			.then((identity) => {
				const label = `${identity.machine}(${identity.user})`;
				whoisCache.set(ip, label);
				console.log(`[${new Date().toISOString()}] ${label} ${method} ${url}`);
			})
			.catch(() => {
				whoisCache.set(ip, `unknown(${ip})`);
				console.log(`[${new Date().toISOString()}] unknown(${ip}) ${method} ${url}`);
			});
	},
});

console.log(`pi-fleet registry serving ${root} on ${running.url} (tailnet only)`);
