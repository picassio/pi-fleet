/**
 * Phase 1 exit criterion (AC-1.1/1.2): a real `pi --mode rpc` worker
 * provisions itself from a local registry — the bundle's skills and hosted
 * extensions are active at startup.
 *
 * Requires a locally installed `pi`; skipped when unavailable (CI does not
 * install pi in Phase 1).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toNativePath } from "../src/core/pathsafety.ts";
import { publishBundle } from "../src/worker/registry.ts";

function piAvailable(): boolean {
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
		encoding: "utf8",
	});
	return probe.status === 0;
}

const available = piAvailable();

describe.skipIf(!available)("Phase 1 exit: real pi worker provisions from a local registry", () => {
	it(
		"activates bundle skills and hosted extension commands at startup",
		{ timeout: 90_000 },
		async () => {
			// Build a registry with one bundle: a skill + an extension.
			const source = await mkdtemp(join(tmpdir(), "pf-int-src-"));
			await mkdir(join(source, "skills", "greet"), { recursive: true });
			await mkdir(join(source, "extensions"), { recursive: true });
			await writeFile(
				toNativePath(source, "skills/greet/SKILL.md"),
				"---\nname: greet\ndescription: Greet someone warmly\n---\nSay hello.\n",
				"utf8",
			);
			await writeFile(
				toNativePath(source, "extensions/hello.ts"),
				`export default function (pi: { registerCommand(n: string, o: object): void }) {
	pi.registerCommand("bundle-hello", { description: "From the fleet bundle", handler: async () => {} });
}
`,
				"utf8",
			);
			const registryRoot = await mkdtemp(join(tmpdir(), "pf-int-reg-"));
			await publishBundle({
				sourceDir: source,
				registryRoot,
				meta: { name: "default", skills: ["skills"], extensions: ["extensions/hello.ts"] },
			});
			const cacheRoot = await mkdtemp(join(tmpdir(), "pf-int-cache-"));

			// Spawn a real pi RPC worker with the fleet extension.
			const entry = resolve(import.meta.dirname, "..", "src", "index.ts");
			const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", entry], {
				env: {
					...process.env,
					PI_FLEET_SERVER: registryRoot,
					PI_FLEET_BUNDLE: "default",
					PI_FLEET_CACHE: cacheRoot,
				},
				stdio: ["pipe", "pipe", "pipe"],
				shell: process.platform === "win32",
			});

			try {
				child.stdin.write('{"type":"get_commands","id":"itest-1"}\n');
				const data = await new Promise<{ commands: Array<{ name: string }> }>(
					(resolvePromise, rejectPromise) => {
						let buffer = "";
						const timer = setTimeout(
							() => rejectPromise(new Error(`timed out; output so far: ${buffer.slice(0, 2000)}`)),
							80_000,
						);
						child.stdout.on("data", (chunk: Buffer) => {
							buffer += chunk.toString("utf8");
							for (const line of buffer.split("\n")) {
								if (!line.includes('"itest-1"')) continue;
								try {
									const parsed = JSON.parse(line) as {
										id?: string;
										success?: boolean;
										data?: { commands: Array<{ name: string }> };
									};
									if (parsed.id === "itest-1" && parsed.success && parsed.data) {
										clearTimeout(timer);
										resolvePromise(parsed.data);
									}
								} catch {
									// partial line; keep buffering
								}
							}
						});
						child.on("error", (error) => {
							clearTimeout(timer);
							rejectPromise(error);
						});
						child.on("exit", (code) => {
							clearTimeout(timer);
							rejectPromise(new Error(`pi exited early with code ${code}`));
						});
					},
				);

				const names = data.commands.map((command) => command.name);
				expect(names).toContain("bundle-hello"); // hosted bundle extension (AC-1.2)
				expect(names).toContain("skill:greet"); // synced bundle skill (AC-1.1)
			} finally {
				child.kill();
			}
		},
	);
});
