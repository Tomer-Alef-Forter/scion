// Worktree git operations, adapted from superset host-service:
//   workspaces/workspaces.ts (addBranchWorktree),
//   workspace-creation/shared/worktree-paths.ts,
//   workspace-cleanup/workspace-cleanup.ts (removal).
// Cloud registration + DB writes stripped — callers persist rows themselves.
import { mkdirSync, rmdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { WORKTREES_ROOT } from "../config.ts";
import { createUserSimpleGit } from "./gitClient.ts";

/** `<WORKTREES_ROOT>/<projectId>/<branch>` with a path-traversal guard. */
export function safeResolveWorktreePath(
	projectId: string,
	branchName: string,
): string {
	const projectRoot = resolve(WORKTREES_ROOT, projectId);
	const worktreePath = resolve(projectRoot, branchName);
	if (
		worktreePath !== projectRoot &&
		!worktreePath.startsWith(projectRoot + sep)
	) {
		throw new Error(`Invalid branch name: path traversal detected (${branchName})`);
	}
	return worktreePath;
}

export interface WorktreeEntry {
	path: string;
	branch: string | null;
	head: string | null;
}

/** Parse `git worktree list --porcelain`. */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
	const git = createUserSimpleGit(repoPath);
	const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
	const entries: WorktreeEntry[] = [];
	let cur: Partial<WorktreeEntry> = {};
	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (cur.path) entries.push(cur as WorktreeEntry);
			cur = { path: line.slice("worktree ".length), branch: null, head: null };
		} else if (line.startsWith("HEAD ")) {
			cur.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	if (cur.path) entries.push(cur as WorktreeEntry);
	return entries;
}

/** Best-effort default branch: origin/HEAD → main → master → current. */
export async function resolveDefaultBranch(repoPath: string): Promise<string> {
	const git = createUserSimpleGit(repoPath);
	const originHead = (
		await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]).catch(() => "")
	).trim();
	if (originHead) return originHead.replace(/^refs\/remotes\/origin\//, "");

	for (const name of ["main", "master"]) {
		const exists = await git
			.raw(["rev-parse", "--verify", `refs/heads/${name}`])
			.then(() => true)
			.catch(() => false);
		if (exists) return name;
	}
	const current = (
		await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "")
	).trim();
	return current && current !== "HEAD" ? current : "main";
}

export interface AddWorktreeResult {
	worktreePath: string;
	branch: string;
	baseBranch: string;
}

/**
 * Create a new branch + worktree.
 * Mirrors superset's `addBranchWorktree` new-branch path:
 *   git worktree add --no-track -b <branch> <path> <startPoint>
 */
export async function addWorktree(args: {
	projectId: string;
	repoPath: string;
	branch: string;
	baseBranch?: string;
}): Promise<AddWorktreeResult> {
	const git = createUserSimpleGit(args.repoPath);
	const baseBranch = args.baseBranch ?? (await resolveDefaultBranch(args.repoPath));
	const worktreePath = safeResolveWorktreePath(args.projectId, args.branch);
	mkdirSync(dirname(worktreePath), { recursive: true });

	// Free branches still claimed by registrations whose dirs are gone.
	await git.raw(["worktree", "prune"]).catch(() => {});

	// checkout.workers=0 parallelizes the worktree's initial file checkout
	// across CPU cores — a large repo's `worktree add` is otherwise
	// single-threaded and dominates workspace-creation latency (measured
	// ~2.5x faster on a 28GB/13k-file repo).
	await git.raw([
		"-c",
		"checkout.workers=0",
		"worktree",
		"add",
		"--no-track",
		"-b",
		args.branch,
		worktreePath,
		baseBranch,
	]);

	// Record base branch so diff/merge can find it later (superset convention).
	await git
		.raw(["-C", worktreePath, "config", `branch.${args.branch}.base`, baseBranch])
		.catch(() => {});

	return { worktreePath, branch: args.branch, baseBranch };
}

/**
 * Remove any now-empty directories between `worktreePath` and its
 * `<projectId>` container — a slash in the branch name (e.g. "feat/smoke")
 * means `worktreePath` is nested a level deeper than `mkdirSync` in
 * addWorktree created, and `git worktree remove` only deletes the leaf,
 * leaving empty intermediate dirs behind otherwise.
 */
function pruneEmptyParents(worktreePath: string): void {
	const projectDir = dirname(dirname(worktreePath)); // one level ABOVE <projectId> is never touched
	let dir = dirname(worktreePath);
	while (dir !== projectDir && dir.length > projectDir.length) {
		try {
			rmdirSync(dir);
		} catch {
			break; // not empty (or already gone) — stop walking up
		}
		dir = dirname(dir);
	}
}

/** Remove a worktree: `git worktree remove --force --force` then prune. */
export async function removeWorktree(args: {
	repoPath: string;
	worktreePath: string;
	deleteBranch?: string | null;
}): Promise<void> {
	const git = createUserSimpleGit(args.repoPath);
	await git
		.raw(["worktree", "remove", "--force", "--force", args.worktreePath])
		.catch(() => {});
	await git.raw(["worktree", "prune"]).catch(() => {});
	pruneEmptyParents(args.worktreePath);
	if (args.deleteBranch) {
		await git.raw(["branch", "-D", args.deleteBranch]).catch(() => {});
	}
}
