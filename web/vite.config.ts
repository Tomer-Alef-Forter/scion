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

// Dev proxy forwards /api and /ws to the backend server (src/server/index.ts,
// port 5177) so the browser sees everything same-origin.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		// Listen on all interfaces (IPv4 + IPv6), not just IPv6 localhost —
		// otherwise a custom hostname mapped to 127.0.0.1 (IPv4) in /etc/hosts,
		// like scion.test, can't reach a vite that's bound only to ::1.
		host: true,
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
