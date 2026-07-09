// Copied from superset host-service runtime/git/simple-git.ts + shared
// simple-git-options.ts. Superset is a local git client, so inherited user
// git config/env is expected; simple-git 3.36 blocks these by default, so we
// allow them centrally.
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";

const SIMPLE_GIT_UNSAFE_OPTION_FLAGS = [
	"allowUnsafeAlias",
	"allowUnsafeAskPass",
	"allowUnsafeConfigEnvCount",
	"allowUnsafeConfigPaths",
	"allowUnsafeCredentialHelper",
	"allowUnsafeCustomBinary",
	"allowUnsafeDiffExternal",
	"allowUnsafeDiffTextConv",
	"allowUnsafeEditor",
	"allowUnsafeFilter",
	"allowUnsafeFsMonitor",
	"allowUnsafeGitProxy",
	"allowUnsafeGpgProgram",
	"allowUnsafeHooksPath",
	"allowUnsafeMergeDriver",
	"allowUnsafePack",
	"allowUnsafePager",
	"allowUnsafeProtocolOverride",
	"allowUnsafeSshCommand",
	"allowUnsafeTemplateDir",
] as const;

const SIMPLE_GIT_OPTIONS = {
	unsafe: Object.fromEntries(
		SIMPLE_GIT_UNSAFE_OPTION_FLAGS.map((flag) => [flag, true]),
	),
} as Partial<SimpleGitOptions>;

export function createUserSimpleGit(baseDir?: string): SimpleGit {
	return baseDir
		? simpleGit(baseDir, SIMPLE_GIT_OPTIONS)
		: simpleGit(SIMPLE_GIT_OPTIONS);
}
