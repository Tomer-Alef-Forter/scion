// Read-only file browser for a worktree: list files, then read one at a
// time, with a path-traversal guard so a crafted relative path can't escape
// the worktree directory.
import { stat as fsStat, readFile, realpath } from "node:fs/promises";
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

/** Read-only. Rejects absolute paths, any `..` segment, and — after resolving
 * symlinks — anything that escapes the worktree. */
export async function readWorktreeFile(worktreePath: string, relPath: string): Promise<string> {
	assertSafeRelativePath(relPath);
	const fullPath = join(worktreePath, relPath);

	// The string checks above stop `..`/absolute paths, but not a symlink INSIDE
	// the worktree pointing out (e.g. `link -> /etc/passwd`). Resolve real paths
	// and require the target to stay under the worktree root.
	const realRoot = await realpath(worktreePath);
	let realFull: string;
	try {
		realFull = await realpath(fullPath);
	} catch {
		throw new Error("File not found");
	}
	if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
		throw new Error("Path traversal is not allowed");
	}

	const info = await fsStat(realFull);
	if (!info.isFile()) {
		throw new Error("Not a file");
	}
	if (info.size > MAX_FILE_SIZE_BYTES) {
		throw new Error(`File too large to preview (${Math.round(info.size / 1024)} KB)`);
	}

	return readFile(realFull, "utf-8");
}
