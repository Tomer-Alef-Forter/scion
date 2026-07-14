// Shared-secret authentication for the web control surface. This is the real
// security boundary when the server is exposed beyond loopback (SCION_HOST set
// to a non-loopback host) — the CORS check in app.ts is only a browser
// convention and does NOT stop a raw curl/WebSocket client.
//
// The token gates BOTH the REST API (/api/*) and, crucially, the WebSocket
// routes (/ws/terminal/:id, /ws/events) — the terminal socket is the most
// dangerous surface, since it can type arbitrary input into any live agent.
//
// When bound to loopback only, no token is generated and no middleware is
// installed (same-machine trust model): the default, zero-config local
// experience is unauthenticated on purpose.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { AUTH_TOKEN_PATH } from "../config.ts";

/**
 * Load the persisted shared secret, generating (and persisting, 0600) one on
 * first use. Idempotent across restarts so a token handed to a browser once
 * keeps working.
 */
export function loadOrCreateAuthToken(path: string = AUTH_TOKEN_PATH): string {
	if (existsSync(path)) {
		const existing = readFileSync(path, "utf8").trim();
		if (existing) return existing;
	}
	const token = randomBytes(32).toString("hex");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, token, { mode: 0o600 });
	return token;
}

// Browsers can't set custom headers on a WebSocket handshake, so the token has
// to be accepted from a query param too — that's the only way to authenticate
// /ws/*. HTTP callers should prefer the Authorization/x-scion-token headers.
function extractToken(c: Context): string | null {
	const authz = c.req.header("authorization");
	if (authz?.startsWith("Bearer ")) return authz.slice("Bearer ".length).trim();
	const headerToken = c.req.header("x-scion-token");
	if (headerToken) return headerToken.trim();
	const queryToken = c.req.query("token");
	if (queryToken) return queryToken.trim();
	return null;
}

function tokensMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	// timingSafeEqual throws on length mismatch — guard first so a wrong-length
	// guess just fails instead of erroring, while still avoiding a short-circuit
	// on the equal-length compare.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Hono middleware that rejects any request whose token doesn't match. Install
 * this on both `/api/*` and `/ws/*` (see app.ts). Applied only in network mode.
 */
export function createAuthMiddleware(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		const provided = extractToken(c);
		if (!provided || !tokensMatch(provided, expectedToken)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		return next();
	};
}
