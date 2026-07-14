// Client for /ws/events — pushes {type:"status", workspaceId} whenever an
// agent's status changes, so the dashboard updates live instead of polling.
// Simple reconnect-on-close (no backoff tuning needed — this carries no
// critical byte stream, just a "something changed, go refetch" signal).
import { withAuthParam } from "./auth";

export interface StatusChangeMessage {
	type: "status";
	workspaceId: string;
}

export function subscribeToStatusEvents(
	onChange: (workspaceId: string) => void,
): () => void {
	let socket: WebSocket | null = null;
	let disposed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	function connect() {
		if (disposed) return;
		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		const url = withAuthParam(new URL(`${protocol}://${window.location.host}/ws/events`));
		socket = new WebSocket(url.toString());
		socket.onmessage = (event) => {
			try {
				const msg = JSON.parse(String(event.data)) as StatusChangeMessage;
				if (msg.type === "status" && msg.workspaceId) onChange(msg.workspaceId);
			} catch {
				// ignore malformed messages
			}
		};
		socket.onclose = () => {
			if (disposed) return;
			reconnectTimer = setTimeout(connect, 1000);
		};
	}
	connect();

	return () => {
		disposed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.close();
	};
}
