// Installs Claude Code lifecycle hooks so agent status reports back to us.
// Merges our hook commands into ~/.claude/settings.json without clobbering
// any hooks the user already has configured there, and writes
// ~/.scion/hooks/notify.sh (see notify.sh for what it does at runtime).
//
// This is global (~/.claude/settings.json applies to every Claude Code
// session on the machine, not just Scion-launched ones), so every installed
// command is a no-op outside a Scion session (gated on $SCION_HOME_DIR — see
// notify.sh) and is tagged with MANAGED_MARKER below so it's identifiable at
// a glance and so `uninstallClaudeHooks` can remove exactly what we added,
// nothing the user configured independently. Run `bun run uninstall-hooks`
// to remove it.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, INSTALLED_MARKER, NOTIFY_SCRIPT_PATH } from "../config.ts";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const NOTIFY_TEMPLATE = fileURLToPath(new URL("./notify.sh", import.meta.url));

/**
 * A comment prepended to every command we install, purely so a human (or
 * `withoutManagedHooks`) can identify a Scion-managed hook entry at a glance
 * inside ~/.claude/settings.json. It's inert shell — Claude runs the command
 * via a shell that treats a leading `#…` line as a comment — and doubles as
 * the marker uninstall matches on, which is more specific than grepping for
 * the notify.sh path (a user could plausibly reference that path themselves).
 */
const MANAGED_MARKER =
	"# scion-managed hook (no-op outside a Scion session; remove via: bun run uninstall-hooks)";

/** The shell command Claude actually runs for each managed hook event. */
function managedHookCommand(): string {
	return [
		MANAGED_MARKER,
		`[ -n "$SCION_HOME_DIR" ] && [ -x "$SCION_HOME_DIR/hooks/notify.sh" ] && SCION_AGENT_ID=claude "$SCION_HOME_DIR/hooks/notify.sh" || true`,
	].join("\n");
}

function isManagedCommand(command: string | undefined): boolean {
	return !!command && command.includes(MANAGED_MARKER);
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

/** Delete ~/.scion/hooks/notify.sh, if present. Safe to call when absent. */
export function uninstallNotifyScript(): void {
	if (existsSync(NOTIFY_SCRIPT_PATH)) rmSync(NOTIFY_SCRIPT_PATH);
}

/**
 * Remove exactly the hook entries `installClaudeSettings` added from
 * ~/.claude/settings.json, leaving everything else (including hooks the user
 * configured independently, even ones that reuse an event name we manage)
 * untouched. Safe/idempotent: a missing file, an already-clean file, or an
 * unparsable file are all no-ops rather than errors.
 */
export function uninstallClaudeSettings(): void {
	const settings = readExistingSettings();
	if (settings === null || !isObj(settings.hooks)) return;

	for (const [eventName, defs] of Object.entries(settings.hooks)) {
		if (!Array.isArray(defs)) continue;
		const survivors = withoutManagedHooks(defs);
		if (survivors.length === 0) delete settings.hooks[eventName];
		else settings.hooks[eventName] = survivors;
	}
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

	writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
		mode: 0o644,
	});
}

/**
 * Full uninstall: strips our hook entries from ~/.claude/settings.json,
 * deletes ~/.scion/hooks/notify.sh, and clears the "already installed"
 * marker so the next `bun start` / `bun run web` reinstalls cleanly instead
 * of silently staying uninstalled.
 */
export function uninstallClaudeHooks(): void {
	uninstallClaudeSettings();
	uninstallNotifyScript();
	if (existsSync(INSTALLED_MARKER)) rmSync(INSTALLED_MARKER);
}
