// Wire framing + message shapes for the daemon <-> front-end Unix socket.
//
// A connection is either a CONTROL connection (spawn/list/kill/ping RPC, plus
// server-pushed status-changed/session-exited events) or an ATTACH connection
// (one per live terminal view: input/resize in, streamed PTY output + exit
// out) — never both, so each side always knows which message set to expect.
//
// Framing is the same for both: [4-byte BE length][1-byte tag][payload].
// `length` counts the tag byte plus payload. The tag distinguishes a JSON
// control message from a raw PTY-output binary frame (only ever sent
// daemon->client, on an attach connection, for scrollback replay + live data).
export const TAG_JSON = 0;
export const TAG_BINARY = 1;

export function encodeFrame(kind: "json" | "binary", payload: string | Buffer): Buffer {
	const tag = kind === "json" ? TAG_JSON : TAG_BINARY;
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const header = Buffer.alloc(5);
	header.writeUInt32BE(body.length + 1, 0);
	header.writeUInt8(tag, 4);
	return Buffer.concat([header, body]);
}

export function encodeJson(msg: unknown): Buffer {
	return encodeFrame("json", JSON.stringify(msg));
}

export interface DecodedFrame {
	kind: "json" | "binary";
	payload: Buffer;
}

/**
 * Incremental frame decoder — feed it socket chunks, get back complete
 * frames as they arrive. Necessary because a Unix socket delivers arbitrary
 * chunk boundaries with no relationship to message boundaries.
 */
export class FrameDecoder {
	private buf: Buffer = Buffer.alloc(0);

	push(chunk: Buffer, onFrame: (frame: DecodedFrame) => void): void {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		for (;;) {
			if (this.buf.length < 4) return;
			const len = this.buf.readUInt32BE(0);
			if (this.buf.length < 4 + len) return;
			const tag = this.buf.readUInt8(4);
			const payload = Buffer.from(this.buf.subarray(5, 4 + len));
			onFrame({ kind: tag === TAG_BINARY ? "binary" : "json", payload });
			this.buf = this.buf.subarray(4 + len);
		}
	}
}

// ---- control connection ----

export interface SpawnRequest {
	type: "spawn";
	reqId: number;
	terminalId: string;
	workspaceId: string;
	file: string;
	args: string[];
	cwd: string;
	cols?: number;
	rows?: number;
}
export interface ListRequest {
	type: "list";
	reqId: number;
	workspaceId?: string;
}
export interface KillRequest {
	type: "kill";
	reqId: number;
	terminalId: string;
}
export interface PingRequest {
	type: "ping";
	reqId: number;
}
export interface ShutdownRequest {
	type: "shutdown";
	reqId: number;
}
export type ControlRequest =
	| SpawnRequest
	| ListRequest
	| KillRequest
	| PingRequest
	| ShutdownRequest;

// Plain `Omit<ControlRequest, "reqId">` collapses the union to only its
// COMMON keys (Omit is Pick<T, Exclude<keyof T, K>>, and keyof a union is the
// intersection of each member's keys) — losing every variant-specific field.
// This distributes Omit over each member instead, so callers building a
// request still get SpawnRequest's `terminalId`/`file`/etc. as required.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ControlRequestInput = DistributiveOmit<ControlRequest, "reqId">;

export interface SessionInfo {
	id: string;
	workspaceId: string;
	exited: boolean;
	exitCode: number | null;
}

export interface ControlResult {
	type: "result";
	reqId: number;
	ok: boolean;
	error?: string;
	sessions?: SessionInfo[];
}
export interface StatusChangedPush {
	type: "status-changed";
	workspaceId: string;
}
export interface SessionExitedPush {
	type: "session-exited";
	terminalId: string;
	workspaceId: string;
	exitCode: number;
}
export type ControlPush = StatusChangedPush | SessionExitedPush;
export type ControlMessage = ControlResult | ControlPush;

// ---- attach connection ----

export interface AttachRequest {
	type: "attach";
	terminalId: string;
	skipReplay?: boolean;
}
export interface InputMessage {
	type: "input";
	data: string;
}
export interface ResizeMessage {
	type: "resize";
	cols: number;
	rows: number;
}
export type AttachClientMessage = AttachRequest | InputMessage | ResizeMessage;

export interface AttachedMessage {
	type: "attached";
	terminalId: string;
}
export interface ExitMessage {
	type: "exit";
	exitCode: number;
}
export interface ErrorMessage {
	type: "error";
	message: string;
}
export type AttachServerMessage = AttachedMessage | ExitMessage | ErrorMessage;
