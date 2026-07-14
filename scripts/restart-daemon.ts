#!/usr/bin/env -S npx tsx
// Restart the Scion PTY daemon for THIS data dir: stop the running daemon and
// spawn a fresh one so it picks up new code. Scoped to this instance via its
// socket, so daemons of other checkouts/instances are left alone.
//
// WARNING: restarting the daemon closes every PTY it owns — all live agents
// under it (possibly including the session you run this from) are terminated.
// Worktrees, branches, and DB state are untouched.
//
// In supervisor / PTY-host mode this script refuses to run: there the
// supervisor owns the daemon's lifecycle and already restarts it WITHOUT
// killing agents (just `pkill -f src/daemon/index.ts` and it respawns). This
// script is for the default single-process daemon only.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DAEMON_LOG, DAEMON_SOCK, DATA_DIR, PTY_HOST_SOCK } from "../src/config.ts";

const ROOT = join(import.meta.dirname, "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
const DAEMON_ENTRY = "src/daemon/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if something is actually listening on the unix socket (not just a
 * leftover socket file). */
function socketAlive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const c = createConnection(path)
			.on("connect", () => {
				c.destroy();
				resolve(true);
			})
			.on("error", () => resolve(false));
	});
}

/** PID of the process listening on a unix socket, via lsof; null if none. */
function listenerPid(sockPath: string): number | null {
	try {
		const out = execFileSync("lsof", ["-t", sockPath], { encoding: "utf8" }).trim();
		const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null; // lsof exits non-zero when nothing has the socket open
	}
}

async function main(): Promise<void> {
	if (await socketAlive(PTY_HOST_SOCK)) {
		console.error(
			"[restart-daemon] a PTY host is running (supervisor mode). The supervisor\n" +
				"owns the daemon's lifecycle — `pkill -f src/daemon/index.ts` and it\n" +
				"respawns the daemon without losing agents. This script is for the\n" +
				"default single-process daemon only; refusing to run.",
		);
		process.exit(1);
	}

	// 1. Stop the running daemon for this instance (found via its own socket, so
	//    we never signal another checkout's daemon).
	const pid = listenerPid(DAEMON_SOCK);
	if (pid) {
		console.log(`[restart-daemon] stopping daemon pid ${pid} (SIGTERM)`);
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		let stopped = false;
		for (let i = 0; i < 30; i++) {
			if (!(await socketAlive(DAEMON_SOCK))) {
				stopped = true;
				break;
			}
			await sleep(100);
		}
		if (!stopped) {
			console.log("[restart-daemon] still up after 3s, sending SIGKILL");
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
			await sleep(300);
		}
	} else {
		console.log("[restart-daemon] no daemon currently listening — starting one");
	}

	// 2. Remove a stale socket file. A SIGKILL'd daemon can't unlink its own
	//    socket, and a fresh daemon would misread the leftover file as "another
	//    daemon already listening" and bail.
	if (existsSync(DAEMON_SOCK)) rmSync(DAEMON_SOCK, { force: true });

	// 3. Spawn a fresh daemon, detached, exactly as the app auto-spawns it
	//    (see spawnDaemonDetached in src/engine/ptyBackend.ts).
	mkdirSync(DATA_DIR, { recursive: true });
	const logFd = openSync(DAEMON_LOG, "a");
	try {
		const child = spawn(TSX_BIN, [DAEMON_ENTRY], {
			cwd: ROOT,
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
		child.unref();
		console.log(`[restart-daemon] spawned new daemon pid ${child.pid}`);
	} finally {
		closeSync(logFd);
	}

	// 4. Wait until it's accepting connections before returning success.
	for (let i = 0; i < 50; i++) {
		if (await socketAlive(DAEMON_SOCK)) {
			console.log("[restart-daemon] daemon is up and listening ✓");
			process.exit(0);
		}
		await sleep(100);
	}
	console.error(`[restart-daemon] daemon did not come up within 5s — check ${DAEMON_LOG}`);
	process.exit(1);
}

void main();
