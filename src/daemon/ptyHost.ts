#!/usr/bin/env -S npx tsx
// The DURABLE PTY host (opt-in, launched only by src/daemon/supervisor.ts).
//
// This is the process that actually owns every live agent's node-pty master
// fd — plus the hook receiver and the status DB, so the whole "who is this
// terminal / what's it doing" story stays consistent while the front-end-
// facing daemon comes and goes. It is deliberately the ONE process that must
// not die while agents are alive: as long as it holds the master fds open, the
// children never get SIGHUP, so a crash/restart of the daemon (its only client)
// leaves the agents running untouched.
//
// Structurally it's the same shape as the classic single-process daemon
// (src/daemon/index.ts's non-host branch), just bound to PTY_HOST_SOCK instead
// of DAEMON_SOCK and idle-exiting purely on "no sessions" (the daemon's control
// connection is transient — it drops on every daemon restart — so it must NOT
// count toward keeping the host alive).
import { existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import { DB_PATH, PTY_HOST_SOCK } from "../config.ts";
import { createDb } from "../db/db.ts";
import { inProcessPtyBackend } from "../engine/ptyBackend.ts";
import { killAll, listSessions } from "../engine/pty.ts";
import { createStatusStore } from "../engine/status.ts";
import { getHookUrl } from "../hookAddr.ts";
import { startHookServer } from "../hookServer.ts";
import { startSocketServer } from "./socketServer.ts";

const IDLE_EXIT_MS = 30_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 500;

/** A bare successful connect proves something is already bound and listening. */
function pingExistingHost(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(PTY_HOST_SOCK);
		let settled = false;
		const finish = (alive: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(alive);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		setTimeout(() => finish(false), PING_TIMEOUT_MS);
	});
}

async function main() {
	if (await pingExistingHost()) {
		// Another host is already up — nothing to do.
		process.exit(0);
	}
	// A stale socket FILE (host died without cleaning up) makes listen() throw
	// EADDRINUSE regardless of whether anyone's actually listening — unlink it.
	if (existsSync(PTY_HOST_SOCK)) {
		try {
			unlinkSync(PTY_HOST_SOCK);
		} catch {
			// Ignore — listen() below will surface any real problem.
		}
	}

	const db = createDb(DB_PATH, { reconcile: true });
	const status = createStatusStore(db);
	const hookServer = await startHookServer(status);
	// Logged (into PTY_HOST_LOG) so tooling in a separate process can discover
	// the real, possibly-ephemeral-fallback hook port without guessing.
	console.log(`[scion-pty-host] hook receiver at ${getHookUrl()}`);

	let idleTimer: NodeJS.Timeout | null = null;
	let socketHandle: Awaited<ReturnType<typeof startSocketServer>> | null = null;

	function shutdown() {
		if (idleTimer) clearInterval(idleTimer);
		// Killing the agents here IS the intended behavior for the host: it only
		// shuts down when idle (no sessions) or on an explicit signal/RPC, i.e.
		// when there's nothing left to protect.
		try {
			killAll();
		} catch {}
		try {
			socketHandle?.server.close();
		} catch {}
		try {
			hookServer.close();
		} catch {}
		try {
			unlinkSync(PTY_HOST_SOCK);
		} catch {}
		process.exit(0);
	}

	try {
		socketHandle = await startSocketServer(PTY_HOST_SOCK, inProcessPtyBackend, status, shutdown);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			// Lost a startup race to another host instance — it already won.
			console.log("[scion-pty-host] another instance won the race to bind; exiting");
			hookServer.close();
			process.exit(0);
		}
		throw err;
	}

	console.log(`[scion-pty-host] listening on ${PTY_HOST_SOCK} (pid ${process.pid})`);

	// Idle-exit on NO SESSIONS only. The daemon's control connection is
	// intentionally ignored: it disconnects on every daemon restart, and we
	// must keep the host (and its agents) alive across exactly those gaps.
	let idleSince: number | null = null;
	idleTimer = setInterval(() => {
		if (listSessions().length > 0) {
			idleSince = null;
			return;
		}
		if (idleSince === null) {
			idleSince = Date.now();
			return;
		}
		if (Date.now() - idleSince >= IDLE_EXIT_MS) {
			console.log("[scion-pty-host] idle with no sessions — shutting down");
			shutdown();
		}
	}, IDLE_CHECK_INTERVAL_MS);
	idleTimer.unref();

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[scion-pty-host] fatal:", err);
	process.exit(1);
});
