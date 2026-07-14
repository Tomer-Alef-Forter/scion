import { defineConfig } from "vitest/config";

// Covers src/** only (the Node-side engine/daemon code: argv builders,
// branch naming, path-traversal guard, daemon frame protocol). web/ is a
// fully separate package (its own package.json/bun.lock, no shared
// node_modules with root), so its browser-environment tests live in their
// own web/vitest.config.ts instead of being folded in here — a single
// config would need web's own deps resolvable from root, which they aren't.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
	},
});
