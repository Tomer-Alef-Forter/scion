// Wires the REST API + both WebSocket routes onto one Hono app. Reuses
// store/status exactly as the Ink TUI does — this file adds no engine logic,
// only transport.
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { StatusStore } from "../engine/status.ts";
import type { Store } from "../store/projects.ts";
import { createApiRoutes } from "./api.ts";
import { createEventsSocketHandlers } from "./ws-events.ts";
import { createTerminalSocketHandlers } from "./ws-terminal.ts";

export interface CreateServerAppArgs {
	store: Store;
	status: StatusStore;
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createServerApp({ store, status }: CreateServerAppArgs) {
	const app = new Hono();
	const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

	// Single-user local tool bound to 127.0.0.1 — this just allows the Vite
	// dev server (a different localhost port) to call the API in dev.
	app.use(
		"*",
		cors({
			origin: (origin) => (origin && LOCALHOST_ORIGIN.test(origin) ? origin : ""),
		}),
	);

	app.route("/api", createApiRoutes({ store, status }));

	app.get(
		"/ws/terminal/:terminalId",
		upgradeWebSocket((c) =>
			createTerminalSocketHandlers(c.req.param("terminalId") ?? "", {
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
