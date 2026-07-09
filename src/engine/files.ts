// Read-only file browser for a worktree. Additive engine module — nothing
// existing changes. Path-traversal guard adapted from Superset's
// `assertSafeRelativePath` (host-service git.ts).
import { stat as fsStat, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { createUserSimpleGit } from "./gitClient.ts";

export interface FileEntry {
	path: string;
}

/**
 * Tracked + untracked-but-not-ignored files (so node_modules/.git/build
 * output never appear — the same rule `git status` itself follows).
 */
export async function listFiles(worktreePath: string): Promise<FileEntry[]> {
	const git = createUserSimpleGit(worktreePath);
	const [tracked, untracked] = await Promise.all([
		git.raw(["ls-files"]).catch(() => ""),
		git.raw(["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
	]);

	const paths = new Set<string>();
	for (const line of tracked.split("\n")) {
		if (line.trim()) paths.add(line.trim());
	}
	for (const line of untracked.split("\n")) {
		if (line.trim()) paths.add(line.trim());
	}

	return [...paths].sort().map((path) => ({ path }));
}

function assertSafeRelativePath(relPath: string): void {
	if (isAbsolute(relPath)) {
		throw new Error("Absolute paths are not allowed");
	}
	const normalized = normalize(relPath);
	if (normalized.split(sep).includes("..")) {
		throw new Error("Path traversal is not allowed");
	}
	if (normalized === "" || normalized === ".") {
		throw new Error("Cannot read the worktree root");
	}
}

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB — avoid choking the browser

/** Read-only. Rejects absolute paths and any `..` segment. */
export async function readWorktreeFile(
	worktreePath: string,
	relPath: string,
): Promise<string> {
	assertSafeRelativePath(relPath);
	const fullPath = join(worktreePath, relPath);

	const info = await fsStat(fullPath);
	if (!info.isFile()) {
		throw new Error("Not a file");
	}
	if (info.size > MAX_FILE_SIZE_BYTES) {
		throw new Error(
			`File too large to preview (${Math.round(info.size / 1024)} KB)`,
		);
	}

	return readFile(fullPath, "utf-8");
}
