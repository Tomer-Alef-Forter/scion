// Assembles + launches the coding-agent CLI in a worktree PTY. We spawn each
// binary directly (no intermediate shell), so there's no shell quoting to
// worry about — the prompt is passed straight through as a plain argv
// positional.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import type { AgentType } from "../db/schema.ts";
import type { PtyBackend } from "./ptyBackend.ts";

/**
 * A prompt typed into our UI shouldn't be able to inject terminal escape
 * sequences into the PTY it gets forwarded to, and CRLF/tabs from a pasted
 * multi-line prompt should render predictably once inside it. `strip-ansi`
 * covers CSI/OSC escapes; the rest is normalized here.
 */
export function sanitizePrompt(prompt: string): string {
	return stripAnsi(prompt)
		.replace(/\r\n?/g, "\n")
		// biome-ignore lint: stripping remaining non-printable control chars intentionally
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replaceAll("\t", "    ");
}

interface AgentArgvArgs {
	prompt?: string;
	resumeSessionId?: string | null;
}

interface AgentConfig {
	file: string;
	buildArgv(args: AgentArgvArgs): string[];
	/**
	 * Optional side effect run in the worktree before spawning, for agents
	 * whose auto-approval mode isn't a CLI flag at all but a config file (see
	 * `droid` below). Most agents don't need this.
	 */
	prepareLaunch?(worktreePath: string): void;
}

