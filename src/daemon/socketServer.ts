// Unix-socket server run by the daemon: accepts CONTROL connections (spawn/
// list/kill/ping RPC, plus status-changed pushes) and ATTACH connections (one
// per live terminal view — input/resize in, streamed PTY output + exit out).
// A connection's role is unknown until its first message: an `attach`
// message makes it an attach connection for its whole lifetime; any control
// message (spawn/list/kill/ping) makes it a control connection. Backed
// directly by a PtyBackend (in practice always inProcessPtyBackend — this
// process is the one that owns real node-pty sessions), so this file has no
// pty.ts import of its own.
import { chmodSync } from "node:fs";
import * as net from "node:net";
import type { AttachHandle, PtyBackend } from "../engine/ptyBackend.ts";
import type { StatusStore } from "../engine/status.ts";
import {
	type AttachClientMessage,
	type AttachRequest,
	type ControlRequest,
	encodeFrame,
	encodeJson,
	FrameDecoder,
} from "./protocol.ts";

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export interface SocketServerHandle {
	server: net.Server;
	controlConnectionCount(): number;
}

export function startSocketServer(
	sockPath: string,
	backend: PtyBackend,
	status: StatusStore,
	onShutdownRequested: () => void,
): Promise<SocketServerHandle> {
	const controlConnections = new Set<net.Socket>();

	// Covers BOTH hook-driven status changes (recordEvent) and exit-driven
	// ones (markExited, wired below on spawn) — both call the same
	// status.events.emit("change", ...), so one subscription is all that's
	// needed to keep every connected front-end's dashboard live.
	status.events.on("change", (workspaceId: string) => {
		const frame = encodeJson({ type: "status-changed", workspaceId });
		for (const conn of controlConnections) {
			if (!conn.destroyed) conn.write(frame);
		}
	});

	const server = net.createServer((socket) => {
		const decoder = new FrameDecoder();
		let role: "unknown" | "control" | "attach" = "unknown";
		let attachHandle: AttachHandle | null = null;

		function send(msg: unknown): void {
			if (!socket.destroyed) socket.write(encodeJson(msg));
		}

		async function handleControl(req: ControlRequest): Promise<void> {
			switch (req.type) {
				case "ping":
					send({ type: "result", reqId: req.reqId, ok: true });
					return;
				case "spawn":
					try {
						await backend.spawnSession({
							id: req.terminalId,
							workspaceId: req.workspaceId,
							file: req.file,
							args: req.args,
							cwd: req.cwd,
							cols: req.cols,
							rows: req.rows,
						});
						// Lives for the whole session — an internal, never-closed
						// attach used purely to notice the PTY exiting so the
						// status DB gets updated even if nobody ever views this
						// terminal. Mirrors what store/projects.ts used to wire
						// per-session before PTYs moved into the daemon.
						const handle = await backend.attach(req.terminalId, { skipReplay: true });
						handle?.onExit(() => status.markExited(req.terminalId));
						send({ type: "result", reqId: req.reqId, ok: true });
					} catch (err) {
						send({ type: "result", reqId: req.reqId, ok: false, error: errMsg(err) });
					}
					return;
				case "list":
					try {
						const sessions = await backend.listSessions(req.workspaceId);
						send({ type: "result", reqId: req.reqId, ok: true, sessions });
					} catch (err) {
						send({ type: "result", reqId: req.reqId, ok: false, error: errMsg(err) });
					}
					return;
				case "kill":
					try {
						await backend.killSession(req.terminalId);
						send({ type: "result", reqId: req.reqId, ok: true });
					} catch (err) {
						send({ type: "result", reqId: req.reqId, ok: false, error: errMsg(err) });
					}
					return;
				case "shutdown":
					send({ type: "result", reqId: req.reqId, ok: true });
					// Let the ack flush before the process actually exits.
					setImmediate(onShutdownRequested);
					return;
			}
		}

		async function handleAttachStart(req: AttachRequest): Promise<void> {
			try {
				const handle = await backend.attach(req.terminalId, { skipReplay: req.skipReplay });
				if (!handle) {
					send({ type: "error", message: "Terminal session not found" });
					socket.end();
					return;
				}
				attachHandle = handle;
				send({ type: "attached", terminalId: req.terminalId });
				handle.onData((chunk) => {
					if (!socket.destroyed) socket.write(encodeFrame("binary", chunk));
				});
				handle.onExit((exitCode) => send({ type: "exit", exitCode }));
			} catch (err) {
				send({ type: "error", message: errMsg(err) });
				socket.end();
			}
		}

		function handleAttachMessage(msg: AttachClientMessage): void {
			if (!attachHandle) return;
			if (msg.type === "input") attachHandle.write(msg.data);
			else if (msg.type === "resize") attachHandle.resize(msg.cols, msg.rows);
		}

		socket.on("data", (chunk) => {
			decoder.push(chunk, (frame) => {
				if (frame.kind !== "json") return; // clients never send binary
				let parsed: unknown;
				try {
					parsed = JSON.parse(frame.payload.toString("utf8"));
				} catch {
					return;
				}
				const msg = parsed as { type?: string };

				if (role === "unknown") {
					if (msg.type === "attach") {
						role = "attach";
						void handleAttachStart(parsed as AttachRequest);
					} else if (
						msg.type === "spawn" ||
						msg.type === "list" ||
						msg.type === "kill" ||
						msg.type === "ping" ||
						msg.type === "shutdown"
					) {
						role = "control";
						controlConnections.add(socket);
						void handleControl(parsed as ControlRequest);
					}
					return;
				}
				if (role === "control") void handleControl(parsed as ControlRequest);
				else handleAttachMessage(parsed as AttachClientMessage);
			});
		});

		socket.on("close", () => {
			controlConnections.delete(socket);
			attachHandle?.close();
		});
		socket.on("error", () => {
			// A client going away mid-write surfaces here — 'close' still fires
			// right after and does the real cleanup above.
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(sockPath, () => {
			server.off("error", reject);
			// Owner-only (0600). The control protocol accepts a `spawn` RPC that
			// runs arbitrary commands, so the socket is a code-execution surface;
			// without this it inherits the process umask, and on Linux a socket in
			// a world-/group-writable /tmp could let another local user connect and
			// spawn processes as us. Don't rely on umask — lock it down explicitly.
			try {
				chmodSync(sockPath, 0o600);
			} catch {
				// Best-effort: on platforms where chmod of a socket is unsupported,
				// the per-user tmpdir (macOS) is already the containment boundary.
			}
			resolve({ server, controlConnectionCount: () => controlConnections.size });
		});
	});
}
