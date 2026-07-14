// Pre-approves a freshly created worktree in Claude Code's own per-directory
// trust store (~/.claude.json), so opening it doesn't hit the interactive
// "do you trust the files in this folder?" dialog. Every Scion worktree is a
// brand-new directory the first time it's created, and it's a worktree of a
// project the user already added to Scion — re-asking per worktree is pure
// friction, not a real trust boundary, and `--permission-mode auto`
// (see engine/agents.ts) doesn't cover this dialog since it's a separate
// mechanism from per-tool-call permissions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Marks a worktree path trusted, preserving everything else in the file untouched. */
export function trustWorktree(worktreePath: string): void {
	if (!existsSync(CLAUDE_CONFIG_PATH)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, "utf-8"));
	} catch {
		return; // don't clobber a file we can't safely round-trip
	}
	if (!isObj(parsed)) return;

	if (!isObj(parsed.projects)) parsed.projects = {};
	const allProjects = parsed.projects as Record<string, unknown>;
	const existingEntry = isObj(allProjects[worktreePath]) ? allProjects[worktreePath] : {};
	if ((existingEntry as Record<string, unknown>).hasTrustDialogAccepted === true) return;

	allProjects[worktreePath] = { ...existingEntry, hasTrustDialogAccepted: true };
	writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(parsed, null, 2));
}
