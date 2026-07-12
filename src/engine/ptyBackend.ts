// The seam between "a live agent process" and "whoever's asking about it".
//
// Two implementations:
//   - inProcessPtyBackend: thin wrapper over pty.ts's real sessions Map. Used
//     by the daemon itself (the one process that actually owns PTYs) and by
//     smoke tests (which want real PTYs with no daemon/socket involved).
//   - createDaemonPtyBackend: Unix-socket client used by the real front-end
//     entry points (Ink, web server). Auto-spawns the daemon if it isn't
//     already running, so `bun start` / `bun run web` need no separate step.
//
// Store/UI code (store/projects.ts, server/ws-terminal.ts, ui/attach.ts) only
// ever talks to a `PtyBackend` — it doesn't know or care whether that's a
// direct in-process call or a round trip to the daemon.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { DAEMON_LOG, DAEMON_SOCK, DATA_DIR } from "../config.ts";
import {
	type AttachClientMessage,
	type AttachServerMessage,
	type ControlMessage,
	type ControlRequest,
	type ControlRequestInput,
	encodeJson,
	FrameDecoder,
	type SessionInfo,
} from "../daemon/protocol.ts";
import { getSession, listSessions as listInProcessSessions, spawnSession } from "./pty.ts";

export type { SessionInfo } from "../daemon/protocol.ts";

export interface AttachHandle {
	onData(fn: (chunk: string) => void): () => void;
	onExit(fn: (exitCode: number) => void): () => void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Detach only — never kills the underlying session (mirrors ui/attach.ts's Ctrl-b d and ws-terminal.ts's on-close). */
	close(): void;
}

export interface PtyBackend {
	spawnSession(args: {
		id: string;
		workspaceId: string;
		file: string;
		args: string[];
		cwd: string;
		cols?: number;
		rows?: number;
	}): Promise<void>;
	listSessions(workspaceId?: string): Promise<SessionInfo[]>;
	killSession(terminalId: string): Promise<void>;
	attach(terminalId: string, opts?: { skipReplay?: boolean }): Promise<AttachHandle | null>;
	/**
	 * Fires when an agent's status changes anywhere (any workspace). Real work
	 * only for the daemon backend, whose daemon process holds the actual
	 * StatusStore that recorded the change — a separate JS object per process,
	 * so front-ends need this relayed to know about it at all. A no-op for
	 * inProcessPtyBackend: daemon and caller share the same StatusStore
	 * instance there, so the caller already observes changes directly.
	 */
	onStatusChanged(fn: (workspaceId: string) => void): () => void;
	/**
	 * Stops the daemon process itself (killing every live agent along with
	 * it — same as any other daemon shutdown). A no-op for inProcessPtyBackend
	 * (there's no separate daemon process to stop in that mode). Exists for
	 * deterministic cleanup — tests that spawn a real daemon must stop it
	 * explicitly rather than leaving it to idle-exit or a signal, since it's
	 * deliberately detached to survive its spawner.
	 */
	shutdownDaemon(): Promise<void>;
}

// ---- in-process backend (used by the daemon itself, and by smoke tests) ----

