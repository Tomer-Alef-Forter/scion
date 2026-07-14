import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Optional locally-trusted HTTPS. Generate the cert once with mkcert into
// ~/.scion/certs (see README/setup), and vite serves https automatically;
// with no cert present it falls back to plain http, so this never breaks a
// fresh checkout that hasn't set one up.
const CERT_DIR = join(homedir(), ".scion", "certs");
const KEY_PATH = join(CERT_DIR, "scion.test-key.pem");
const CERT_PATH = join(CERT_DIR, "scion.test.pem");
const https =
	existsSync(KEY_PATH) && existsSync(CERT_PATH)
		? { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) }
		: undefined;

// Safe by default: bind the dev server to IPv4 loopback only, matching the
// backend (src/config.ts WEB_HOST). This still serves localhost, 127.0.0.1,
// and a custom hostname mapped to 127.0.0.1 in /etc/hosts (like scion.test),
// but is NOT reachable from the LAN. Set SCION_HOST=0.0.0.0 to opt into network
// access — the backend then requires a shared-secret token (see
// src/server/auth.ts / docs/WEB_GUIDE.md); do NOT expose the dev server to the
// LAN without also running the backend in that authenticated network mode.
const host = process.env.SCION_HOST?.trim() || "127.0.0.1";

// Dev proxy forwards /api and /ws to the backend server (src/server/index.ts,
// port 5177) so the browser sees everything same-origin.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		host,
		https,
		// Vite rejects Host headers it doesn't recognize; allow the local
		// custom domain (mapped to 127.0.0.1 via /etc/hosts) so scion.test:5173
		// works. localhost/127.0.0.1 are always allowed regardless.
		allowedHosts: ["scion.test"],
		proxy: {
			"/api": "http://127.0.0.1:5177",
			"/ws": {
				target: "ws://127.0.0.1:5177",
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
	},
});
