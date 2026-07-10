import { defineConfig } from "vitest/config";

// Loopback suites spawn real child processes and TCP servers; shared CI
// runners (macOS/Windows) need far more headroom than vitest's 5s default.
export default defineConfig({
	test: {
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
