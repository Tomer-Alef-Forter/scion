// Localhost receiver for Claude lifecycle hooks. notify.sh POSTs here with a
// `{ json: { terminalId, eventType, agent } }` envelope (the outer `json`
// wrapper is just kept as a stable, versionable shape for the payload).
//
// Binds the preferred port, but falls back to an ephemeral port if it's taken
// (e.g. a second instance) instead of crashing on EADDRINUSE. The resolved URL
// is published via setHookUrl so launched agents post to the right place.
import { createServer, type Server } from "node:http";
import { HOOK_PORT } from "./config.ts";
import { getSession } from "./engine/pty.ts";
import type { StatusStore } from "./engine/status.ts";
import { setHookUrl } from "./hookAddr.ts";

export function startHookServer(status: StatusStore): Promise<Server> {
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.startsWith("/hook")) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			try {
				const body = JSON.parse(raw);
				const payload = body.json ?? body;
				const { terminalId, eventType } = payload;
				if (terminalId && eventType) {
					const workspaceId = getSession(terminalId)?.workspaceId;
					if (workspaceId) {
						status.recordEvent({
							terminalId,
							workspaceId,
							agentId: payload.agent?.agentId || "claude",
							agentSessionId: payload.agent?.sessionId,
							eventType,
						});
					}
				}
			} catch {
				// Ignore malformed payloads — a bad POST must never crash us.
			}
			res.statusCode = 200;
			res.end("ok");
		});
	});

	return new Promise((resolve, reject) => {
		let retriedEphemeral = false;

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE" && !retriedEphemeral) {
				// Preferred port is taken (another instance?). Fall back to an
				// OS-assigned free port rather than crashing.
				retriedEphemeral = true;
				server.listen(0, "127.0.0.1");
				return;
			}
			reject(err);
		});

		server.on("listening", () => {
			const addr = server.address();
			const port = addr && typeof addr === "object" ? addr.port : HOOK_PORT;
			setHookUrl(`http://127.0.0.1:${port}/hook`);
			resolve(server);
		});

		server.listen(HOOK_PORT, "127.0.0.1");
	});
}
