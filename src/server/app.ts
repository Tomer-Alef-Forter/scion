// Wires the REST API + both WebSocket routes onto one Hono app. Reuses
// store/status exactly as the Ink TUI does — this file adds no engine logic,
// only transport.
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { PtyBackend } from "../engine/ptyBackend.ts";
import type { StatusStore } from "../engine/status.ts";
import type { Store } from "../store/projects.ts";
import { createApiRoutes } from "./api.ts";
import { createAuthMiddleware } from "./auth.ts";
import { createEventsSocketHandlers } from "./ws-events.ts";
import { createTerminalSocketHandlers } from "./ws-terminal.ts";

export interface CreateServerAppArgs {
	store: Store;
	status: StatusStore;
	backend: PtyBackend;
	/**
	 * Shared-secret token required on /api/* and /ws/* when set. Pass this ONLY
	 * when the server is bound to a non-loopback host (see src/server/index.ts);
	 * pass null/undefined for the default loopback-only, same-machine trust model.
	 */
	authToken?: string | null;
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createServerApp({ store, status, backend, authToken }: CreateServerAppArgs) {
	const app = new Hono();
	const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

	// DEFENSE IN DEPTH ONLY — NOT a security boundary. `Origin` is a browser
	// convention: it stops a malicious web page in someone's browser from
	// scripting this API cross-origin, but does nothing against a direct curl
	// or raw WebSocket client that simply omits/forges the header. The real
	// boundary is the loopback bind + the bearer-token auth below (see
	// src/server/auth.ts). This just keeps the Vite dev server (a different
	// localhost port) able to call the API in dev.
	app.use(
		"*",
		cors({
			origin: (origin) => (origin && LOCALHOST_ORIGIN.test(origin) ? origin : ""),
		}),
	);

	// When exposed beyond loopback, require the shared secret on every API and
	// WebSocket request. Registered before the routes so it runs first; a 401
	// here means the /ws upgrade never happens. Static asset serving (the app
	// shell) is intentionally left open — it's inert without the token, and the
	// user hands the token to the browser via `?token=...` on first load.
	if (authToken) {
		const requireAuth = createAuthMiddleware(authToken);
		app.use("/api/*", requireAuth);
		app.use("/ws/*", requireAuth);
	}

	app.route("/api", createApiRoutes({ store, status, backend }));

	app.get(
		"/ws/terminal/:terminalId",
		upgradeWebSocket((c) =>
			createTerminalSocketHandlers(c.req.param("terminalId") ?? "", backend, {
				skipReplay: c.req.query("replay") === "0",
			}),
		),
	);

	app.get(
		"/ws/events",
		upgradeWebSocket(() => createEventsSocketHandlers(status)),
	);

	// Production: serve the built frontend from this same server/port (`bun
	// run web`). In dev (`bun run web:dev`) Vite serves the frontend itself
	// and proxies /api + /ws here — this middleware simply 404s harmlessly if
	// web/dist doesn't exist yet. Root is relative to the process's cwd
	// (the repo root, since that's where `tsx src/server/index.ts` runs from).
	app.use("*", serveStatic({ root: "./web/dist" }));

	return { app, injectWebSocket };
}
