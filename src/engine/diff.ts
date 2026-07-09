// Diff/status helpers, adapted from superset host-service git/git.ts +
// git/utils/git-helpers.ts (resolveBaseComparison / merge-base). Rendering is
// done by shelling `git diff --color` (superset renders via @pierre/diffs in a
// GUI; a TUI just wants the colored patch).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUserSimpleGit } from "./gitClient.ts";
import { resolveDefaultBranch } from "./worktrees.ts";

const execFileAsync = promisify(execFile);

/** Base branch for a worktree: recorded `branch.<b>.base` config, else default. */
export async function getBaseBranch(
	repoPath: string,
	worktreePath: string,
): Promise<string> {
	const git = createUserSimpleGit(worktreePath);
	const branch = (
		await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "")
	).trim();
	if (branch && branch !== "HEAD") {
		const configured = (
			await git.raw(["config", `branch.${branch}.base`]).catch(() => "")
		).trim();
		if (configured) return configured;
	}
	return resolveDefaultBranch(repoPath);
}

async function mergeBase(worktreePath: string, base: string): Promise<string> {
	const git = createUserSimpleGit(worktreePath);
	return (
		await git.raw(["merge-base", base, "HEAD"]).then((s) => s.trim()).catch(() => base)
	);
}

export interface DiffSummary {
	filesChanged: number;
	insertions: number;
	deletions: number;
	uncommitted: number;
}

/** Files/insertions/deletions vs the merge-base, plus uncommitted file count. */
export async function getDiffSummary(
	repoPath: string,
	worktreePath: string,
): Promise<DiffSummary> {
	const git = createUserSimpleGit(worktreePath);
	const base = await getBaseBranch(repoPath, worktreePath);
	const origin = await mergeBase(worktreePath, base);

	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	const numstat = await git
		.raw(["diff", "--numstat", origin])
		.catch(() => "");
	for (const line of numstat.trim().split("\n")) {
		if (!line) continue;
		const [add, del] = line.split("\t");
		filesChanged++;
		insertions += Number.parseInt(add ?? "0", 10) || 0;
		deletions += Number.parseInt(del ?? "0", 10) || 0;
	}

	const status = await git.raw(["status", "--porcelain"]).catch(() => "");
	const uncommitted = status.trim() ? status.trim().split("\n").length : 0;

	return { filesChanged, insertions, deletions, uncommitted };
}

/** Colored unified diff from the merge-base to the working tree. */
export async function getColoredDiff(
	repoPath: string,
	worktreePath: string,
): Promise<string> {
	const base = await getBaseBranch(repoPath, worktreePath);
	const origin = await mergeBase(worktreePath, base);
	const { stdout } = await execFileAsync(
		"git",
		["--no-pager", "-c", "color.ui=always", "diff", origin],
		{ cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 },
	).catch(() => ({ stdout: "" }));
	return stdout || "(no changes vs base)";
}

/**
 * Uncolored unified diff from the merge-base to the working tree, for clients
 * (the web UI) that want to render/highlight the diff themselves rather than
 * consume ANSI escape codes.
 */
export async function getUnifiedDiff(
	repoPath: string,
	worktreePath: string,
): Promise<string> {
	const base = await getBaseBranch(repoPath, worktreePath);
	const origin = await mergeBase(worktreePath, base);
	const { stdout } = await execFileAsync(
		"git",
		["--no-pager", "-c", "color.ui=never", "diff", origin],
		{ cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 },
	).catch(() => ({ stdout: "" }));
	return stdout;
}

/** True when the worktree has no uncommitted changes. */
export async function isClean(worktreePath: string): Promise<boolean> {
	const git = createUserSimpleGit(worktreePath);
	const status = await git.raw(["status", "--porcelain"]).catch(() => "x");
	return status.trim() === "";
}