export const inProcessPtyBackend: PtyBackend = {
	async spawnSession(args) {
		spawnSession(args);
	},

	async listSessions(workspaceId) {
		return listInProcessSessions(workspaceId).map((s) => ({
			id: s.id,
			workspaceId: s.workspaceId,
			exited: s.exited,
			exitCode: s.exitCode,
		}));
	},

	async killSession(terminalId) {
		getSession(terminalId)?.kill();
	},

	async attach(terminalId, opts = {}) {
		const session = getSession(terminalId);
		if (!session || session.exited) return null;
		// Captured once, up front — this handle represents one external
		// client's view, and replay should happen exactly once for it,
		// matching today's per-connection getBuffer() semantics.
		const replayBuffer = opts.skipReplay ? null : session.getBuffer();
		// close() unsubscribes everything registered on this handle, so callers
		// (socketServer.ts, and anywhere this backend is used directly) can
		// just call handle.close() on detach instead of tracking each
		// onData/onExit unsub themselves — without this, a socket closing
		// would leave its listener attached to the underlying PtySession
		// forever (a real leak across repeated attach/detach cycles).
		const unsubs: Array<() => void> = [];
		return {
			onData(fn) {
				if (replayBuffer) fn(replayBuffer);
				const off = session.onData(fn);
				unsubs.push(off);
				return off;
			},
			onExit(fn) {
				const off = session.onExit(fn);
				unsubs.push(off);
				return off;
			},
			write(data) {
				session.write(data);
			},
			resize(cols, rows) {
				session.resize(cols, rows);
			},
			close() {
				// Detach only — the daemon (or, pre-daemon, the same process)
				// keeps owning the session's lifecycle; this just stops
				// forwarding its output/exit to this particular handle.
				for (const off of unsubs) off();
				unsubs.length = 0;
			},
		};
	},

	onStatusChanged() {
		return () => {};
	},

	async shutdownDaemon() {
		// No-op: in this mode the "daemon" is just this process — nothing
		// separate to stop.
	},
};

// ---- daemon-backed client ----

