import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	resolveWithin,
	toNativePath,
	validateManifestPath,
	validateManifestPaths,
} from "../src/core/pathsafety.ts";

describe("AC-0.3 validateManifestPath", () => {
	it("accepts safe POSIX-relative paths", () => {
		for (const path of [
			"skills/review/SKILL.md",
			"extensions/reviewer.ts",
			"a/b/c/d.txt",
			"README.md",
			"with space/file name.md",
			"comX/lpt10/console.ts", // near-reserved but not reserved
		]) {
			expect(validateManifestPath(path), path).toBeNull();
		}
	});

	it("rejects absolute paths", () => {
		expect(validateManifestPath("/etc/passwd")?.code).toBe("absolute");
	});

	it("rejects drive letters", () => {
		expect(validateManifestPath("C:/windows/system32")?.code).toBe("drive_letter");
		expect(validateManifestPath("c:foo")?.code).toBe("drive_letter");
	});

	it("rejects backslash separators", () => {
		expect(validateManifestPath("skills\\foo\\SKILL.md")?.code).toBe("backslash");
	});

	it("rejects traversal", () => {
		expect(validateManifestPath("../outside")?.code).toBe("traversal");
		expect(validateManifestPath("a/../../b")?.code).toBe("traversal");
	});

	it("rejects dot and empty segments", () => {
		expect(validateManifestPath("./a")?.code).toBe("dot_segment");
		expect(validateManifestPath("a//b")?.code).toBe("empty_segment");
	});

	it("rejects Windows reserved names in any segment, case-insensitive, with extensions", () => {
		expect(validateManifestPath("CON")?.code).toBe("reserved_name");
		expect(validateManifestPath("nul.txt")?.code).toBe("reserved_name");
		expect(validateManifestPath("a/COM1/b.txt")?.code).toBe("reserved_name");
		expect(validateManifestPath("a/Lpt9.log")?.code).toBe("reserved_name");
		expect(validateManifestPath("prn.tar.gz")?.code).toBe("reserved_name");
	});

	it("rejects trailing dots and spaces", () => {
		expect(validateManifestPath("a/file.")?.code).toBe("trailing_dot_or_space");
		expect(validateManifestPath("dir /file")?.code).toBe("trailing_dot_or_space");
	});

	it("rejects control and Windows-invalid characters", () => {
		expect(validateManifestPath("a\u0000b")?.code).toBe("invalid_characters");
		expect(validateManifestPath("a<b>.txt")?.code).toBe("invalid_characters");
		expect(validateManifestPath("what?.md")?.code).toBe("invalid_characters");
		expect(validateManifestPath('say"hi"')?.code).toBe("invalid_characters");
	});

	it("rejects empty path", () => {
		expect(validateManifestPath("")?.code).toBe("empty");
	});
});

describe("AC-0.3 case collisions", () => {
	it("flags case-insensitive collisions", () => {
		const errors = validateManifestPaths(["src/Foo.ts", "src/foo.ts", "src/bar.ts"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe("case_collision");
		expect(errors[0]?.path).toBe("src/foo.ts");
		expect(errors[0]?.collidesWith).toBe("src/Foo.ts");
	});

	it("allows exact duplicates to pass collision check (caught elsewhere) and distinct paths", () => {
		expect(validateManifestPaths(["a.ts", "b.ts", "c/d.ts"])).toHaveLength(0);
	});

	it("collects all errors across a set", () => {
		const errors = validateManifestPaths(["../x", "CON", "ok.ts"]);
		expect(errors.map((e) => e.code).sort()).toEqual(["reserved_name", "traversal"]);
	});
});

describe("toNativePath", () => {
	it("joins validated segments natively", () => {
		expect(toNativePath("/root", "a/b/c.txt")).toBe(join("/root", "a", "b", "c.txt"));
	});

	it("throws on unsafe input", () => {
		expect(() => toNativePath("/root", "../escape")).toThrow(/traversal/);
	});
});

describe("resolveWithin (file service containment)", () => {
	it("resolves paths inside the root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pf-safe-"));
		await mkdir(join(root, "sub"), { recursive: true });
		await writeFile(join(root, "sub", "file.txt"), "hi");
		const resolved = await resolveWithin(root, "sub/file.txt");
		expect(resolved.endsWith(join("sub", "file.txt"))).toBe(true);
	});

	it("rejects lexical escape", async () => {
		const root = await mkdtemp(join(tmpdir(), "pf-safe-"));
		await expect(resolveWithin(root, "../outside")).rejects.toThrow(/escapes root/);
	});

	it("rejects symlink escape", async () => {
		const root = await mkdtemp(join(tmpdir(), "pf-safe-"));
		const outside = await mkdtemp(join(tmpdir(), "pf-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		try {
			await symlink(outside, join(root, "link"), "dir");
		} catch {
			return; // symlink creation may need privileges on Windows; skip there
		}
		await expect(resolveWithin(root, "link/secret.txt")).rejects.toThrow(/escapes root/);
	});
});
