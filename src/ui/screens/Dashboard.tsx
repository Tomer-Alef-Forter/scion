import { Box, Text, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { DiffSummary } from "../../engine/diff.ts";
import { getCachedDiffSummary, invalidateDiffCache } from "../../engine/diff.ts";
import { mergeBack } from "../../engine/mergeBack.ts";
import type { PtyBackend, SessionInfo } from "../../engine/ptyBackend.ts";
import type { AgentStatus, StatusStore } from "../../engine/status.ts";
import { openInEditor } from "../../lib/openInEditor.ts";
import type { Store } from "../../store/projects.ts";
import type { ExitAction } from "../types.ts";

interface Props {
	store: Store;
	status: StatusStore;
	backend: PtyBackend;
	projectId: string;
	onBack: () => void;
	onCreate: () => void;
	requestExit: (action: ExitAction) => void;
}

const STATUS_COLOR: Record<AgentStatus | "starting" | "done", string> = {
	working: "yellow",
	waiting: "magenta",
	review: "green",
	idle: "white",
	gone: "gray",
	starting: "cyan",
	done: "gray",
};

export function Dashboard({
	store,
	status,
	backend,
	projectId,
	onBack,
	onCreate,
	requestExit,
}: Props) {
	const [tick, refresh] = useReducer((x: number) => x + 1, 0);
	const [index, setIndex] = useState(0);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [summaries, setSummaries] = useState<Record<string, DiffSummary>>({});
	const [liveSessions, setLiveSessions] = useState<Record<string, SessionInfo[]>>({});

	const project = store.getProject(projectId);
	const workspaces = store.listWorkspaces(projectId);

	// Live refresh: agent status changes + a slow tick for git summaries.
	useEffect(() => {
		const onChange = () => refresh();
		status.events.on("change", onChange);
		const id = setInterval(refresh, 1500);
		return () => {
			status.events.off("change", onChange);
			clearInterval(id);
		};
	}, [status]);

	// Recompute diff summaries off the render path.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!project) return;
			const next: Record<string, DiffSummary> = {};
			for (const ws of workspaces) {
				next[ws.id] = await getCachedDiffSummary(project.repoPath, ws.worktreePath);
			}
			if (!cancelled) setSummaries(next);
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaces.length, project?.repoPath]);

	// Live session lookups now go through the daemon (a real round trip), so
	// they're fetched off the render path on the same cadence as everything
	// else above, and read back synchronously from this cache — same pattern
	// as `summaries`.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const next: Record<string, SessionInfo[]> = {};
			for (const ws of workspaces) {
				next[ws.id] = await backend.listSessions(ws.id);
			}
			if (!cancelled) setLiveSessions(next);
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tick, workspaces.length, backend]);

	function statusFor(workspaceId: string): {
		label: AgentStatus | "starting" | "done";
	} {
		// A binding row can outlive its process (killAll() kills the PTY but the
		// app exits before node-pty's async onExit — which calls
		// status.markExited — has a chance to fire), so a dead workspace must
		// always report "done", never a stale status from that leftover row.
		const live = (liveSessions[workspaceId] ?? []).some((s) => !s.exited);
		if (!live) return { label: "done" };
		const bindings = status.listByWorkspace(workspaceId);
		return { label: bindings[0]?.status ?? "starting" };
	}

	function liveTerminal(workspaceId: string): string | undefined {
		return (liveSessions[workspaceId] ?? []).find((s) => !s.exited)?.id;
	}

	const selected = workspaces[index];

	useInput((input, key) => {
		if (busy) return;
		if (input === "q") return requestExit({ type: "quit" });
		if (input === "b" || key.escape) return onBack();
		if (input === "n") return onCreate();
		if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
		if (key.downArrow) setIndex((i) => Math.min(workspaces.length - 1, i + 1));
		if (!selected || !project) return;

		if (key.return) {
			store.updateSettings({ lastOpenedWorkspaceId: selected.id });
			const terminalId = liveTerminal(selected.id);
			if (terminalId) {
				status.markSeen(selected.id);
				requestExit({ type: "attach", terminalId, projectId });
			} else {
				// No live terminal (the app was restarted, or the agent exited) —
				// launch a fresh one in the SAME worktree rather than dead-ending.
				// Resumes the prior Claude conversation if a session_id was
				// captured from the hook.
				setBusy(true);
				setMessage("Resuming…");
				store
					.resumeWorkspace({ workspaceId: selected.id })
					.then(({ terminalId: newTerminalId }) => {
						status.markSeen(selected.id);
						requestExit({ type: "attach", terminalId: newTerminalId, projectId });
					})
					.catch((e) => setMessage(`Resume failed: ${e instanceof Error ? e.message : e}`))
					.finally(() => setBusy(false));
			}
			return;
		}
		if (input === "d") {
			requestExit({
				type: "diff",
				repoPath: project.repoPath,
				worktreePath: selected.worktreePath,
				projectId,
			});
			return;
		}
		if (input === "o") {
			setBusy(true);
			setMessage("Opening in editor…");
			openInEditor(selected.worktreePath)
				.then(() => setMessage("Opened in editor."))
				.catch((e) => setMessage(`Open failed: ${e instanceof Error ? e.message : e}`))
				.finally(() => setBusy(false));
			return;
		}
		if (input === "m") {
			setBusy(true);
			setMessage("Merging…");
			mergeBack({
				repoPath: project.repoPath,
				branch: selected.branch,
				worktreePath: selected.worktreePath,
			})
				.then((r) => {
					invalidateDiffCache(selected.worktreePath);
					setMessage(r.message);
				})
				.catch((e) => setMessage(`Merge failed: ${e instanceof Error ? e.message : e}`))
				.finally(() => {
					setBusy(false);
					refresh();
				});
			return;
		}
		if (input === "x") {
			setBusy(true);
			setMessage("Removing worktree…");
			store
				.deleteWorkspace({ workspaceId: selected.id, deleteBranch: false })
				.then(() => {
					setMessage("Worktree removed.");
					setIndex(0);
				})
				.catch((e) => setMessage(`Delete failed: ${e instanceof Error ? e.message : e}`))
				.finally(() => {
					setBusy(false);
					refresh();
				});
			return;
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="cyan">
				{project ? project.name : "?"} · workspaces
			</Text>
			<Box marginTop={1} flexDirection="column">
				{workspaces.length === 0 && <Text dimColor>No workspaces. Press "n" to create one.</Text>}
				{workspaces.map((ws, i) => {
					const s = statusFor(ws.id);
					const sum = summaries[ws.id];
					return (
						<Text key={ws.id} color={i === index ? "green" : undefined}>
							{i === index ? "❯ " : "  "}
							<Text color={STATUS_COLOR[s.label]}>{`[${s.label}]`.padEnd(11)}</Text> {ws.name}{" "}
							<Text dimColor>
								({ws.branch}
								{sum
									? ` · ${sum.filesChanged}f +${sum.insertions}/-${sum.deletions}${sum.uncommitted ? ` · ${sum.uncommitted} uncommitted` : ""}`
									: ""}
								)
							</Text>
						</Text>
					);
				})}
			</Box>

			{message && (
				<Box marginTop={1}>
					<Text color="yellow">{message}</Text>
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					↑/↓ · enter attach · n new · d diff · m merge · o open · x remove · b back · q quit
				</Text>
			</Box>
		</Box>
	);
}