// Every agent launches in an auto-approving mode — the worktree is the safety
// boundary here (see docs), not per-action confirmation, so an unattended
// agent can actually make progress instead of blocking on stdin nobody's
// watching. For Claude Code that's `--permission-mode auto` (the same mode its
// own editor integrations use); the other CLIs have their own equivalents.
//
// Verification status as of 2026-07 (no live install of gemini, codex,
// cursor-agent, droid, opencode, or copilot was available in the environment
// this was last audited from — every flag below was cross-checked against
// each project's own current official docs/README instead, with links in the
// per-agent comments; still worth a live `--help` smoke test before trusting
// blindly). Claude remains the only one verified against a real install.
const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
	claude: {
		file: "claude",
		buildArgv({ prompt, resumeSessionId }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const resumeArgs = resumeSessionId ? ["--resume", resumeSessionId] : [];
			const base = ["--permission-mode", "auto", ...resumeArgs];
			return cleanPrompt ? [...base, cleanPrompt] : base;
		},
	},
	// Gemini CLI (google-gemini/gemini-cli): `--approval-mode=yolo` auto-approves
	// every action; `-i <prompt>` (--prompt-interactive) seeds an interactive
	// session with a prompt instead of exiting after one turn (confirmed
	// distinct from `-p/--prompt`, which forces non-interactive one-shot mode).
	// Verified against the current cli-reference.md on the google-gemini/gemini-cli
	// GitHub repo (stable v0.50.0, 2026-07): the old `--yolo`/`-y` flag we used to
	// pass is explicitly marked Deprecated there in favor of `--approval-mode=yolo`
	// (still functions today, but likely to be removed eventually).
	// Resume: gemini supports `--resume <id|index|"latest">`, but SCION doesn't
	// wire it up — there's no hook installed to capture gemini's session id (see
	// engine/status.ts `agentSessionId`, which only Claude's hooks populate), and
	// combining `--resume` with our `-i <prompt>` seeding flag in one invocation
	// isn't confirmed by the docs (their own example combines it with a bare
	// positional prompt instead). Gemini does ship a real hooks system
	// (settings.json `hooks`, events include SessionStart/SessionEnd,
	// BeforeAgent/AfterAgent, Notification for tool-permission-requested) that's
	// a concrete path to real status reporting analogous to Claude's — see the
	// note in server/api.ts next to `derivedStatus`.
	gemini: {
		file: "gemini",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--approval-mode=yolo"];
			return cleanPrompt ? [...base, "-i", cleanPrompt] : base;
		},
	},
	// Codex CLI (openai/codex): `--dangerously-bypass-approvals-and-sandbox`
	// skips both approval prompts and Codex's own sandbox (again, the worktree
	// already isolates it), and a bare positional argument seeds the interactive
	// TUI with an initial prompt. Verified against the current CLI reference at
	// developers.openai.com/codex/cli/reference (~v0.144, 2026-07): both are
	// still current (the flag has a `--yolo` alias but no rename/deprecation),
	// and plain `codex <prompt>` launches the TUI pre-filled — not the separate
	// non-interactive `codex exec` subcommand.
	// Resume: `codex resume <SESSION_ID>` (or `--last`) exists, but isn't wired
	// up here for the same reason as gemini — no hook captures codex's session
	// id, and it's unconfirmed whether `codex resume <id>` accepts an additional
	// seed prompt/flag in the same invocation the way `claude --resume <id>
	// <prompt>` does. Codex also ships a real hooks system (PreToolUse,
	// PermissionRequest, Stop, etc., configurable via hooks.json) and a
	// JSON-RPC `codex app-server` mode with structured turn/tool-call/approval
	// events — both concrete paths to real status reporting; see the note in
	// server/api.ts next to `derivedStatus`.
	codex: {
		file: "codex",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--dangerously-bypass-approvals-and-sandbox"];
			return cleanPrompt ? [...base, cleanPrompt] : base;
		},
	},
	// Cursor Agent CLI (cursor.com/docs/cli): previously launched with NO
	// auto-approval flag at all, which is a real bug — it would sit blocked on
	// the first file-edit/command confirmation with nobody watching stdin.
	// Verified against cursor.com/docs/cli/reference/parameters (2026-07):
	// `--force` (alias `--yolo`) is "Force allow commands unless explicitly
	// denied", and `--trust` is needed too since SCION hands cursor-agent a
	// brand-new worktree directory each run and `--trust` is documented as
	// "Skip prompts in headless environments" for that one-time
	// workspace-trust prompt specifically. A bare positional prompt (as used
	// here) is confirmed correct for "seed + stay interactive" — `-p/--print`
	// is the one-shot-and-exit mode and is deliberately not used.
	// Resume: `cursor-agent --resume <chatId> "<prompt>"` is documented
	// (combining resume + a new prompt in one invocation, unlike the other
	// non-Claude agents above), so it's wired up here — but note `agentType
	// !== "claude"` workspaces never actually populate `resumeSessionId` today
	// (see engine/status.ts `agentSessionId`), so this path is currently
	// unreachable until cursor-agent's own hook system (`.cursor/hooks.json`,
	// e.g. `sessionStart`/`stop`/`beforeShellExecution`) is wired into
	// SCION's status reporting — docs describe this hooks system but don't
	// explicitly confirm every event fires for the local CLI (vs. IDE/Cloud
	// Agents only), so treat that as unconfirmed rather than a ready-to-wire
	// mechanism.
	"cursor-agent": {
		file: "cursor-agent",
		buildArgv({ prompt, resumeSessionId }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const resumeArgs = resumeSessionId ? ["--resume", resumeSessionId] : [];
			const base = ["--force", "--trust", ...resumeArgs];
			return cleanPrompt ? [...base, cleanPrompt] : base;
		},
	},
	// Droid CLI (Factory, docs.factory.ai): previously launched with NO
	// auto-approval flag either — same real hang-on-first-confirmation bug as
	// cursor-agent above. The fix isn't a flag, though: droid's `--auto
	// <low|medium|high>` is documented only for the separate one-shot `droid
	// exec` subcommand, not for plain interactive `droid` (which is what SCION
	// wants — an interactive session left open, seeded via a bare positional
	// prompt, confirmed correct in the CLI reference). Interactive-mode
	// autonomy is controlled by a `.factory/settings.json` config file
	// (`sessionDefaultSettings.autonomyLevel`) instead, so `prepareLaunch`
	// below writes that into the worktree before spawn, without clobbering an
	// autonomy level the repo/user may have already configured there.
	// Resume: `droid --resume [sessionId]` (alias `-r`) is documented for
	// interactive mode, but — same caveat as cursor-agent — it's not wired up
	// here since no hook captures droid's session id yet, and it's unconfirmed
	// whether `--resume <id>` composes with a fresh seed prompt in the same
	// call. Droid does ship a real hooks system (PreToolUse, PostToolUse,
	// Notification, Stop, SessionStart/SessionEnd, configured the same way as
	// the settings file below) — a concrete path to real status reporting, see
	// the note in server/api.ts next to `derivedStatus`.
	droid: {
		file: "droid",
		prepareLaunch(worktreePath) {
			ensureDroidAutonomyConfig(worktreePath);
		},
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			return cleanPrompt ? [cleanPrompt] : [];
		},
	},
	// OpenCode (opencode.ai, formerly sst/opencode): `--prompt <text>` is a
	// top-level flag that seeds the interactive TUI and leaves it open —
	// verified against opencode.ai/docs/cli/ (2026-07) — `opencode run
	// <message>` is a distinct, genuinely non-interactive one-shot subcommand
	// and would exit immediately instead, so it's deliberately not used here.
	// Previously launched with no auto-approval flag, the same real
	// hang-on-first-confirmation bug as cursor-agent/droid above; fixed by
	// adding `--auto` ("Auto-approve permissions that are not explicitly
	// denied"), documented and supported on plain `opencode` as well as
	// `opencode run`.
	// Resume: `--continue`/`-c` and `--session <id>`/`-s` are documented, but
	// not wired up here for the same reason as the others — no hook captures
	// opencode's session id yet. OpenCode's own event/status mechanism is the
	// richest of the bunch: a plugin system (JS/TS files under
	// `.opencode/plugins/`) with events like `session.idle`, `permission.asked`,
	// `tool.execute.before/after`, plus an HTTP server mode (`opencode serve`)
	// exposing a pollable `GET /session/status` and an SSE `GET /event` stream
	// — no config-only hook exists the way Claude's/gemini's/codex's/droid's do,
	// it requires shipping an actual plugin file, which is real, buildable work
	// but a distinct feature from this audit; see the note in server/api.ts
	// next to `derivedStatus`.
	opencode: {
		file: "opencode",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--auto"];
			return cleanPrompt ? [...base, "--prompt", cleanPrompt] : base;
		},
	},
	// GitHub Copilot CLI (`@github/copilot`, docs.github.com/copilot): `-i
	// <prompt>` is confirmed correct for "start an interactive session and
	// automatically execute this prompt" (`-p/--prompt` is the separate
	// exits-after-completion mode). `--allow-tool=write` was a real bug,
	// though — per docs.github.com's "Allowing and denying tool use" page,
	// the `write` tool kind explicitly excludes shell command execution
	// ("tools that create and modify files, except shell tool invocations"),
	// so a shell command would still block on confirmation with nobody
	// watching. Fixed by switching to `--allow-all` (documented alias
	// `--yolo`, equivalent to `--allow-all-tools --allow-all-paths
	// --allow-all-urls`) so no approval gate — tool kind, path, or URL scope —
	// can hang the session.
	// Resume: `--resume[=ID]`/`-r` and `--continue` are real CLI flags (not
	// just an in-session `/resume`), but not wired up here — no hook captures
	// copilot's session id yet. Copilot's status story is the weakest of the
	// bunch: `--output-format=json` + `--log-level`/`--log-dir` are official,
	// but the richer `~/.copilot/session-state/{id}/events.jsonl` activity
	// stream (which reportedly has Working/Idle/NeedsInput/Problem states) is
	// undocumented/internal — there's an open upstream GitHub issue
	// (github/copilot-cli#3551) asking GitHub to formalize it as a real API,
	// which is a signal it isn't stable enough to build on yet.
	copilot: {
		file: "copilot",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--allow-all"];
			return cleanPrompt ? [...base, "-i", cleanPrompt] : base;
		},
	},
};