const ROOT = join(import.meta.dirname, "..", "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
const DAEMON_ENTRY = "src/daemon/index.ts";
const CONNECT_TIMEOUT_MS = 4000;
const POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnectOnce(): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(DAEMON_SOCK);
		const onConnect = () => {
			socket.off("error", onError);
			resolve(socket);
		};
		const onError = (err: Error) => {
			socket.off("connect", onConnect);
			reject(err);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

function spawnDaemonDetached(): void {
	// DATA_DIR (and thus DAEMON_LOG's parent) may not exist yet — the daemon
	// itself creates it via createDb()'s mkdirSync, but that only runs AFTER
	// it's already spawned. On a genuine first-ever run (or a fresh isolated
	// test HOME), skipping this makes the log open below throw ENOENT.
	mkdirSync(DATA_DIR, { recursive: true });
	const logFd = openSync(DAEMON_LOG, "a");
	try {
		const child = spawn(TSX_BIN, [DAEMON_ENTRY], {
			cwd: ROOT,
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
		child.unref();
	} finally {
		closeSync(logFd);
	}
}

/** Connect to the daemon's control/attach socket, spawning it if not already running. */
async function connectToDaemon(): Promise<net.Socket> {
	try {
		return await tryConnectOnce();
	} catch {
		// No daemon listening yet — spawn one and poll until it's ready.
	}
	spawnDaemonDetached();
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	for (;;) {
		try {
			return await tryConnectOnce();
		} catch (err) {
			if (Date.now() > deadline) {
				throw new Error(
					`scion-daemon did not become ready in time (check ${DAEMON_LOG}): ${String(err)}`,
				);
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

interface PendingRequest {
	resolve: (result: Extract<ControlMessage, { type: "result" }>) => void;
	reject: (err: Error) => void;
}

/** One persistent control connection: RPC (spawn/list/kill) + status-changed pushes. */
class ControlClient {
	private socket: net.Socket | null = null;
	private connecting: Promise<net.Socket> | null = null;
	private decoder = new FrameDecoder();
	private nextReqId = 1;
	private pending = new Map<number, PendingRequest>();
	private statusListeners = new Set<(workspaceId: string) => void>();

	private async ensureConnected(): Promise<net.Socket> {
		if (this.socket && !this.socket.destroyed) return this.socket;
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const socket = await connectToDaemon();
			socket.on("data", (chunk) => this.decoder.push(chunk, (frame) => this.handleFrame(frame)));
			socket.on("close", () => {
				this.socket = null;
				const err = new Error("daemon control connection closed");
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
			});
			this.socket = socket;
			return socket;
		})();
		try {
			return await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	private handleFrame(frame: { kind: "json" | "binary"; payload: Buffer }): void {
		if (frame.kind !== "json") return; // control connection never carries binary frames
		const msg = JSON.parse(frame.payload.toString("utf8")) as ControlMessage;
		if (msg.type === "result") {
			const pending = this.pending.get(msg.reqId);
			if (pending) {
				this.pending.delete(msg.reqId);
				pending.resolve(msg);
			}
			return;
		}
		if (msg.type === "status-changed") {
			for (const fn of this.statusListeners) fn(msg.workspaceId);
		}
		// session-exited: no dedicated listener today — callers poll via
		// listSessions()/status-changed, which already covers the UI's needs.
	}

	async request(req: ControlRequestInput): Promise<Extract<ControlMessage, { type: "result" }>> {
		const socket = await this.ensureConnected();
		const reqId = this.nextReqId++;
		const full = { ...req, reqId } as ControlRequest;
		return new Promise((resolve, reject) => {
			this.pending.set(reqId, { resolve, reject });
			socket.write(encodeJson(full));
		});
	}

	onStatusChanged(fn: (workspaceId: string) => void): () => void {
		this.statusListeners.add(fn);
		// Fire-and-forget: make sure a connection exists so pushes actually
		// arrive even if the caller never issues an RPC.
		this.ensureConnected().catch(() => {});
		return () => this.statusListeners.delete(fn);
	}
}

async function daemonAttach(
	terminalId: string,
	opts: { skipReplay?: boolean } = {},
): Promise<AttachHandle | null> {
	const socket = await connectToDaemon();
	const decoder = new FrameDecoder();
	const dataListeners = new Set<(chunk: string) => void>();
	const exitListeners = new Set<(code: number) => void>();
	let settleAttach: ((ok: boolean) => void) | null = null;
	const attached = new Promise<boolean>((resolve) => {
		settleAttach = resolve;
	});

	socket.on("data", (chunk) =>
		decoder.push(chunk, (frame) => {
			if (frame.kind === "binary") {
				const text = frame.payload.toString("utf8");
				for (const fn of dataListeners) fn(text);
				return;
			}
			const msg = JSON.parse(frame.payload.toString("utf8")) as AttachServerMessage;
			if (msg.type === "attached") settleAttach?.(true);
			else if (msg.type === "error") settleAttach?.(false);
			else if (msg.type === "exit") for (const fn of exitListeners) fn(msg.exitCode);
		}),
	);
	socket.on("close", () => settleAttach?.(false));
	socket.on("error", () => settleAttach?.(false));

	const req: AttachClientMessage = { type: "attach", terminalId, skipReplay: opts.skipReplay };
	socket.write(encodeJson(req));

	const ok = await attached;
	if (!ok) {
		socket.destroy();
		return null;
	}

	return {
		onData(fn) {
			dataListeners.add(fn);
			return () => dataListeners.delete(fn);
		},
		onExit(fn) {
			exitListeners.add(fn);
			return () => exitListeners.delete(fn);
		},
		write(data) {
			const msg: AttachClientMessage = { type: "input", data };
			socket.write(encodeJson(msg));
		},
		resize(cols, rows) {
			const msg: AttachClientMessage = { type: "resize", cols, rows };
			socket.write(encodeJson(msg));
		},
		close() {
			socket.destroy();
		},
	};
}

/** Builds a fresh daemon-backed PtyBackend — call once per front-end process. */
export function createDaemonPtyBackend(): PtyBackend {
	const control = new ControlClient();

	return {
		async spawnSession(args) {
			const { id, ...rest } = args;
			const result = await control.request({ type: "spawn", terminalId: id, ...rest });
			if (!result.ok) throw new Error(result.error ?? "spawn failed");
		},

		async listSessions(workspaceId) {
			const result = await control.request({ type: "list", workspaceId });
			if (!result.ok) throw new Error(result.error ?? "list failed");
			return result.sessions ?? [];
		},

		async killSession(terminalId) {
			const result = await control.request({ type: "kill", terminalId });
			if (!result.ok) throw new Error(result.error ?? "kill failed");
		},

		attach(terminalId, opts) {
			return daemonAttach(terminalId, opts);
		},

		onStatusChanged(fn) {
			return control.onStatusChanged(fn);
		},

		async shutdownDaemon() {
			const result = await control.request({ type: "shutdown" });
			if (!result.ok) throw new Error(result.error ?? "shutdown failed");
		},
	};
}
