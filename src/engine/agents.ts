// Assembles + launches the coding-agent CLI in a worktree PTY. We spawn each
// binary directly (no intermediate shell), so there's no shell quoting to
// worry about — the prompt is passed straight through as a plain argv
// positional.
import { randomUUID } from "node:crypto";
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
}

// Every agent skips its own interactive approval prompts, the same way
// Claude Code's --dangerously-skip-permissions does — the worktree is the
// safety boundary here (see docs), not per-action confirmation, so an
// unattended agent can actually make progress instead of blocking on stdin
// nobody's watching.
const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
	claude: {
		file: "claude",
		buildArgv({ prompt, resumeSessionId }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const resumeArgs = resumeSessionId ? ["--resume", resumeSessionId] : [];
			const base = ["--dangerously-skip-permissions", ...resumeArgs];
			return cleanPrompt ? [...base, cleanPrompt] : base;
		},
	},
	// Gemini CLI: `--yolo` auto-approves every action; `-i <prompt>` seeds an
	// interactive session with a prompt instead of exiting after one turn.
	// No hook/session-id system to resume from, so resumeSessionId is unused.
	// NOTE: flags are best-effort from Gemini CLI docs, not verified against a
	// live install here — check `gemini --help` if a launch fails.
	gemini: {
		file: "gemini",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--yolo"];
			return cleanPrompt ? [...base, "-i", cleanPrompt] : base;
		},
	},
	// Codex CLI: `--dangerously-bypass-approvals-and-sandbox` skips both
	// approval prompts and Codex's own sandbox (again, the worktree already
	// isolates it). No resume support here either.
	// NOTE: flags are best-effort from Codex CLI docs, not verified against a
	// live install here — check `codex --help` if a launch fails.
	codex: {
		file: "codex",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--dangerously-bypass-approvals-and-sandbox"];
			return cleanPrompt ? [...base, cleanPrompt] : base;
		},
	},
	// Cursor Agent, Droid, OpenCode, Copilot: like gemini/codex above, these
	// flags are best-effort from each CLI's own docs, not verified against a
	// live install here (Copilot's --allow-tool=write is the closest signal
	// of an approval-skipping flag; the others have no confirmed equivalent).
	// Check `--help` if a launch hangs waiting on a prompt nobody's watching.
	"cursor-agent": {
		file: "cursor-agent",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			return cleanPrompt ? [cleanPrompt] : [];
		},
	},
	droid: {
		file: "droid",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			return cleanPrompt ? [cleanPrompt] : [];
		},
	},
	opencode: {
		file: "opencode",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			return cleanPrompt ? ["--prompt", cleanPrompt] : [];
		},
	},
	copilot: {
		file: "copilot",
		buildArgv({ prompt }) {
			const cleanPrompt = prompt ? sanitizePrompt(prompt).trim() : "";
			const base = ["--allow-tool=write"];
			return cleanPrompt ? [...base, "-i", cleanPrompt] : base;
		},
	},
};

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
 * with `--resume <id>` instead of starting fresh; other agents ignore it (no
 * equivalent hook system to have captured a session id from).
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
