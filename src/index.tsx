#!/usr/bin/env -S npx tsx
// superset-local entry point. Runs under Node via tsx (node-pty + better-sqlite3
// need Node's native-addon loader; they don't work under Bun).
// Boot order: setup-if-needed → open+migrate SQLite → start hook server →
// render the Ink TUI in a loop that hands off to raw terminal takeovers
// (attach / diff pager) and re-renders afterward.
import { existsSync, writeFileSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { DATA_DIR, DB_PATH, INSTALLED_MARKER } from "./config.ts";
import { createDb } from "./db/db.ts";
import { killAll } from "./engine/pty.ts";
import { createStatusStore } from "./engine/status.ts";
import { startHookServer } from "./hookServer.ts";
import { installClaudeHooks } from "./setup/installClaudeHooks.ts";
import { createStore } from "./store/projects.ts";
import { App } from "./ui/App.tsx";
import { runAttach } from "./ui/attach.ts";
import { runDiffPager } from "./ui/diffPager.ts";
import type { ExitAction } from "./ui/types.ts";

async function runInkApp(
	store: ReturnType<typeof createStore>,
	status: ReturnType<typeof createStatusStore>,
	initialProjectId: string | undefined,
): Promise<ExitAction> {
	let result: ExitAction = { type: "quit" };
	let unmount = () => {};
	const requestExit = (action: ExitAction) => {
		result = action;
		unmount();
	};
	const instance = render(
		React.createElement(App, { store, status, requestExit, initialProjectId }),
	);
	unmount = instance.unmount;
	await instance.waitUntilExit();
	return result;
}

async function main() {
	// First-run setup: install Claude hooks + notify.sh.
	if (!existsSync(INSTALLED_MARKER)) {
		installClaudeHooks();
		writeFileSync(INSTALLED_MARKER, new Date().toISOString());
		console.log(`[superset-local] installed Claude hooks; data dir ${DATA_DIR}`);
	}

	const db = createDb(DB_PATH);
	const status = createStatusStore(db);
	const store = createStore(db, status);
	const server = await startHookServer(status);

	const shutdown = () => {
		try {
			killAll();
		} catch {}
		try {
			server.close();
		} catch {}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	let initialProjectId: string | undefined;
	for (;;) {
		const action = await runInkApp(store, status, initialProjectId);
		if (action.type === "quit") break;
		if (action.type === "attach") {
			await runAttach(action.terminalId);
			initialProjectId = action.projectId;
		} else if (action.type === "diff") {
			await runDiffPager(action.repoPath, action.worktreePath);
			initialProjectId = action.projectId;
		}
	}

	shutdown();
}

main().catch((err) => {
	console.error("[superset-local] fatal:", err);
	process.exit(1);
});
