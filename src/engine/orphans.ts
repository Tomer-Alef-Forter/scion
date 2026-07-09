// Orphaned worktree directories: `worktrees/<projectId>/<branch>` dirs on
// disk with no matching `workspaces` row — left behind when a project row
// (cascade-deletes its workspaces) or a workspace row was removed without
// the worktree itself being cleaned up (deleteWorkspace's `git worktree
// remove` can fail silently, or the row was wiped some other way). Also
// sweeps up empty leftover directories: a branch name with a "/" (e.g.
// "feat/smoke") nests the worktree a level deeper than the `<projectId>`
// container, and `git worktree remove` only deletes the leaf, so a stray
// empty intermediate dir can outlive it.
import { existsSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { WORKTREES_ROOT } from "../config.ts";
import type { Project } from "../db/schema.ts";
import { removeWorktree } from "./worktrees.ts";

export interface OrphanedWorktree {
	projectId: string;
	path: string;
}

function dirs(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

/** A linked worktree's root has a `.git` FILE (containing `gitdir: ...`),
 * unlike a normal repo/plain directory where `.git` (if present) is a dir. */
function isWorktreeRoot(path: string): boolean {
	try {
		return statSync(join(path, ".git")).isFile();
	} catch {
		return false;
	}
}

function findWorktreeRoots(dir: string, out: string[]): void {
	if (isWorktreeRoot(dir)) {
		out.push(dir);
		return; // don't recurse into an actual worktree's own working tree
	}
	for (const name of dirs(dir)) findWorktreeRoots(join(dir, name), out);
}

/** Every real worktree checkout under `worktrees/<projectId>/**` with no
 * matching workspace row — found by walking to arbitrary depth rather than
 * assuming a fixed structure, since branch names may contain "/". */
export function findOrphanedWorktrees(
	knownWorktreePaths: Set<string>,
): OrphanedWorktree[] {
	const orphans: OrphanedWorktree[] = [];
	for (const projectId of dirs(WORKTREES_ROOT)) {
		const roots: string[] = [];
		findWorktreeRoots(join(WORKTREES_ROOT, projectId), roots);
		for (const path of roots) {
			if (!knownWorktreePaths.has(path)) orphans.push({ projectId, path });
		}
	}
	return orphans;
}

/**
 * Remove one orphaned worktree. If its project still exists, properly
 * deregisters it via `git worktree remove` (keeps the branch); otherwise
 * there's no repo left to run git against, so it's a best-effort `rm -rf`.
 */
export async function removeOrphanedWorktree(
	orphan: OrphanedWorktree,
	projects: Project[],
): Promise<void> {
	const project = projects.find((p) => p.id === orphan.projectId);
	if (project) {
		await removeWorktree({
			repoPath: project.repoPath,
			worktreePath: orphan.path,
			deleteBranch: null,
		});
	} else {
		await rm(orphan.path, { recursive: true, force: true });
	}
}

/** Recursively remove empty directories under WORKTREES_ROOT (bottom-up) —
 * sweeps up intermediate-branch-segment dirs and empty `<projectId>` dirs
 * left behind by past runs, including ones from before removeWorktree
 * started pruning these itself. */
export function pruneEmptyWorktreeDirs(): number {
	let removed = 0;
	function walk(dir: string): void {
		if (isWorktreeRoot(dir)) return; // never descend into a real worktree's contents
		for (const name of dirs(dir)) walk(join(dir, name));
		try {
			rmdirSync(dir); // throws ENOTEMPTY if it still has real contents
			removed++;
		} catch {
			// not empty (or already gone) — leave it
		}
	}
	for (const projectId of dirs(WORKTREES_ROOT)) {
		walk(join(WORKTREES_ROOT, projectId));
	}
	return removed;
}
