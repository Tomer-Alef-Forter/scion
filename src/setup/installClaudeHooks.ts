// Installs Claude Code lifecycle hooks so agent status reports back to us.
// Adapted from superset apps/desktop/.../agent-wrappers-claude-codex-opencode.ts
// (getClaudeManagedHookCommand + getClaudeGlobalSettingsJsonContent +
// createClaudeSettingsJson). Merges into ~/.claude/settings.json without
// clobbering user hooks, and writes ~/.superset-local/hooks/notify.sh.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, NOTIFY_SCRIPT_PATH } from "../config.ts";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const NOTIFY_TEMPLATE = fileURLToPath(new URL("./notify.sh", import.meta.url));

/** Runtime-resolved hook command (from getClaudeManagedHookCommand). */
function managedHookCommand(): string {
	return `[ -n "$SUPERSET_HOME_DIR" ] && [ -x "$SUPERSET_HOME_DIR/hooks/notify.sh" ] && SUPERSET_AGENT_ID=claude "$SUPERSET_HOME_DIR/hooks/notify.sh" || true`;
}

function isManagedCommand(command: string | undefined): boolean {
	return !!command && command.includes("hooks/notify.sh");
}

interface HookConfig {
	type: "command";
	command: string;
	[k: string]: unknown;
}
interface HookDef {
	matcher?: string;
	hooks?: HookConfig[];
	[k: string]: unknown;
}
interface Settings {
	hooks?: Record<string, HookDef[]>;
	[k: string]: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Write notify.sh into the data dir and make it executable. */
export function installNotifyScript(): void {
	mkdirSync(HOOKS_DIR, { recursive: true });
	copyFileSync(NOTIFY_TEMPLATE, NOTIFY_SCRIPT_PATH);
	chmodSync(NOTIFY_SCRIPT_PATH, 0o755);
}

/** Merge Superset hooks into ~/.claude/settings.json (preserving user hooks). */
export function installClaudeSettings(): void {
	let existing: Settings = {};
	if (existsSync(CLAUDE_SETTINGS_PATH)) {
		try {
			const parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
			if (!isObj(parsed)) {
				console.warn(
					"[setup] ~/.claude/settings.json is not a JSON object; skipping hook merge",
				);
				return;
			}
			existing = parsed as Settings;
		} catch (err) {
			console.warn("[setup] could not parse ~/.claude/settings.json; skipping:", err);
			return;
		}
	}

	if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
	const command = managedHookCommand();

	const managedEvents: Array<{ eventName: string; def: HookDef }> = [
		{ eventName: "SessionStart", def: { hooks: [{ type: "command", command }] } },
		{ eventName: "SessionEnd", def: { hooks: [{ type: "command", command }] } },
		{ eventName: "UserPromptSubmit", def: { hooks: [{ type: "command", command }] } },
		{ eventName: "Stop", def: { hooks: [{ type: "command", command }] } },
		{ eventName: "PostToolUse", def: { matcher: "*", hooks: [{ type: "command", command }] } },
		{ eventName: "PermissionRequest", def: { matcher: "*", hooks: [{ type: "command", command }] } },
	];

	for (const { eventName, def } of managedEvents) {
		const current = existing.hooks[eventName];
		if (Array.isArray(current)) {
			// Drop any prior superset-managed entries, keep user hooks, re-add ours.
			const filtered = current.flatMap((d) => {
				if (!Array.isArray(d.hooks)) return [d];
				const keep = d.hooks.filter((h) => !isManagedCommand(h.command));
				if (keep.length === d.hooks.length) return [d];
				return keep.length ? [{ ...d, hooks: keep }] : [];
			});
			filtered.push(def);
			existing.hooks[eventName] = filtered;
		} else {
			existing.hooks[eventName] = [def];
		}
	}

	mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
	writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(existing, null, 2), {
		mode: 0o644,
	});
}

export function installClaudeHooks(): void {
	installNotifyScript();
	installClaudeSettings();
}
