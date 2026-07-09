#!/usr/bin/env -S npx tsx
// Web-server entry point — an alternative to src/index.tsx (Ink) that boots
// the same engine (db, status store, engine store, hook receiver) and serves
// the web UI over HTTP + WebSocket instead of rendering a terminal UI.
// Run one front-end at a time: Ink and this server are separate processes
// with separate in-memory PTY state (src/engine/pty.ts module singleton).
import { existsSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { DATA_DIR, DB_PATH, INSTALLED_MARKER, WEB_PORT } from "../config.ts";
import { createDb } from "../db/db.ts";
import { killAll } from "../engine/pty.ts";
import { createStatusStore } from "../engine/status.ts";
import { startHookServer } from "../hookServer.ts";
import { installClaudeHooks } from "../setup/installClaudeHooks.ts";
import { createStore } from "../store/projects.ts";
import { createServerApp } from "./app.ts";

async function main() {
	if (!existsSync(INSTALLED_MARKER)) {
		installClaudeHooks();
		writeFileSync(INSTALLED_MARKER, new Date().toISOString());
		console.log(`[scion] installed Claude hooks; data dir ${DATA_DIR}`);
	}

	const db = createDb(DB_PATH);
	const status = createStatusStore(db);
	const store = createStore(db, status);
	const hookServer = await startHookServer(status);

	const { app, injectWebSocket } = createServerApp({ store, status });

	const httpServer = serve({ fetch: app.fetch, port: WEB_PORT }, (info) => {
		console.log(`[scion] web server listening on http://localhost:${info.port}`);
	});
	injectWebSocket(httpServer);

	const shutdown = () => {
		try {
			killAll();
		} catch {}
		try {
			hookServer.close();
		} catch {}
		try {
			httpServer.close();
		} catch {}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[scion] fatal:", err);
	process.exit(1);
});
