#!/usr/bin/env -S npx tsx
// Headless smoke test for the PTY daemon (src/daemon/*): spawn, attach
// (scrollback replay + live streaming), multi-client fan-out, detach-doesn't-
// kill, kill -> status-changed push, and the single-instance guard.
//
// Exercises the REAL Unix-socket protocol via createDaemonPtyBackend — the
// exact client path production front-ends use — plus a directly-spawned
// second daemon process to prove the single-instance guard actually works
// (the backend's own connect-or-spawn logic would never trigger that path
// itself, since it just reuses an already-running daemon rather than
// starting a redundant one).
//
// IMPORTANT: the daemon is deliberately detached so it survives its spawner —
// which means it would otherwise keep running against this test's isolated
// $HOME after run-isolated.ts deletes that directory (the exact class of bug
// behind an earlier real data-loss incident in this repo, just in a new
// guise: a leaked daemon process accumulating on every test run). This test
// explicitly shuts the daemon down via backend.shutdownDaemon() in `finally`.
// Run: `bun run daemon-smoke`.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_LOG, DAEMON_SOCK, DB_PATH } from "../src/config.ts";
import { createDb } from "../src/db/db.ts";
import { projects, terminalSessions, workspaces } from "../src/db/schema.ts";
import { createDaemonPtyBackend } from "../src/engine/ptyBackend.ts";

if (!process.env.SL_ISOLATED_HOME) {
	console.error(
		"refusing to run: this script must be invoked via `bun run daemon-smoke` " +
			"(scripts/run-isolated.ts), not `tsx scripts/daemon-smoke.ts` directly " +
			"— it spawns a real, detached daemon process against an isolated $HOME.",
	);
	process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
	if (ok) {
		passed++;
		console.log(`✅ ${name}`);
	} else {
		failed++;
		console.error(`❌ ${name}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the daemon's resolved hook URL out of its log — it runs in a
 * separate process from this test, so getHookUrl() here would only ever
 * return the (possibly wrong, if the fixed HOOK_PORT was taken) default.
 */
function discoverHookUrl(): string {
	const log = readFileSync(DAEMON_LOG, "utf8");
	const match = log.match(/hook receiver at (\S+)/);
	if (!match) throw new Error(`could not find the daemon's hook URL in ${DAEMON_LOG}`);
	return match[1];
}

async function waitFor(
	// Generous default so a cold daemon auto-spawn (tsx + node-pty startup) on a
	// slow/loaded CI runner doesn't flake this. Polling returns the instant the
	// condition holds, so a high ceiling costs nothing when things are working.
	fn: () => Promise<boolean> | boolean,
	timeoutMs = 15000,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await fn()) return true;
		if (Date.now() > deadline) return false;
		await sleep(intervalMs);
	}
}

