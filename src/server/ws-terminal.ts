// PTY <-> WebSocket bridge for /ws/terminal/:terminalId. This end and the
// browser client (web/src/lib/TerminalConnection.ts) both belong to us, so
// the wire protocol is whatever's simplest to implement on both sides:
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
import type { AttachHandle, PtyBackend } from "../engine/ptyBackend.ts";

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
	backend: PtyBackend,
	options: { skipReplay?: boolean } = {},
): WSEvents<unknown> {
	let handle: AttachHandle | null = null;

	return {
		async onOpen(_evt, ws: WSContext<unknown>) {
			// backend.attach() handles scrollback replay itself (as the first
			// onData emission, unless skipReplay) — both backends implement it,
			// so there's nothing left for this file to do beyond wiring the
			// handle's callbacks to the socket.
			const attached = await backend.attach(terminalId, { skipReplay: options.skipReplay });
			if (!attached) {
				ws.send(
					JSON.stringify({
						type: "error",
						message: "Terminal session not found",
					}),
				);
				ws.close();
				return;
			}
			handle = attached;

			ws.send(JSON.stringify({ type: "attached", terminalId }));

			handle.onData((chunk) => {
				ws.send(Buffer.from(chunk, "utf8"));
			});
			handle.onExit((exitCode) => {
				ws.send(JSON.stringify({ type: "exit", exitCode, signal: 0 }));
			});
		},

		onMessage(evt) {
			if (!handle) return;
			const msg = parseClientMessage(evt.data);
			if (!msg) return;
			if (msg.type === "input") {
				handle.write(msg.data);
			} else {
				handle.resize(msg.cols, msg.rows);
			}
		},

		onClose() {
			handle?.close();
		},
	};
}
