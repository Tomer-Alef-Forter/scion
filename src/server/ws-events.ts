// Pushes agent-status change notifications to the browser over /ws/events, so
// the dashboard updates without polling. Payload is just the workspaceId that
// changed — the client refetches that workspace's row via the REST API.
import type { WSContext, WSEvents } from "hono/ws";
import type { StatusStore } from "../engine/status.ts";

export function createEventsSocketHandlers(
	status: StatusStore,
): WSEvents<unknown> {
	let cleanup: () => void = () => {};

	return {
		onOpen(_evt, ws: WSContext<unknown>) {
			const onChange = (workspaceId: string) => {
				ws.send(JSON.stringify({ type: "status", workspaceId }));
			};
			status.events.on("change", onChange);
			cleanup = () => {
				status.events.off("change", onChange);
			};
		},

		onClose() {
			cleanup();
		},
	};
}
