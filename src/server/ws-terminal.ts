// PTY <-> WebSocket bridge for /ws/terminal/:terminalId.
//
// Protocol matches Superset's real web TerminalConnection.ts EXACTLY (field
// names included) so its lifted client works unmodified:
//   server -> browser: BINARY frames = raw PTY output bytes; JSON control =
//     {type:"attached",terminalId} | {type:"exit",exitCode,signal} | {type:"error",message}.
//   browser -> server: JSON only = {type:"input",data} | {type:"resize",cols,rows}.
// `attached` must be sent on every successful open — the client only flips
// its UI to "open" (and sends the first resize) once it sees this message.
//
// `?replay=0` (the client sets this once it has already received bytes, to
// skip a redundant re-dump on reconnect) suppresses the scrollback replay.
//
// On close we only unsubscribe listeners — we NEVER kill the session (mirrors
// src/ui/attach.ts: detaching must not stop the agent).
import type { WSContext, WSEvents } from "hono/ws";
import { getSession } from "../engine/pty.ts";

interface InputMessage {
	type: "input";
	data: string;
}
interface ResizeMessage {
	type: "resize";
	cols: number;
	rows: number;
}
type ClientMessage = InputMessage | ResizeMessage;

function toText(raw: unknown): string | null {
	if (typeof raw === "string") return raw;
	if (raw instanceof Buffer) return raw.toString("utf8");
	if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
	return null;
}

function parseClientMessage(raw: unknown): ClientMessage | null {
	const text = toText(raw);
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const msg = parsed as Record<string, unknown>;
	if (msg.type === "input" && typeof msg.data === "string") {
		return { type: "input", data: msg.data };
	}
	if (
		msg.type === "resize" &&
		typeof msg.cols === "number" &&
		typeof msg.rows === "number"
	) {
		return { type: "resize", cols: msg.cols, rows: msg.rows };
	}
	return null;
}

export function createTerminalSocketHandlers(
	terminalId: string,
	options: { skipReplay?: boolean } = {},
): WSEvents<unknown> {
	let cleanup: () => void = () => {};

	return {
		onOpen(_evt, ws: WSContext<unknown>) {
			const session = getSession(terminalId);
			if (!session || session.exited) {
				ws.send(
					JSON.stringify({
						type: "error",
						message: "Terminal session not found",
					}),
				);
				ws.close();
				return;
			}

			ws.send(JSON.stringify({ type: "attached", terminalId }));

			// Replay scrollback so a newly-connected client sees history immediately
			// (skipped on reconnect once the client already holds it — see header).
			if (!options.skipReplay) {
				const buffer = session.getBuffer();
				if (buffer) ws.send(Buffer.from(buffer, "utf8"));
			}

			const offData = session.onData((chunk) => {
				ws.send(Buffer.from(chunk, "utf8"));
			});
			const offExit = session.onExit((exitCode) => {
				ws.send(JSON.stringify({ type: "exit", exitCode, signal: 0 }));
			});

			cleanup = () => {
				offData();
				offExit();
			};
		},

		onMessage(evt) {
			const session = getSession(terminalId);
			if (!session || session.exited) return;
			const msg = parseClientMessage(evt.data);
			if (!msg) return;
			if (msg.type === "input") {
				session.write(msg.data);
			} else {
				session.resize(msg.cols, msg.rows);
			}
		},

		onClose() {
			cleanup();
		},
	};
}
