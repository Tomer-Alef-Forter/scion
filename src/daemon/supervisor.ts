#!/usr/bin/env -S npx tsx
// The supervisor: the opt-in entry point that turns Scion's single-process PTY
// daemon into a crash-survivable pair.
//
// It launches, in order:
//   1. the durable PTY host (src/daemon/ptyHost.ts) — owns the node-pty master
//      fds, the hook receiver, and the status DB; must outlive the daemon.
//   2. the front-end-facing daemon (src/daemon/index.ts) with SCION_PTY_HOST_SOCK
//      set, which flips it into proxy mode (owns no PTYs itself).
//
// Then it watches both:
//   - daemon exits while the host still has live sessions  -> respawn the daemon
//     (this is the crash-recovery path — the agents kept running inside the host
//     the whole time; front-ends just reconnect + re-attach once it's back).
//   - the host exits (it idle-exits once it has no sessions, or is signalled)
//     -> nothing left to protect, so tear the daemon down and exit.
//
// Default single-process behavior (running the daemon directly, or letting a
// front-end auto-spawn it) is entirely untouched: nothing here runs unless you
// launch this supervisor explicitly.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import {
	DAEMON_LOG,
	DAEMON_SOCK,
	DATA_DIR,
	PTY_HOST_LOG,
	PTY_HOST_SOCK,
	PTY_HOST_SOCK_ENV,
} from "../config.ts";
import { createPtyHostClientBackend } from "../engine/ptyBackend.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
const PTY_HOST_ENTRY = "src/daemon/ptyHost.ts";
const DAEMON_ENTRY = "src/daemon/index.ts";

const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 50;
// Guard against a wedged daemon crash-looping forever: if it dies this many
// times inside this window, stop respawning and tear down.
const MAX_RESPAWNS = 5;
const RESPAWN_WINDOW_MS = 10_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectOnce(sockPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(sockPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", (err) => {
			socket.destroy();
			reject(err);
		});
	});
}

async function waitForSocket(sockPath: string, label: string): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			await connectOnce(sockPath);
			return;
		} catch (err) {
			if (Date.now() > deadline) {
				throw new Error(`${label} did not start listening on ${sockPath} in time: ${String(err)}`);
			}
			await sleep(READY_POLL_MS);
		}
	}
}

function spawnChild(entry: string, logPath: string, extraEnv: Record<string, string>): ChildProcess {
	const logFd = openSync(logPath, "a");
	try {
		return spawn(TSX_BIN, [entry], {
			cwd: ROOT,
			stdio: ["ignore", logFd, logFd],
			env: { ...process.env, ...extraEnv },
		});
	} finally {
		closeSync(logFd);
	}
}

async function main() {
	// Log fds (and the host's createDb) need DATA_DIR to exist first.
	mkdirSync(DATA_DIR, { recursive: true });

	let shuttingDown = false;
	let daemon: ChildProcess | null = null;
	const respawnTimes: number[] = [];

	// Used only to answer "does the host still have live sessions?" when the
	// daemon dies — it never auto-spawns the host (we own that below).
	const hostBackend = createPtyHostClientBackend();

	async function hostHasSessions(): Promise<boolean> {
		try {
			const sessions = await hostBackend.listSessions();
			return sessions.some((s) => !s.exited);
		} catch {
			// Can't reach the host -> treat as "no sessions to protect".
			return false;
		}
	}

	// ---- 1. durable PTY host ----
	console.log("[scion-supervisor] starting PTY host");
	const host = spawnChild(PTY_HOST_ENTRY, PTY_HOST_LOG, {});
	await waitForSocket(PTY_HOST_SOCK, "scion-pty-host");
	console.log(`[scion-supervisor] PTY host ready (pid ${host.pid})`);

	function teardown(reason: string): void {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[scion-supervisor] tearing down: ${reason}`);
		try {
			daemon?.kill("SIGTERM");
		} catch {}
		try {
			host.kill("SIGTERM");
		} catch {}
		// Give the children a beat to clean up their sockets, then exit.
		setTimeout(() => process.exit(0), 500);
	}

	function startDaemon(): void {
		if (shuttingDown) return;
		daemon = spawnChild(DAEMON_ENTRY, DAEMON_LOG, { [PTY_HOST_SOCK_ENV]: PTY_HOST_SOCK });
		console.log(`[scion-supervisor] starting daemon (proxy mode, pid ${daemon.pid})`);
		daemon.once("exit", (code, signal) => {
			if (shuttingDown) return;
			console.log(`[scion-supervisor] daemon exited (code ${code}, signal ${signal})`);
			void onDaemonExit();
		});
	}

	async function onDaemonExit(): Promise<void> {
		if (shuttingDown) return;
		if (!(await hostHasSessions())) {
			// Nothing left running to protect — let the host idle-exit and follow.
			teardown("daemon exited with no live sessions in the host");
			return;
		}
		const now = Date.now();
		respawnTimes.push(now);
		for (let oldest = respawnTimes[0]; oldest !== undefined && now - oldest > RESPAWN_WINDOW_MS; ) {
			respawnTimes.shift();
			oldest = respawnTimes[0];
		}
		if (respawnTimes.length > MAX_RESPAWNS) {
			teardown(`daemon crash-looped (>${MAX_RESPAWNS} times in ${RESPAWN_WINDOW_MS}ms)`);
			return;
		}
		console.log("[scion-supervisor] host still has live sessions — respawning daemon");
		startDaemon();
	}

	// If the host itself dies, there is nothing left to proxy to.
	host.once("exit", (code, signal) => {
		teardown(`PTY host exited (code ${code}, signal ${signal})`);
	});

	// ---- 2. front-end-facing daemon ----
	startDaemon();
	await waitForSocket(DAEMON_SOCK, "scion-daemon");
	console.log("[scion-supervisor] daemon ready — supervised stack is up");

	process.on("SIGINT", () => teardown("SIGINT"));
	process.on("SIGTERM", () => teardown("SIGTERM"));
}

main().catch((err) => {
	console.error("[scion-supervisor] fatal:", err);
	process.exit(1);
});
