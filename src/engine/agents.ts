// Assembles + launches the Claude Code agent in a worktree PTY.
// Adapted from superset builtin-terminal-agents.ts (the "claude" definition)
// and agents.ts (buildAgentCommandString). Because we spawn the binary
// directly (no intermediate shell), there's no shell quoting — the prompt is
// passed as a plain argv positional (superset's "argv" transport).
import { randomUUID } from "node:crypto";
import { spawnSession } from "./pty.ts";

// From superset packages/shared/src/builtin-terminal-agents.ts:
//   { id: "claude", command: "claude --dangerously-skip-permissions" }
const CLAUDE_FILE = "claude";
const CLAUDE_ARGS = ["--dangerously-skip-permissions"];

/**
 * Sanitize a prompt destined for the agent. Copied from superset
 * agent-prompt-launch.ts (sanitizePromptForPty): strip ANSI/control chars,
 * normalize newlines, expand tabs.
 */
export function sanitizePrompt(prompt: string): string {
	return (
		prompt
			.replace(/\r\n?/g, "\n")
			// biome-ignore lint: stripping ANSI/control sequences intentionally
			.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
			// biome-ignore lint: stripping OSC sequences intentionally
			.replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)/g, "")
			// biome-ignore lint: stripping remaining control chars intentionally
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
			.replaceAll("\t", "    ")
	);
}

export interface LaunchResult {
	terminalId: string;
}

/** Launch `claude --dangerously-skip-permissions [prompt]` in the worktree. */
export function launchClaude(args: {
	workspaceId: string;
	worktreePath: string;
	prompt?: string;
	cols?: number;
	rows?: number;
}): LaunchResult {
	const terminalId = randomUUID();
	const prompt = args.prompt ? sanitizePrompt(args.prompt).trim() : "";
	const argv = prompt ? [...CLAUDE_ARGS, prompt] : [...CLAUDE_ARGS];

	spawnSession({
		id: terminalId,
		workspaceId: args.workspaceId,
		file: CLAUDE_FILE,
		args: argv,
		cwd: args.worktreePath,
		cols: args.cols,
		rows: args.rows,
	});

	return { terminalId };
}
