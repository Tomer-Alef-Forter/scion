// Client for a workspace's terminal WebSocket: owns the reconnect lifecycle
// (exponential backoff, pausing while the tab is hidden, resuming on
// visibility/focus/online) so WebTerminal.tsx just gets a steady stream of
// bytes/control messages and never has to think about a dropped connection.
//
// Built as a plain factory function returning {send, dispose} — the same
// connect-with-a-reconnect-timer shape as lib/eventsSocket.ts — plus the
// extra state this stream actually needs that a "just refetch on change"
// signal doesn't: a generation counter (so a stale in-flight connect() from
// before a reconnect can't clobber a newer socket), and a `terminated` flag
// once the PTY itself has exited (no point reconnecting to a dead process).
export type TerminalConnectionState = "connecting" | "reconnecting" | "error";

export type TerminalControlMessage =
	| { type: "attached"; terminalId: string }
	| { type: "title"; title: string | null }
	| { type: "error"; message: string }
	| { type: "exit"; exitCode: number; signal: number };

type TerminalClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number };

interface TerminalConnectionTarget {
	workspaceId: string;
	terminalId: string;
}

interface TerminalConnectionHandlers {
	onBinary: (bytes: Uint8Array) => void;
	onControl: (message: TerminalControlMessage) => void;
	onStateChange: (state: TerminalConnectionState) => void;
}

export interface TerminalConnection {
	send(message: TerminalClientMessage): void;
	dispose(): void;
}

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 12;

// Same-origin `/ws/terminal/:terminalId` — no auth token or relay hop, since
// this server only ever talks to the one local user running it.
function buildTerminalUrl(target: TerminalConnectionTarget, skipReplay: boolean): string {
	const protocol = window.location.protocol === "https:" ? "wss" : "ws";
	const url = new URL(
		`${protocol}://${window.location.host}/ws/terminal/${encodeURIComponent(target.terminalId)}`,
	);
	url.searchParams.set("workspaceId", target.workspaceId);
	// xterm already holds the scrollback locally on a reconnect — skip the
	// server's replay dump once we know we've already gotten it once.
	if (skipReplay) url.searchParams.set("replay", "0");
	return url.toString();
}

export function createTerminalConnection(
	target: TerminalConnectionTarget,
	handlers: TerminalConnectionHandlers,
): TerminalConnection {
	let socket: WebSocket | null = null;
	let state: TerminalConnectionState = "connecting";
	let generation = 0;
	let reconnectAttempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let hasReceivedBytes = false;
	let everAttached = false;
	let terminated = false;
	let disposed = false;

	function setState(next: TerminalConnectionState): void {
		if (state === next) return;
		state = next;
		handlers.onStateChange(next);
	}

	function cancelReconnectTimer(): void {
		if (reconnectTimer === null) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	function teardownSocket(): void {
		const current = socket;
		socket = null;
		if (!current) return;
		current.onmessage = null;
		current.onclose = null;
		try {
			current.close();
		} catch {
			// best-effort
		}
	}

	function scheduleReconnect(): void {
		if (reconnectTimer !== null || terminated || disposed) return;
		if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
			setState("error");
			return;
		}
		setState("reconnecting");
		// A backgrounded/frozen tab doesn't reliably run timers — the
		// visibility/focus/online listeners below reconnect immediately on
		// resume instead, so don't spend an attempt on a timer that may never
		// actually fire.
		if (document.hidden) return;

		const delay = Math.min(
			INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
			MAX_RECONNECT_DELAY_MS,
		);
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	}

	function connect(): void {
		if (disposed || terminated) return;
		cancelReconnectTimer();
		teardownSocket();
		const myGeneration = ++generation;
		setState(everAttached ? "reconnecting" : "connecting");

		let next: WebSocket;
		try {
			next = new WebSocket(buildTerminalUrl(target, hasReceivedBytes));
		} catch {
			scheduleReconnect();
			return;
		}
		// dispose()/a newer connect() could have run synchronously above (they
		// don't here, but nothing guarantees a future refactor keeps it that
		// way) — bail rather than wire up listeners for a socket nobody wants.
		if (myGeneration !== generation || disposed || terminated) {
			next.close();
			return;
		}
		next.binaryType = "arraybuffer";
		socket = next;

		next.onmessage = (event) => {
			if (socket !== next) return;
			if (event.data instanceof ArrayBuffer) {
				hasReceivedBytes = true;
				handlers.onBinary(new Uint8Array(event.data));
				return;
			}
			let message: TerminalControlMessage;
			try {
				message = JSON.parse(String(event.data)) as TerminalControlMessage;
			} catch {
				return;
			}
			if (message.type === "attached") {
				reconnectAttempt = 0;
				everAttached = true;
			} else if (message.type === "exit" || message.type === "error") {
				terminated = true;
				cancelReconnectTimer();
			}
			handlers.onControl(message);
		};

		next.onclose = () => {
			if (socket !== next) return;
			socket = null;
			if (terminated || disposed) return;
			scheduleReconnect();
		};
	}

	function resume(): void {
		if (disposed || terminated || document.hidden) return;
		reconnectAttempt = 0;
		if (
			socket &&
			(socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
		) {
			return;
		}
		cancelReconnectTimer();
		connect();
	}

	document.addEventListener("visibilitychange", resume);
	document.addEventListener("resume", resume);
	window.addEventListener("pageshow", resume);
	window.addEventListener("online", resume);
	connect();

	return {
		send(message) {
			if (!socket || socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify(message));
		},
		dispose() {
			disposed = true;
			cancelReconnectTimer();
			document.removeEventListener("visibilitychange", resume);
			document.removeEventListener("resume", resume);
			window.removeEventListener("pageshow", resume);
			window.removeEventListener("online", resume);
			teardownSocket();
		},
	};
}
