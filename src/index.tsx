#!/usr/bin/env -S npx tsx
// Scion entry point. Runs under Node via tsx (node-pty + better-sqlite3
// need Node's native-addon loader; they don't work under Bun).
// Boot order: setup-if-needed → open+migrate SQLite → connect to the PTY
// daemon (auto-spawned if not already running) → render the Ink TUI in a
// loop that hands off to raw terminal takeovers (attach / diff pager) and
// re-renders afterward.
import { existsSync, writeFileSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { DATA_DIR, DB_PATH, INSTALLED_MARKER } from "./config.ts";
import { createDb } from "./db/db.ts";
import { createDaemonPtyBackend, type PtyBackend } from "./engine/ptyBackend.ts";
import { createStatusStore } from "./engine/status.ts";
import { installClaudeHooks } from "./setup/installClaudeHooks.ts";
import { createStore } from "./store/projects.ts";
import { App } from "./ui/App.tsx";
import { runAttach } from "./ui/attach.ts";
import { runDiffPager } from "./ui/diffPager.ts";
import type { ExitAction } from "./ui/types.ts";

async function runInkApp(
	store: ReturnType<typeof createStore>,
	status: ReturnType<typeof createStatusStore>,
	backend: PtyBackend,
	initialProjectId: string | undefined,
): Promise<ExitAction> {
	let result: ExitAction = { type: "quit" };
	let unmount = () => {};
	const requestExit = (action: ExitAction) => {
		result = action;
		unmount();
	};
	const instance = render(
		React.createElement(App, { store, status, backend, requestExit, initialProjectId }),
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
	// relay its push so this process's own status.events (which Dashboard
	// already listens on) fires exactly as if the change happened locally.
	backend.onStatusChanged((workspaceId) => status.events.emit("change", workspaceId));

	const shutdown = () => {
		// Deliberately no killAll() here — the daemon owns every live agent
		// now, and restarting this process must not kill them.
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	let initialProjectId: string | undefined;

	// Reopen whatever was open last time, same as pressing Enter on it from
	// the Dashboard — if it's gone (deleted since), or anything else about
	// resuming it fails, just fall through to the normal Projects screen
	// rather than blocking startup on it.
	const lastOpenedId = store.getSettings().lastOpenedWorkspaceId;
	if (lastOpenedId) {
		const workspace = store.getWorkspace(lastOpenedId);
		if (workspace) {
			try {
				const live = (await backend.listSessions(workspace.id)).find((s) => !s.exited);
				const terminalId =
					live?.id ?? (await store.resumeWorkspace({ workspaceId: workspace.id })).terminalId;
				status.markSeen(workspace.id);
				await runAttach(terminalId, backend);
				initialProjectId = workspace.projectId;
			} catch {
				// leave initialProjectId unset — just start at the Projects screen
			}
		}
	}

	for (;;) {
		const action = await runInkApp(store, status, backend, initialProjectId);
		if (action.type === "quit") break;
		if (action.type === "attach") {
			await runAttach(action.terminalId, backend);
			initialProjectId = action.projectId;
		} else if (action.type === "diff") {
			await runDiffPager(action.repoPath, action.worktreePath);
			initialProjectId = action.projectId;
		}
	}

	shutdown();
}

main().catch((err) => {
	console.error("[scion] fatal:", err);
	process.exit(1);
});
