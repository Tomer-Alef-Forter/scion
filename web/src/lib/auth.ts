// Client-side handling of the shared-secret token used when the backend is
// exposed over the network (SCION_HOST set to a non-loopback host — see
// src/server/auth.ts). The server hands the token to the user out-of-band
// (printed on startup); the user opens the UI once as `…/?token=<token>`, and
// this captures it into localStorage so every subsequent /api and /ws request
// carries it.
//
// In the default localhost-only setup the backend requires NO token, so this
// simply returns null and nothing is attached — zero config for local use.
const STORAGE_KEY = "scion-auth-token";

let cached: string | null | undefined;

/** The stored token, or null when running in the default no-auth local mode. */
export function getAuthToken(): string | null {
	if (cached !== undefined) return cached;
	cached = resolveToken();
	return cached;
}

function resolveToken(): string | null {
	try {
		const url = new URL(window.location.href);
		const fromUrl = url.searchParams.get("token");
		if (fromUrl) {
			localStorage.setItem(STORAGE_KEY, fromUrl);
			// Strip it from the address bar so it doesn't linger in history or
			// get copied into a shared link.
			url.searchParams.delete("token");
			window.history.replaceState({}, "", url.toString());
			return fromUrl;
		}
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/** Auth headers for fetch — empty in the default local (no-token) mode. */
export function authHeaders(): Record<string, string> {
	const token = getAuthToken();
	return token ? { "x-scion-token": token } : {};
}

/**
 * Append the token to a WebSocket URL as a query param (browsers can't set
 * custom headers on a WS handshake). No-op in the default local mode.
 */
export function withAuthParam(url: URL): URL {
	const token = getAuthToken();
	if (token) url.searchParams.set("token", token);
	return url;
}
