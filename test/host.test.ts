import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundleExtensions } from "../src/worker/host.ts";

interface FakePi {
	tools: string[];
	commands: string[];
	registerTool(def: { name: string }): void;
	registerCommand(name: string): void;
}

function makeFakePi(): FakePi {
	return {
		tools: [],
		commands: [],
		registerTool(def) {
			this.tools.push(def.name);
		},
		registerCommand(name) {
			this.commands.push(name);
		},
	};
}

describe("AC-1.2 bundle extension hosting", () => {
	it("loads TS modules and invokes their default factory with the pi handle", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pf-ext-"));
		const path = join(dir, "good.ts");
		await writeFile(
			path,
			`interface Pi { registerTool(d: { name: string }): void; registerCommand(n: string): void }
export default function (pi: Pi) {
	pi.registerTool({ name: "bundle_tool" });
	pi.registerCommand("bundle-hello");
}
`,
			"utf8",
		);
		const pi = makeFakePi();
		const results = await loadBundleExtensions([path], pi);
		expect(results).toEqual([{ path, ok: true }]);
		expect(pi.tools).toEqual(["bundle_tool"]);
		expect(pi.commands).toEqual(["bundle-hello"]);
	});

	it("supports async factories", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pf-ext-"));
		const path = join(dir, "async.ts");
		await writeFile(
			path,
			`export default async function (pi: { registerTool(d: { name: string }): void }) {
	await new Promise((r) => setTimeout(r, 5));
	pi.registerTool({ name: "late_tool" });
}
`,
			"utf8",
		);
		const pi = makeFakePi();
		const results = await loadBundleExtensions([path], pi);
		expect(results[0]?.ok).toBe(true);
		expect(pi.tools).toEqual(["late_tool"]);
	});

	it("one failing module does not prevent others from loading", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pf-ext-"));
		const bad = join(dir, "bad.ts");
		const throws = join(dir, "throws.ts");
		const good = join(dir, "good.ts");
		await writeFile(bad, `export const notAFactory = 1;\n`, "utf8");
		await writeFile(throws, `export default function () { throw new Error("boom"); }\n`, "utf8");
		await writeFile(
			good,
			`export default function (pi: { registerTool(d: { name: string }): void }) { pi.registerTool({ name: "ok" }); }\n`,
			"utf8",
		);

		const pi = makeFakePi();
		const results = await loadBundleExtensions([bad, throws, good], pi);
		expect(results.map((r) => r.ok)).toEqual([false, false, true]);
		expect(results[0]?.error).toContain("no default export");
		expect(results[1]?.error).toContain("boom");
		expect(pi.tools).toEqual(["ok"]);
	});

	it("returns empty for no extensions", async () => {
		expect(await loadBundleExtensions([], makeFakePi())).toEqual([]);
	});
});
