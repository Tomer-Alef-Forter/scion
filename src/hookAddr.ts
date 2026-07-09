// The hook receiver's URL, resolved at runtime once the server binds (the port
// may differ from the preferred one if it was taken). pty.ts reads this when
// launching an agent so notify.sh POSTs to the right place. Kept in its own
// module to avoid a hookServer <-> pty import cycle.
import { HOOK_PORT } from "./config.ts";

let hookUrl = `http://127.0.0.1:${HOOK_PORT}/hook`;

export function getHookUrl(): string {
	return hookUrl;
}

export function setHookUrl(url: string): void {
	hookUrl = url;
}
