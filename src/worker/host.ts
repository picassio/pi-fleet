/**
 * Bundle extension hosting.
 *
 * `resources_discover` covers skills/prompts/themes but not extensions, so
 * the fleet extension acts as the host: bundle extension modules (default
 * export = factory receiving ExtensionAPI) are loaded with jiti and invoked
 * against the fleet extension's own `pi` handle. See docs/plan.md.
 */
import { createJiti } from "jiti";

export interface BundleExtensionLoadResult {
	path: string;
	ok: boolean;
	error?: string;
}

type ExtensionFactory = (pi: unknown) => void | Promise<void>;

/**
 * Load and invoke bundle extension modules. One failing module does not
 * prevent the others from loading; failures are reported per module.
 */
export async function loadBundleExtensions(
	paths: readonly string[],
	pi: unknown,
): Promise<BundleExtensionLoadResult[]> {
	if (paths.length === 0) return [];
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const results: BundleExtensionLoadResult[] = [];

	for (const path of paths) {
		try {
			const module = (await jiti.import(path)) as { default?: ExtensionFactory } | ExtensionFactory;
			const factory =
				typeof module === "function" ? module : typeof module?.default === "function" ? module.default : null;
			if (factory === null) {
				results.push({ path, ok: false, error: "module has no default export function" });
				continue;
			}
			await factory(pi);
			results.push({ path, ok: true });
		} catch (error) {
			results.push({
				path,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}
