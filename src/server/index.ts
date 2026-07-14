#!/usr/bin/env -S npx tsx
// Web-server entry point — an alternative to src/index.tsx (Ink) that boots
// the same engine (db, status store, engine store) and serves the web UI
// over HTTP + WebSocket instead of rendering a terminal UI. PTYs and the hook
// receiver live in a separate daemon process (src/daemon/*, auto-spawned by
// createDaemonPtyBackend) — Ink and this server can now both run at once,
// and either can restart without killing live agents, since neither owns
// them anymore.
import { existsSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import {
	AUTH_TOKEN_PATH,
	DATA_DIR,
	DB_PATH,
	INSTALLED_MARKER,
	isLoopbackHost,
	WEB_HOST,
	WEB_PORT,
} from "../config.ts";
import { createDb } from "../db/db.ts";
import { createDaemonPtyBackend } from "../engine/ptyBackend.ts";
import { createStatusStore } from "../engine/status.ts";
import { installClaudeHooks } from "../setup/installClaudeHooks.ts";
import { createStore } from "../store/projects.ts";
import { createServerApp } from "./app.ts";
import { loadOrCreateAuthToken } from "./auth.ts";

async function main() {
	if (!existsSync(INSTALLED_MARKER)) {
		installClaudeHooks();
		writeFileSync(INSTALLED_MARKER, new Date().toISOString());
		console.log(`[scion] installed Claude hooks; data dir ${DATA_DIR}`);
	}

	// PTYs and the hook receiver now live in a separate daemon process (auto-
	// spawned here if not already running) — this process just reads/writes
	// the DB and proxies terminal I/O to the daemon, so restarting it never
	// kills a live agent.
	const db = createDb(DB_PATH);
	const status = createStatusStore(db);
	const backend = createDaemonPtyBackend();
	const store = createStore(db, status, backend);

	// The daemon's StatusStore is a separate object in a separate process —
	// relay its push so this process's own status.events (which ws-events.ts
	// already listens on) fires exactly as if the change happened locally.
	backend.onStatusChanged((workspaceId) => status.events.emit("change", workspaceId));

	// Loopback (the default) is a same-machine trust model — no token needed.
	// Any non-loopback bind (SCION_HOST=0.0.0.0 or a concrete LAN IP) exposes
	// the control surface to the network, so we require a shared-secret token.
	const loopbackOnly = isLoopbackHost(WEB_HOST);
	const authToken = loopbackOnly ? null : loadOrCreateAuthToken();

	const { app, injectWebSocket } = createServerApp({ store, status, backend, authToken });

	const httpServer = serve({ fetch: app.fetch, port: WEB_PORT, hostname: WEB_HOST }, (info) => {
		if (loopbackOnly) {
			console.log(`[scion] web server listening on http://localhost:${info.port} (localhost only)`);
		} else {
			console.log(`[scion] web server listening on http://${WEB_HOST}:${info.port} (NETWORK-EXPOSED)`);
			console.log(`[scion] auth required — open the UI with the token in the URL, e.g.:`);
			console.log(`[scion]   http://<this-host>:${info.port}/?token=${authToken}`);
			console.log(`[scion] token stored at ${AUTH_TOKEN_PATH}`);
		}
	});
	injectWebSocket(httpServer);

	const shutdown = () => {
		// Deliberately no killAll() here — the daemon owns every live agent
		// now, and restarting this process must not kill them.
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