async function main() {
	const backend = createDaemonPtyBackend();

	try {
		// ---- spawn + attach: scrollback replay + live streaming ----
		const terminalId = randomUUID();
		const workspaceId = "daemon-smoke-workspace";
		await backend.spawnSession({
			id: terminalId,
			workspaceId,
			file: "bash",
			args: ["-c", "echo hello-from-daemon; sleep 5"],
			cwd: process.cwd(),
		});

		check("daemon socket file exists after auto-spawn", existsSync(DAEMON_SOCK));

		const handle1 = await backend.attach(terminalId);
		check("attach() returns a handle for a live session", handle1 !== null);

		let handle1Data = "";
		handle1?.onData((chunk) => {
			handle1Data += chunk;
		});
		const gotInitialOutput = await waitFor(() => handle1Data.includes("hello-from-daemon"));
		check("attach delivers the PTY's output (replay/live streaming)", gotInitialOutput);

		// ---- second attach: fan-out (both clients see live output) ----
		const handle2 = await backend.attach(terminalId, { skipReplay: true });
		check("a second attach to the same terminal succeeds", handle2 !== null);
		let handle2Data = "";
		handle2?.onData((chunk) => {
			handle2Data += chunk;
		});
		handle1?.write("echo fan-out-check\n");
		const fanOutOk = await waitFor(() => handle2Data.includes("fan-out-check"));
		check("both attached clients see the same live output (fan-out)", fanOutOk);

		// ---- detach doesn't kill ----
		handle2?.close();
		await sleep(200);
		const stillAliveAfterDetach = (await backend.listSessions(workspaceId)).find(
			(s) => s.id === terminalId,
		);
		check(
			"detaching a client (close()) does not kill the session",
			stillAliveAfterDetach !== undefined && stillAliveAfterDetach.exited === false,
		);

		// ---- status-changed push: real hook event -> daemon's status store
		// -> relayed over the control socket to every connected client ----
		// recordEvent() inserts into terminal_agent_bindings, which has a
		// foreign key back to terminal_sessions (and that to workspaces ->
		// projects) — rows this test's direct backend.spawnSession() call
		// never created (only the real Store layer does, alongside spawning).
		// Insert the minimal chain directly so the hook POST below succeeds
		// exactly as it would in production.
		const db = createDb(DB_PATH);
		const projectId = "daemon-smoke-project";
		db.insert(projects)
			.values({
				id: projectId,
				name: "daemon-smoke",
				repoPath: "/tmp/daemon-smoke-repo",
				defaultBranch: null,
				worktreeBaseDir: null,
				createdAt: Date.now(),
			})
			.run();
		db.insert(workspaces)
			.values({
				id: workspaceId,
				projectId,
				worktreePath: "/tmp/daemon-smoke-repo",
				branch: "daemon-smoke",
				baseBranch: null,
				name: "daemon-smoke-workspace",
				type: "worktree",
				agentType: "claude",
				createdAt: Date.now(),
			})
			.run();
		db.insert(terminalSessions)
			.values({
				id: terminalId,
				workspaceId,
				status: "active",
				createdAt: Date.now(),
				endedAt: null,
			})
			.run();

		let statusChangedFor: string | null = null;
		const unsubscribeStatus = backend.onStatusChanged((wsId) => {
			statusChangedFor = wsId;
		});

		const hookUrl = discoverHookUrl();
		const hookRes = await fetch(hookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				json: { terminalId, eventType: "Start", agent: { agentId: "claude" } },
			}),
		});
		check("daemon's hook receiver accepts a real hook POST", hookRes.status === 200);
		const gotHookPush = await waitFor(() => statusChangedFor === workspaceId);
		check("a hook event pushes a status-changed event for its workspace", gotHookPush);

		// Now a terminal_agent_bindings row exists for this terminal (created by
		// the hook POST above), so killing it should push a SECOND change —
		// markExited() cleaning that binding up.
		statusChangedFor = null;
		await backend.killSession(terminalId);
		const gotExitPush = await waitFor(() => statusChangedFor === workspaceId);
		check("killing a tracked session pushes a status-changed event on cleanup", gotExitPush);
		unsubscribeStatus();

		const exitedAfterKill = (await backend.listSessions(workspaceId)).find(
			(s) => s.id === terminalId,
		);
		check("session reports exited after kill", exitedAfterKill?.exited === true);

		handle1?.close();

		// ---- single-instance guard: a second daemon process exits cleanly ----
		const ROOT = join(import.meta.dirname, "..");
		const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
		let secondInstanceExitCode: number | null = 0;
		try {
			execFileSync(TSX_BIN, ["src/daemon/index.ts"], {
				cwd: ROOT,
				stdio: "pipe",
				timeout: 5000,
			});
		} catch (err) {
			secondInstanceExitCode = (err as { status?: number | null }).status ?? -1;
		}
		check(
			"a second daemon instance detects the first and exits cleanly (0)",
			secondInstanceExitCode === 0,
		);

		const stillReachable = await waitFor(async () => {
			try {
				await backend.listSessions();
				return true;
			} catch {
				return false;
			}
		}, 1000);
		check("the original daemon is still reachable after the single-instance check", stillReachable);
	} finally {
		await backend.shutdownDaemon().catch(() => {});
	}

	console.log();
	if (failed === 0) {
		console.log("ALL PASSED");
		process.exit(0);
	}
	console.error(`${failed} check(s) FAILED, ${passed} passed`);
	process.exit(1);
}

main().catch((err) => {
	console.error("[daemon-smoke] fatal:", err);
	process.exit(1);
});
