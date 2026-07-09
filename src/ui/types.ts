// An action that requires leaving Ink (raw terminal takeover) or exiting.
// attach/diff carry the projectId so the loop can re-open the same dashboard
// after the terminal-takeover returns.
export type ExitAction =
	| { type: "attach"; terminalId: string; projectId: string }
	| { type: "diff"; repoPath: string; worktreePath: string; projectId: string }
	| { type: "quit" };
