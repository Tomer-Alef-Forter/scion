#!/usr/bin/env -S npx tsx
// PTY daemon entry point. Owns every live agent's node-pty process, the hook
// receiver, and status writes — decoupled from whichever front-end (Ink or
// web) happens to be running, so restarting/crashing a front-end no longer
// kills agents. Auto-spawned by engine/ptyBackend.ts's createDaemonPtyBackend
// when no daemon is already listening; not meant to be launched by a user
// directly (though `tsx src/daemon/index.ts` works fine for debugging).
//
// Blast radius (deliberate, v1): this is a SINGLE process hosting every
// project's PTYs, so an UNEXPECTED crash of it still takes down every live
// agent across every project at once — closing the daemon closes every PTY
// master fd, which SIGHUPs the child on the other end. That residual risk is
// inherent to the single-process design; surviving a daemon crash too would
// need real fd-passing (SCM_RIGHTS), a separate, larger effort. Front-end
// restarts are already safe (they don't own the PTYs).
//
// What IS isolated between projects: every node-pty child is its own OS
// session (forkpty() setsid()s it) and sessions are tracked + killed
// individually, so an INTENTIONAL / targeted stop can hit just one project's
// or one workspace's agents without signalling any other project's. See
// src/server/api.ts: POST /projects/:id/agents/stop and
// /workspaces/:id/agents/stop are the scoped stops; killAll() below (reached
// only via the explicit global /daemon/shutdown) is the "stop everything"
// path that also stops this whole process.
import { existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import { DAEMON_SOCK, DB_PATH } from "../config.ts";
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

/** A bare successful connect is proof enough that something is bound and listening. */
function pingExistingDaemon(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(DAEMON_SOCK);
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
	if (await pingExistingDaemon()) {
		// Another daemon is already up — nothing to do.
		process.exit(0);
	}
	// A stale socket FILE (daemon died without cleaning up) makes `listen()`
	// throw EADDRINUSE unconditionally, regardless of whether anyone's
	// actually listening — must unlink it ourselves first.
	if (existsSync(DAEMON_SOCK)) {
		try {
			unlinkSync(DAEMON_SOCK);
		} catch {
			// Ignore — listen() below will surface any real problem.
		}
	}

	const db = createDb(DB_PATH, { reconcile: true });
	const status = createStatusStore(db);
	const hookServer = await startHookServer(status);
	// Logged (into DAEMON_LOG) so tooling — e.g. scripts/daemon-smoke.ts, which
	// runs in a separate process from the daemon and so can't just call
	// getHookUrl() itself — can discover the real, possibly-ephemeral-
	// fallback port without guessing.
	console.log(`[scion-daemon] hook receiver at ${getHookUrl()}`);

	// Declared before startSocketServer (which needs `shutdown` to wire the
	// "shutdown" RPC — used by tests/tooling to stop a daemon deterministically
	// instead of leaving it to idle-exit or a signal) and assigned after —
	// `shutdown` only ever runs later, once both are set.
	let idleTimer: NodeJS.Timeout | null = null;
	let socketHandle: Awaited<ReturnType<typeof startSocketServer>> | null = null;

	function shutdown() {
		if (idleTimer) clearInterval(idleTimer);
		// Explicit rather than relying on the OS to SIGHUP children when our
		// fds close — deterministic, and matches what index.tsx/server's
		// index.ts used to do themselves before PTY ownership moved here. This
		// is the GLOBAL kill (every project's agents at once); scoped stops
		// never reach here — they kill individual sessions and leave the daemon
		// running (see src/server/api.ts's /agents/stop routes).
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
			unlinkSync(DAEMON_SOCK);
		} catch {}
		process.exit(0);
	}

	try {
		socketHandle = await startSocketServer(DAEMON_SOCK, inProcessPtyBackend, status, shutdown);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			// Lost a startup race to another daemon instance spawned at nearly
			// the same moment — it already won, so just step aside.
			console.log("[scion-daemon] another instance won the race to bind; exiting");
			hookServer.close();
			process.exit(0);
		}
		throw err;
	}

	console.log(`[scion-daemon] listening on ${DAEMON_SOCK} (pid ${process.pid})`);

	let idleSince: number | null = null;
	idleTimer = setInterval(() => {
		const idle = listSessions().length === 0 && socketHandle?.controlConnectionCount() === 0;
		if (!idle) {
			idleSince = null;
			return;
		}
		if (idleSince === null) {
			idleSince = Date.now();
			return;
		}
		if (Date.now() - idleSince >= IDLE_EXIT_MS) {
			console.log("[scion-daemon] idle with no sessions/clients — shutting down");
			shutdown();
		}
	}, IDLE_CHECK_INTERVAL_MS);
	idleTimer.unref();

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[scion-daemon] fatal:", err);
	process.exit(1);
});
