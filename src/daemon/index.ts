#!/usr/bin/env -S npx tsx
// PTY daemon entry point. Owns every live agent's node-pty process, the hook
// receiver, and status writes — decoupled from whichever front-end (Ink or
// web) happens to be running, so restarting/crashing a front-end no longer
// kills agents. Auto-spawned by engine/ptyBackend.ts's createDaemonPtyBackend
// when no daemon is already listening; not meant to be launched by a user
// directly (though `tsx src/daemon/index.ts` works fine for debugging).
//
// Default mode (single process): a crash of THIS process still kills every
// live agent across every project at once — closing the daemon closes every
// PTY master fd, which SIGHUPs the child on the other end. Only front-end
// restarts are safe (they don't own the PTYs).
//
// What IS isolated between projects even in default mode: every node-pty child
// is its own OS session (forkpty() setsid()s it) and sessions are tracked +
// killed individually, so an INTENTIONAL / targeted stop can hit just one
// project's or one workspace's agents without signalling any other project's.
// See src/server/api.ts: POST /projects/:id/agents/stop and
// /workspaces/:id/agents/stop are the scoped stops; killAll() below (reached
// only via the explicit global /daemon/shutdown) is the "stop everything"
// path that also stops this whole process.
//
// PTY-host mode (opt-in, gated on the SCION_PTY_HOST_SOCK env var, set only by
// src/daemon/supervisor.ts): a durable src/daemon/ptyHost.ts process owns every
// node-pty session (and the hook receiver + status DB). This daemon then owns
// NO PTYs itself — it's a thin front-end-facing proxy over a client backend
// pointed at the host. So a crash/restart of this daemon leaves the master fds
// (held by the host) open and the agents running; the supervisor respawns this
// daemon and front-ends reconnect + re-attach (replaying scrollback). Real
// fd-passing (SCM_RIGHTS) of a PTY master is infeasible in pure Node — a TTY
// handle can't be serialized over IPC (empirically it fails EBADF) — so
// relocating PTY ownership into a durable peer process is the way.
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import { DAEMON_SOCK, DB_PATH, PTY_HOST_SOCK_ENV } from "../config.ts";
import { createDb } from "../db/db.ts";
import {
	createPtyHostClientBackend,
	inProcessPtyBackend,
	type PtyBackend,
} from "../engine/ptyBackend.ts";
import { killAll, listSessions } from "../engine/pty.ts";
import { createStatusStore, type StatusStore } from "../engine/status.ts";
import { getHookUrl } from "../hookAddr.ts";
import { startHookServer } from "../hookServer.ts";
import { startSocketServer } from "./socketServer.ts";

/**
 * A minimal StatusStore stand-in for PTY-host mode. The real, DB-backed store
 * lives in the PTY host; here we only need the two members startSocketServer
 * touches: `events` (so this daemon can push status-changed to its front-ends)
 * and `markExited` (a no-op — the host's own socket server already records the
 * real exit against the real store). Change events originate in the host and
 * arrive over the client backend's onStatusChanged, which we re-emit here.
 */
function createRelayStatusStore(backend: PtyBackend): StatusStore {
	const events = new EventEmitter();
	backend.onStatusChanged((workspaceId) => events.emit("change", workspaceId));
	return {
		events,
		markExited() {},
		recordEvent() {},
		markSeen() {},
		listByWorkspace() {
			return [];
		},
	};
}

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

	// PTY-host mode is a pure runtime switch on an env var the supervisor sets.
	// In it, this process owns NO PTYs, hook receiver, or DB — the durable host
	// does — so we skip all of that and proxy to it over a client backend.
	const ptyHostMode = Boolean(process.env[PTY_HOST_SOCK_ENV]);

	let backend: PtyBackend;
	let status: StatusStore;
	let hookServer: { close(): void } | null = null;

	if (ptyHostMode) {
		backend = createPtyHostClientBackend();
		status = createRelayStatusStore(backend);
		console.log("[scion-daemon] PTY-host mode: proxying sessions to the durable host");
	} else {
		const db = createDb(DB_PATH, { reconcile: true });
		status = createStatusStore(db);
		hookServer = await startHookServer(status);
		backend = inProcessPtyBackend;
		// Logged (into DAEMON_LOG) so tooling — e.g. scripts/daemon-smoke.ts, which
		// runs in a separate process from the daemon and so can't just call
		// getHookUrl() itself — can discover the real, possibly-ephemeral-
		// fallback port without guessing.
		console.log(`[scion-daemon] hook receiver at ${getHookUrl()}`);
	}

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
		// running (see src/server/api.ts's /agents/stop routes). A no-op in
		// PTY-host mode (this process owns no local sessions) — and, crucially,
		// we do NOT tell the host to shut down: the whole point is that it (and
		// its agents) outlives us.
		try {
			killAll();
		} catch {}
		try {
			socketHandle?.server.close();
		} catch {}
		try {
			hookServer?.close();
		} catch {}
		try {
			unlinkSync(DAEMON_SOCK);
		} catch {}
		process.exit(0);
	}

	try {
		socketHandle = await startSocketServer(DAEMON_SOCK, backend, status, shutdown);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			// Lost a startup race to another daemon instance spawned at nearly
			// the same moment — it already won, so just step aside.
			console.log("[scion-daemon] another instance won the race to bind; exiting");
			hookServer?.close();
			process.exit(0);
		}
		throw err;
	}

	console.log(`[scion-daemon] listening on ${DAEMON_SOCK} (pid ${process.pid})`);

	// Idle-exit is skipped in PTY-host mode: the supervisor owns this daemon's
	// lifecycle (it keeps it up while the host has sessions and tears it down
	// when the host exits), and local listSessions() is always empty here, so
	// the usual "no sessions AND no clients" check would be meaningless.
	if (!ptyHostMode) {
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
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("[scion-daemon] fatal:", err);
	process.exit(1);
});
