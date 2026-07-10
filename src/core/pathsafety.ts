/**
 * Path safety for bundle manifests and any path received over the wire.
 *
 * Manifest paths are always POSIX-relative (`skills/foo/SKILL.md`). Every path
 * crossing a trust boundary goes through these validators before it touches
 * the filesystem. See docs/plan.md (Bundle manifest) and AC-0.3.
 */
import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type PathSafetyErrorCode =
	| "empty"
	| "absolute"
	| "backslash"
	| "drive_letter"
	| "traversal"
	| "dot_segment"
	| "empty_segment"
	| "reserved_name"
	| "trailing_dot_or_space"
	| "invalid_characters"
	| "case_collision";

export interface PathSafetyError {
	code: PathSafetyErrorCode;
	path: string;
	/** Offending segment for segment-level errors. */
	segment?: string;
	/** The earlier path this one collides with (case_collision only). */
	collidesWith?: string;
}

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9 — reserved on Windows regardless of extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Characters invalid in Windows file names, plus ASCII control characters. */
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

/**
 * Validate a single manifest path. Returns null when safe.
 */
export function validateManifestPath(path: string): PathSafetyError | null {
	if (path.length === 0) return { code: "empty", path };
	if (path.includes("\\")) return { code: "backslash", path };
	if (path.startsWith("/")) return { code: "absolute", path };
	if (/^[a-zA-Z]:/.test(path)) return { code: "drive_letter", path };
	if (INVALID_CHARS.test(path)) return { code: "invalid_characters", path };

	for (const segment of path.split("/")) {
		if (segment.length === 0) return { code: "empty_segment", path, segment };
		if (segment === "..") return { code: "traversal", path, segment };
		if (segment === ".") return { code: "dot_segment", path, segment };
		if (segment.endsWith(".") || segment.endsWith(" ")) {
			return { code: "trailing_dot_or_space", path, segment };
		}
		if (WINDOWS_RESERVED.test(segment)) {
			return { code: "reserved_name", path, segment };
		}
	}
	return null;
}

/**
 * Validate a set of manifest paths, including case-insensitive collision
 * detection (macOS and Windows filesystems are case-insensitive).
 * Returns all errors; an empty array means the set is safe.
 */
export function validateManifestPaths(paths: readonly string[]): PathSafetyError[] {
	const errors: PathSafetyError[] = [];
	const seen = new Map<string, string>();
	for (const path of paths) {
		const error = validateManifestPath(path);
		if (error) {
			errors.push(error);
			continue;
		}
		const folded = path.toLowerCase();
		const existing = seen.get(folded);
		if (existing !== undefined && existing !== path) {
			errors.push({ code: "case_collision", path, collidesWith: existing });
		} else {
			seen.set(folded, path);
		}
	}
	return errors;
}

/**
 * Convert a validated POSIX manifest path to a native path under root.
 * Throws if the path was not validated first.
 */
export function toNativePath(root: string, manifestPath: string): string {
	const error = validateManifestPath(manifestPath);
	if (error) {
		throw new Error(`unsafe manifest path (${error.code}): ${manifestPath}`);
	}
	return join(root, ...manifestPath.split("/"));
}

/**
 * Resolve `candidate` (relative or absolute) and assert it stays inside
 * `root` after symlink resolution. Used by the read-only file service.
 * Returns the real, contained absolute path or throws.
 */
export async function resolveWithin(root: string, candidate: string): Promise<string> {
	const rootReal = await realpath(root);
	const target = resolve(rootReal, candidate);
	// Resolve symlinks on the deepest existing ancestor so a symlink escape
	// cannot hide behind a not-yet-created leaf.
	const targetReal = await realpathDeepest(target);
	if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
		throw new Error(`path escapes root: ${candidate}`);
	}
	return targetReal;
}

async function realpathDeepest(target: string): Promise<string> {
	let probe = target;
	const suffixes: string[] = [];
	// Walk up until an existing ancestor is found, then re-append the suffix.
	// Bounded by path depth.
	for (;;) {
		try {
			const real = await realpath(probe);
			return suffixes.length === 0 ? real : join(real, ...suffixes.reverse());
		} catch {
			const parent = resolve(probe, "..");
			if (parent === probe) throw new Error(`no existing ancestor for: ${target}`);
			suffixes.push(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			probe = parent;
		}
	}
}
