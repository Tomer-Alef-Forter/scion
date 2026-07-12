// Wrapper around simple-git so every caller gets the same options instead of
// each repeating them. We always run as the logged-in user against their own,
// already-trusted repo (not an attacker-supplied one), so simple-git's
// "unsafe operation" guards — added in its 3.x line to block things like
// custom config paths, credential helpers, and hook paths by default — are
// opt-outs we want everywhere, not something to remember per call.
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";

// Every `allowUnsafe*` flag simple-git's `unsafe` options currently expose,
// flipped on as a single object literal (easy to spot and flip back off
// individually if one of these ever needs tightening again).
const UNSAFE_OPTIONS: Partial<SimpleGitOptions> = {
	unsafe: {
		allowUnsafeAlias: true,
		allowUnsafeAskPass: true,
		allowUnsafeConfigEnvCount: true,
		allowUnsafeConfigPaths: true,
		allowUnsafeCredentialHelper: true,
		allowUnsafeCustomBinary: true,
		allowUnsafeDiffExternal: true,
		allowUnsafeDiffTextConv: true,
		allowUnsafeEditor: true,
		allowUnsafeFilter: true,
		allowUnsafeFsMonitor: true,
		allowUnsafeGitProxy: true,
		allowUnsafeGpgProgram: true,
		allowUnsafeHooksPath: true,
		allowUnsafeMergeDriver: true,
		allowUnsafePack: true,
		allowUnsafePager: true,
		allowUnsafeProtocolOverride: true,
		allowUnsafeSshCommand: true,
		allowUnsafeTemplateDir: true,
	},
};

/** A simple-git instance for running git as the current user against their own repo/config/env. */
export function createUserSimpleGit(baseDir?: string): SimpleGit {
	return baseDir ? simpleGit(baseDir, UNSAFE_OPTIONS) : simpleGit(UNSAFE_OPTIONS);
}
