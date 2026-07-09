#!/usr/bin/env -S npx tsx
// Runs the backend (src/server/index.ts) and the Vite dev server together
// for local web development, with labeled output and synchronized shutdown.
//
// Spawns binaries DIRECTLY (not via `bun run <script>` wrappers) — a `bun
// run` wrapper is an extra process in between, and killing the wrapper does
// not reliably kill its child (observed firsthand: an orphaned Vite process
// outlived a killed `bun run dev` during manual testing).
import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
const VITE_BIN = join(ROOT, "web", "node_modules", ".bin", "vite");

const backend = spawn(TSX_BIN, ["src/server/index.ts"], {
	cwd: ROOT,
	stdio: ["inherit", "pipe", "pipe"],
});
const vite = spawn(VITE_BIN, [], {
	cwd: join(ROOT, "web"),
	stdio: ["inherit", "pipe", "pipe"],
});

function forward(stream: NodeJS.ReadableStream, label: string, out: NodeJS.WritableStream) {
	stream.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n")) {
			if (line.trim()) out.write(`[${label}] ${line}\n`);
		}
	});
}
forward(backend.stdout, "server", process.stdout);
forward(backend.stderr, "server", process.stderr);
forward(vite.stdout, "vite", process.stdout);
forward(vite.stderr, "vite", process.stderr);

let shuttingDown = false;
function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	backend.kill("SIGTERM");
	vite.kill("SIGTERM");
	setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
backend.on("exit", (code) => {
	if (shuttingDown) return;
	console.error(`[web-dev] server exited (${code}) — stopping vite`);
	shutdown(code ?? 1);
});
vite.on("exit", (code) => {
	if (shuttingDown) return;
	console.error(`[web-dev] vite exited (${code}) — stopping server`);
	shutdown(code ?? 1);
});
