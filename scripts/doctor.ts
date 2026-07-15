#!/usr/bin/env -S npx tsx
// Preflight check: verify the environment can actually run Scion before a user
// hits a cryptic failure mid-launch. The most common one is a `better-sqlite3`
// native binding built for the wrong runtime (installing under Bun, then
// running under Node) — we detect that specifically and print the one-line fix.
//
// Exit code 0 = good to go; 1 = at least one hard requirement failed.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Level = "ok" | "warn" | "fail";
const results: { level: Level; label: string; detail?: string }[] = [];
const record = (level: Level, label: string, detail?: string) =>
	results.push({ level, label, detail });

function which(cmd: string): string | null {
	try {
		return execFileSync("command", ["-v", cmd], {
			shell: "/bin/bash",
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
}

// --- Node version (native deps target the current LTS ABIs) ---
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (major >= 20) record("ok", `Node ${process.versions.node}`);
else
	record(
		"fail",
		`Node ${process.versions.node} is too old`,
		"Scion needs Node 20+. Install a current LTS (e.g. via nvm/n/fnm) and retry.",
	);

// --- Required CLIs ---
for (const cmd of ["git", "gh", "claude"]) {
	if (which(cmd)) record("ok", `${cmd} found`);
	else if (cmd === "claude")
		record(
			"fail",
			"claude CLI not found",
			"Install the Claude Code CLI and log in (`claude`), then retry.",
		);
	else if (cmd === "gh")
		record(
			"warn",
			"gh (GitHub CLI) not found",
			"PR creation and the PR-status view need `gh`; everything else works without it.",
		);
	else record("fail", "git not found", "Install git and retry.");
}

// --- Native binding: better-sqlite3 must load under THIS runtime ---
try {
	require("better-sqlite3");
	record("ok", "better-sqlite3 native binding loads");
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	const looksLikeAbiMismatch = /NODE_MODULE_VERSION|bindings|\.node/i.test(msg);
	record(
		"fail",
		"better-sqlite3 native binding failed to load",
		looksLikeAbiMismatch
			? "The binding was built for a different runtime (this happens when deps are installed under Bun but run under Node). Fix: `npm rebuild better-sqlite3`"
			: `Unexpected error: ${msg}`,
	);
}

// --- Report ---
const glyph = { ok: "✓", warn: "!", fail: "✗" } as const;
for (const r of results) {
	console.log(`  ${glyph[r.level]} ${r.label}`);
	if (r.detail) console.log(`      → ${r.detail}`);
}

const failed = results.filter((r) => r.level === "fail");
console.log("");
if (failed.length === 0) {
	console.log("scion doctor: environment looks good ✓");
	process.exit(0);
}
console.log(`scion doctor: ${failed.length} problem(s) must be fixed before running.`);
process.exit(1);
