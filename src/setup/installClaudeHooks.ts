// Installs Claude Code lifecycle hooks so agent status reports back to us.
// Merges our hook commands into ~/.claude/settings.json without clobbering
// any hooks the user already has configured there, and writes
// ~/.scion/hooks/notify.sh (see notify.sh for what it does at runtime).
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

/** The shell command Claude actually runs for each managed hook event. */
function managedHookCommand(): string {
	return `[ -n "$SCION_HOME_DIR" ] && [ -x "$SCION_HOME_DIR/hooks/notify.sh" ] && SCION_AGENT_ID=claude "$SCION_HOME_DIR/hooks/notify.sh" || true`;
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

/** The one HookDef we install per managed event, some with a wildcard matcher. */
function buildManagedHookDefs(command: string): Record<string, HookDef> {
	const plain: HookDef = { hooks: [{ type: "command", command }] };
	const wildcard: HookDef = { matcher: "*", hooks: [{ type: "command", command }] };
	return {
		SessionStart: plain,
		SessionEnd: plain,
		UserPromptSubmit: plain,
		Stop: plain,
		PostToolUse: wildcard,
		PostToolUseFailure: wildcard,
		PermissionRequest: wildcard,
	};
}

/** Drop our own hook entries from a previously-installed list, keeping everything else untouched. */
function withoutManagedHooks(defs: HookDef[]): HookDef[] {
	const kept: HookDef[] = [];
	for (const def of defs) {
		if (!Array.isArray(def.hooks)) {
			kept.push(def);
			continue;
		}
		const remaining = def.hooks.filter((hook) => !isManagedCommand(hook.command));
		if (remaining.length === 0) continue; // this def was ONLY our own hook(s)
		kept.push(remaining.length === def.hooks.length ? def : { ...def, hooks: remaining });
	}
	return kept;
}

function readExistingSettings(): Settings | null {
	if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
	} catch (err) {
		console.warn("[setup] could not parse ~/.claude/settings.json; skipping:", err);
		return null;
	}
	if (!isObj(parsed)) {
		console.warn(
			"[setup] ~/.claude/settings.json is not a JSON object; skipping hook merge",
		);
		return null;
	}
	return parsed as Settings;
}

/** Merge our hooks into ~/.claude/settings.json, preserving the user's own. */
export function installClaudeSettings(): void {
	const settings = readExistingSettings();
	if (settings === null) return;
	if (!isObj(settings.hooks)) settings.hooks = {};

	const managedDefs = buildManagedHookDefs(managedHookCommand());
	for (const [eventName, ourDef] of Object.entries(managedDefs)) {
		const priorDefs = settings.hooks[eventName];
		const survivors = Array.isArray(priorDefs) ? withoutManagedHooks(priorDefs) : [];
		settings.hooks[eventName] = [...survivors, ourDef];
	}

	mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
	writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
		mode: 0o644,
	});
}

export function installClaudeHooks(): void {
	installNotifyScript();
	installClaudeSettings();
}
