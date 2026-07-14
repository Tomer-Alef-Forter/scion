#!/usr/bin/env -S npx tsx
// Smoke test for the OPT-IN durable PTY-host + supervisor stack (src/daemon/
// supervisor.ts, ptyHost.ts, and index.ts's proxy-mode branch).
//
// Proves the thing the classic single-process daemon can't do: an agent (its
// process AND its PTY output continuity) survives a hard crash of the
// front-end-facing daemon. We:
//   1. launch the supervisor (which starts the durable PTY host + a proxy-mode
//      daemon),
//   2. spawn a session running a steadily-counting loop and confirm live output,
//   3. SIGKILL the daemon process (NOT the host),
//   4. wait for the supervisor to respawn the daemon,
//   5. reconnect with a fresh backend and prove the SAME session is still alive,
//      that reconnecting replays scrollback, and that the counter ADVANCED
//      across the crash (i.e. the agent really kept running the whole time).
//
// Run: `bun run persistence-smoke`.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import {
	DAEMON_LOG,
	DAEMON_SOCK,
	DATA_DIR,
	PTY_HOST_LOG,
	PTY_HOST_SOCK,
	SUPERVISOR_LOG,
} from "../src/config.ts";
import { createDaemonPtyBackend } from "../src/engine/ptyBackend.ts";

if (!process.env.SL_ISOLATED_HOME) {
	console.error(
		"refusing to run: this script must be invoked via `bun run persistence-smoke` " +
			"(scripts/run-isolated.ts) — it spawns real, long-lived daemon/host processes " +
			"against an isolated $HOME.",
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

async function waitFor(
	fn: () => Promise<boolean> | boolean,
	timeoutMs = 6000,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await fn()) return true;
		if (Date.now() > deadline) return false;
		await sleep(intervalMs);
	}
}

function socketReachable(sockPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(sockPath);
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

const ROOT = join(import.meta.dirname, "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");

/**
 * PIDs are read out of the per-run logs (under the isolated DATA_DIR), NOT via
 * pgrep — a `tsx src/daemon/index.ts` pattern would also match a real, unrelated
 * daemon the developer has running from their main checkout, and we must never
 * touch that. Each "listening on ... (pid N)" line is one process lifetime; the
 * last one is the current process, and multiple lines across a restart let us
 * assert a NEW pid came up.
 */
function listeningPids(logPath: string): number[] {
	let text: string;
	try {
		text = readFileSync(logPath, "utf8");
	} catch {
		return [];
	}
	return [...text.matchAll(/listening on \S+ \(pid (\d+)\)/g)].map((m) =>
		Number.parseInt(m[1], 10),
	);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Highest tick number ("tick-N") seen in a blob of PTY output, or -1. */
function maxTick(blob: string): number {
	let max = -1;
	for (const m of blob.matchAll(/tick-(\d+)/g)) {
		const n = Number.parseInt(m[1], 10);
		if (n > max) max = n;
	}
	return max;
}

async function main() {
	mkdirSync(DATA_DIR, { recursive: true });

	// ---- launch the supervised stack ----
	const supLogFd = openSync(SUPERVISOR_LOG, "a");
	const supervisor = spawn(TSX_BIN, ["src/daemon/supervisor.ts"], {
		cwd: ROOT,
		detached: true,
		stdio: ["ignore", supLogFd, supLogFd],
	});
	supervisor.unref();
	closeSync(supLogFd);

	try {
		const up = await waitFor(() => socketReachable(DAEMON_SOCK), 12_000);
		check("supervisor brings the daemon socket up", up);

		const hostUp = await socketReachable(PTY_HOST_SOCK);
		check("the durable PTY host is listening", hostUp);

		// ---- spawn a steadily-counting session ----
		const backend = createDaemonPtyBackend();
		const terminalId = randomUUID();
		const workspaceId = "persistence-smoke-workspace";
		await backend.spawnSession({
			id: terminalId,
			workspaceId,
			file: "bash",
			args: ["-c", "i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.3; done"],
			cwd: process.cwd(),
		});

		let pre = "";
		const handle = await backend.attach(terminalId);
		handle?.onData((c) => {
			pre += c;
		});
		const sawEarly = await waitFor(() => maxTick(pre) >= 2);
		check("live output streams before the crash", sawEarly);
		const tickBeforeCrash = maxTick(pre);

		// ---- identify the daemon (proxy) and the host, then HARD-KILL the daemon ----
		const daemonPidBefore = listeningPids(DAEMON_LOG).at(-1);
		const hostPid = listeningPids(PTY_HOST_LOG).at(-1);
		check("the proxy daemon logged a pid", daemonPidBefore !== undefined);
		check("the durable host is a separate process", hostPid !== undefined && hostPid !== daemonPidBefore);

		if (daemonPidBefore !== undefined) process.kill(daemonPidBefore, "SIGKILL");
		// Prove it actually went down before it comes back.
		const wentDown = await waitFor(async () => !(await socketReachable(DAEMON_SOCK)), 4000);
		check("daemon socket goes down after SIGKILL", wentDown);

		// ---- supervisor respawns the daemon ----
		const backUp = await waitFor(() => socketReachable(DAEMON_SOCK), 12_000);
		check("supervisor respawns the daemon (socket back up)", backUp);

		const gotNewDaemon = await waitFor(() => {
			const last = listeningPids(DAEMON_LOG).at(-1);
			return last !== undefined && last !== daemonPidBefore;
		}, 4000);
		check("respawned daemon is a NEW process", gotNewDaemon);

		check(
			"the durable host survived the daemon crash (same pid, still alive)",
			hostPid !== undefined && isAlive(hostPid),
		);

		// ---- reconnect and prove the agent kept running ----
		const backend2 = createDaemonPtyBackend();
		const sessions = await backend2.listSessions(workspaceId);
		const survivor = sessions.find((s) => s.id === terminalId);
		check("the session is still listed after the crash", survivor !== undefined);
		check("the surviving session has NOT exited", survivor?.exited === false);

		let post = "";
		const handle2 = await backend2.attach(terminalId);
		check("re-attach to the surviving session succeeds", handle2 !== null);
		handle2?.onData((c) => {
			post += c;
		});
		// Replay: reconnecting should hand back scrollback (older ticks).
		const gotReplay = await waitFor(() => maxTick(post) >= 0);
		check("re-attach replays scrollback from the durable host", gotReplay);
		// Continuity: the counter must have advanced past where it was at crash
		// time — only possible if the agent process never died.
		const advanced = await waitFor(() => maxTick(post) > tickBeforeCrash, 8000);
		check(
			`the agent kept running across the crash (tick advanced past ${tickBeforeCrash})`,
			advanced,
		);

		handle?.close();
		handle2?.close();
		await backend2.killSession(terminalId);
	} finally {
		// Tear the whole stack down deterministically (isolated $HOME is about to
		// be deleted). SIGTERM the supervisor -> it kills daemon + host; then,
		// scoped to THIS run's own logs (never a stray pgrep that could hit a
		// developer's real daemon), SIGKILL any process that's still alive.
		try {
			if (supervisor.pid) process.kill(supervisor.pid, "SIGTERM");
		} catch {}
		await sleep(1000);
		const stragglers = [...listeningPids(DAEMON_LOG), ...listeningPids(PTY_HOST_LOG)];
		if (supervisor.pid) stragglers.push(supervisor.pid);
		for (const pid of stragglers) {
			if (isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
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
	console.error("[persistence-smoke] fatal:", err);
	process.exit(1);
});
