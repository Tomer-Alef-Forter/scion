import { defineConfig } from "vitest/config";

// Browser-environment unit tests for web/src (WebSocket client
// reconnect/backoff logic, etc). jsdom supplies window/document; any
// WebSocket used in tests is a hand-rolled fake (see test files) rather
// than jsdom's own, so timing/framing stay fully under test control.
export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
	},
});