/**
 * Merges `{ sessionDefaultSettings: { autonomyLevel: "high" } }` into the
 * worktree's `.factory/settings.json` so droid's interactive REPL doesn't
 * default to its read-only/spec-mode autonomy level (which has no CLI-flag
 * override — see the `droid` comment above). Preserves everything else in an
 * existing file untouched, and never overwrites an autonomy level the
 * repo/user already set explicitly.
 */
function ensureDroidAutonomyConfig(worktreePath: string): void {
	const dir = join(worktreePath, ".factory");
	const settingsPath = join(dir, "settings.json");

	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed as Record<string, unknown>;
			} else {
				return; // not an object — don't touch a file we don't understand
			}
		} catch {
			return; // unparsable — don't clobber whatever's there
		}
	}

	const existingDefaults = settings.sessionDefaultSettings;
	const sessionDefaults =
		existingDefaults && typeof existingDefaults === "object" && !Array.isArray(existingDefaults)
			? { ...(existingDefaults as Record<string, unknown>) }
			: {};

	if (sessionDefaults.autonomyLevel) return; // respect an explicit choice already there

	sessionDefaults.autonomyLevel = "high";
	settings.sessionDefaultSettings = sessionDefaults;

	mkdirSync(dir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Builds the argv for launching a given agent CLI. Exported (pure, no spawn)
 * so each agent's flag handling is unit-testable without spawning the real
 * binary.
 */
export function buildAgentArgv(agentType: AgentType, args: AgentArgvArgs): string[] {
	return AGENT_CONFIGS[agentType].buildArgv(args);
}

export function buildClaudeArgv(args: AgentArgvArgs): string[] {
	return buildAgentArgv("claude", args);
}

export interface LaunchResult {
	terminalId: string;
}

/**
 * Launch the given agent CLI in the worktree. When `resumeSessionId` is set
 * (a prior Claude session_id captured from the lifecycle hook — see
 * engine/status.ts `agentSessionId`), Claude Code resumes that conversation
 * with `--resume <id>` instead of starting fresh; other agents ignore it in
 * practice today even where their own argv-building supports a `--resume`
 * equivalent (see per-agent comments above), because nothing yet captures a
 * session id for them to resume from — only Claude has a hook installed
 * (src/setup/installClaudeHooks.ts).
 */
export async function launchAgent(args: {
	backend: PtyBackend;
	agentType: AgentType;
	workspaceId: string;
	worktreePath: string;
	prompt?: string;
	resumeSessionId?: string | null;
	cols?: number;
	rows?: number;
}): Promise<LaunchResult> {
	const terminalId = randomUUID();
	const config = AGENT_CONFIGS[args.agentType];
	config.prepareLaunch?.(args.worktreePath);
	const argv = config.buildArgv(args);

	await args.backend.spawnSession({
		id: terminalId,
		workspaceId: args.workspaceId,
		file: config.file,
		args: argv,
		cwd: args.worktreePath,
		cols: args.cols,
		rows: args.rows,
	});

	return { terminalId };
}
