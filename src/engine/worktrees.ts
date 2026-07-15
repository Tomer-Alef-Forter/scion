// Git worktree operations: create/remove a linked worktree for a workspace,
// and the small amount of path/branch bookkeeping that goes with it. Callers
// own persisting any of this to the DB — nothing here touches storage.
import { mkdirSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { WORKTREES_ROOT } from "../config.ts";
import { createUserSimpleGit } from "./gitClient.ts";

/** `<WORKTREES_ROOT>/<projectId>/<branch>`, refusing to resolve outside its project dir. */
export function safeResolveWorktreePath(projectId: string, branchName: string): string {
	const projectRoot = resolve(WORKTREES_ROOT, projectId);
	const worktreePath = resolve(projectRoot, branchName);
	const rel = relative(projectRoot, worktreePath);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
		throw new Error(`Invalid branch name: path traversal detected (${branchName})`);
	}
	return worktreePath;
}

export interface WorktreeEntry {
	path: string;
	branch: string | null;
	head: string | null;
}

/**
 * Parse `git worktree list --porcelain` output: one blank-line-separated
 * block per worktree, each a run of `key value` lines.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
	const git = createUserSimpleGit(repoPath);
	const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");

	return raw
		.split(/\n\n+/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => {
			const entry: WorktreeEntry = { path: "", branch: null, head: null };
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) {
					entry.path = line.slice("worktree ".length);
				} else if (line.startsWith("HEAD ")) {
					entry.head = line.slice("HEAD ".length);
				} else if (line.startsWith("branch ")) {
					entry.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
				}
			}
			return entry;
		})
		.filter((entry) => entry.path.length > 0);
}

/** Best-effort default branch: `origin/HEAD` → `main` → `master` → whatever's currently checked out. */
export async function resolveDefaultBranch(repoPath: string): Promise<string> {
	const git = createUserSimpleGit(repoPath);

	const originHead = await git
		.raw(["symbolic-ref", "refs/remotes/origin/HEAD"])
		.then((ref) => ref.trim().replace(/^refs\/remotes\/origin\//, ""))
		.catch(() => "");
	if (originHead) return originHead;

	for (const candidate of ["main", "master"]) {
		const exists = await git
			.raw(["rev-parse", "--verify", `refs/heads/${candidate}`])
			.then(() => true)
			.catch(() => false);
		if (exists) return candidate;
	}

	const current = await git
		.revparse(["--abbrev-ref", "HEAD"])
		.then((branch) => branch.trim())
		.catch(() => "");
	return current && current !== "HEAD" ? current : "main";
}

export interface AddWorktreeResult {
	worktreePath: string;
	branch: string;
	baseBranch: string;
}

/** Create a new branch and check it out into a fresh linked worktree. */
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

	// Clear out registrations for worktrees whose directories are already
	// gone, so their branch names are free to reuse.
	await git.raw(["worktree", "prune"]).catch(() => {});

	// checkout.workers=0 lets git use all CPU cores for the initial file
	// checkout instead of a single thread — on a large repo this is the
	// dominant cost of creating a workspace (~2.5x faster measured on a
	// 28GB/13k-file repo).
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

	// Stash the base branch in the worktree's own git config so a later diff
	// or merge for this workspace can find it without us tracking it
	// elsewhere.
	await git
		.raw(["-C", worktreePath, "config", `branch.${args.branch}.base`, baseBranch])
		.catch(() => {});

	return { worktreePath, branch: args.branch, baseBranch };
}

/**
 * Walk up from `worktreePath` removing now-empty directories, stopping at
 * (and never touching) the `<projectId>` container itself. A branch name
 * containing "/" (e.g. "feat/smoke") puts the worktree a level or more below
 * its project dir, and `git worktree remove` only ever deletes the leaf
 * directory it created — this cleans up whatever that leaves behind.
 */
function pruneEmptyParents(worktreePath: string): void {
	const projectDir = dirname(dirname(worktreePath));
	let dir = dirname(worktreePath);
	while (dir.length > projectDir.length && dir !== projectDir) {
		try {
			rmdirSync(dir);
		} catch {
			return; // still has contents (or already gone) — nothing more to do
		}
		dir = dirname(dir);
	}
}

/** Deregister a worktree and optionally delete its branch. */
export async function removeWorktree(args: {
	repoPath: string;
	worktreePath: string;
	deleteBranch?: string | null;
}): Promise<void> {
	const git = createUserSimpleGit(args.repoPath);
	// --force twice: once to discard uncommitted changes in the worktree,
	// again because git also refuses to remove a worktree it can't confirm
	// is clean (e.g. if the directory was already partially deleted).
	await git.raw(["worktree", "remove", "--force", "--force", args.worktreePath]).catch(() => {});
	await git.raw(["worktree", "prune"]).catch(() => {});
	pruneEmptyParents(args.worktreePath);
	if (args.deleteBranch) {
		await git.raw(["branch", "-D", args.deleteBranch]).catch(() => {});
	}
}
