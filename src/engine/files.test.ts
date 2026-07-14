import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorktreeFile } from "./files.ts";

// These exercise readWorktreeFile's path-traversal guard against a real,
// throwaway directory tree — plain fs operations, not a real git repo/PTY/CLI
// process, so this stays fast and hermetic.
describe("readWorktreeFile path-traversal guard", () => {
	let worktreePath: string;

	beforeEach(async () => {
		worktreePath = await mkdtemp(join(tmpdir(), "scion-files-test-"));
		await writeFile(join(worktreePath, "hello.txt"), "hello world");
		await mkdir(join(worktreePath, "sub"));
		await writeFile(join(worktreePath, "sub", "nested.txt"), "nested content");
		// A sibling file OUTSIDE the worktree, to make sure traversal attempts
		// that would reach it are rejected before ever touching the filesystem.
		await writeFile(join(worktreePath, "..", "secret-sibling.txt"), "should never be read");
	});

	afterEach(async () => {
		await rm(worktreePath, { recursive: true, force: true });
		await rm(join(worktreePath, "..", "secret-sibling.txt"), { force: true });
	});

	it("reads a plain relative file inside the worktree", async () => {
		await expect(readWorktreeFile(worktreePath, "hello.txt")).resolves.toBe("hello world");
	});

	it("reads a nested relative file inside the worktree", async () => {
		await expect(readWorktreeFile(worktreePath, "sub/nested.txt")).resolves.toBe(
			"nested content",
		);
	});

	it("rejects an absolute path", async () => {
		await expect(readWorktreeFile(worktreePath, "/etc/passwd")).rejects.toThrow(
			"Absolute paths are not allowed",
		);
	});

	it("rejects a simple .. traversal", async () => {
		await expect(readWorktreeFile(worktreePath, "../secret-sibling.txt")).rejects.toThrow(
			"Path traversal is not allowed",
		);
	});

	it("rejects a .. traversal buried inside a deeper relative path", async () => {
		await expect(
			readWorktreeFile(worktreePath, "sub/../../secret-sibling.txt"),
		).rejects.toThrow("Path traversal is not allowed");
	});

	it("rejects a .. traversal disguised with a trailing legitimate-looking segment", async () => {
		await expect(readWorktreeFile(worktreePath, "sub/../../etc/passwd")).rejects.toThrow(
			"Path traversal is not allowed",
		);
	});

	it("rejects reading the worktree root itself ('.')", async () => {
		await expect(readWorktreeFile(worktreePath, ".")).rejects.toThrow(
			"Cannot read the worktree root",
		);
	});

	it("rejects reading the worktree root itself ('')", async () => {
		await expect(readWorktreeFile(worktreePath, "")).rejects.toThrow(
			"Cannot read the worktree root",
		);
	});

	it("rejects a non-existent (but otherwise safe) relative path", async () => {
		await expect(readWorktreeFile(worktreePath, "does-not-exist.txt")).rejects.toThrow();
	});

	it("rejects a directory path (not a file)", async () => {
		await expect(readWorktreeFile(worktreePath, "sub")).rejects.toThrow("Not a file");
	});
});
