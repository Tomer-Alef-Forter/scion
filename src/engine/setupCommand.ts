// Runs a project's configured setup command (e.g. `npm install`, `cp
// .env.example .env`) once, in a new workspace's worktree, BEFORE the agent
// launches — see store/projects.ts's createWorkspace. Deliberately a fully
// standalone step: the command is never interpolated into the agent's own
// launch (which would need safely quoting a user-typed prompt inside a shell
// string — a real mistake-prone surface for a one-line convenience feature).
// Non-blocking: a failure or timeout never stops workspace creation, only
// surfaces a warning.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SETUP_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 2000;

export type SetupCommandResult = { ok: true } | { ok: false; message: string };

export async function runSetupCommand(
	worktreePath: string,
	command: string,
): Promise<SetupCommandResult> {
	try {
		await execFileAsync("sh", ["-c", command], {
			cwd: worktreePath,
			timeout: SETUP_TIMEOUT_MS,
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, message: `Setup command failed: ${describeError(err)}` };
	}
}

function describeError(err: unknown): string {
	if (err && typeof err === "object") {
		const e = err as {
			killed?: boolean;
			signal?: string | null;
			stderr?: string;
			stdout?: string;
			message?: string;
		};
		if (e.killed && e.signal) return `timed out after ${SETUP_TIMEOUT_MS / 1000}s`;
		const output = (e.stderr || e.stdout || e.message || String(err)).toString();
		return output.slice(-OUTPUT_TAIL_CHARS).trim();
	}
	return String(err);
}
