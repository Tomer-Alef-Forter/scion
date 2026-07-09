// Real dashboard: Project sidebar | Workspace list | Detail panel (terminal +
// actions) for the selected workspace. Live status via /ws/events (pushed,
// not polled); a slower fallback tick keeps diff summaries fresh since git
// state changes aren't pushed. New-workspace flow is a real modal.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal/NewWorkspaceModal";
import { ProjectSidebar } from "./components/ProjectSidebar/ProjectSidebar";
import { SettingsModal } from "./components/SettingsModal/SettingsModal";
import { WebTerminal } from "./components/WebTerminal";
import { WorkspaceContextMenu } from "./components/WorkspaceGrid/WorkspaceContextMenu";
import { WorkspaceGrid } from "./components/WorkspaceGrid/WorkspaceGrid";
import { api, type HostSettings, type Project, type WorkspaceWithStatus } from "./lib/api";
import { subscribeToStatusEvents } from "./lib/eventsSocket";
import { cn } from "./lib/utils";

// Code-split: @pierre/diffs (diff rendering) and the file browser/viewer
// (incl. shiki highlighting) are sizeable and only needed once a user opens
// those tabs — no reason to ship them in the initial bundle/paint.
const DiffPane = lazy(() =>
	import("./components/DiffPane/DiffPane").then((m) => ({ default: m.DiffPane })),
);
const FilesPane = lazy(() =>
	import("./components/FileBrowser/FilesPane").then((m) => ({ default: m.FilesPane })),
);

// Fallback poll for diff summaries (git state isn't pushed like status is).
// Status changes are handled surgically via /ws/events + a single-workspace
// refetch instead — see the event subscription below — so this interval only
// governs how quickly MANUAL out-of-worktree edits show up in the sidebar.
const DIFF_REFRESH_INTERVAL_MS = 8000;

type DetailTab = "terminal" | "diff" | "files";
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
	{ id: "terminal", label: "Terminal" },
	{ id: "diff", label: "Diff" },
	{ id: "files", label: "Files" },
];

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const [workspaces, setWorkspaces] = useState<WorkspaceWithStatus[]>([]);
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
	const [openTerminal, setOpenTerminal] = useState<{
		workspaceId: string;
		terminalId: string;
	} | null>(null);

	const [activeTab, setActiveTab] = useState<DetailTab>("terminal");
	const [showNewWorkspaceModal, setShowNewWorkspaceModal] = useState(false);
	const [busy, setBusy] = useState(false);
	const [modalError, setModalError] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	const [contextMenu, setContextMenu] = useState<{
		workspace: WorkspaceWithStatus;
		x: number;
		y: number;
	} | null>(null);
	const [settings, setSettings] = useState<HostSettings | null>(null);
	const [showSettingsModal, setShowSettingsModal] = useState(false);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [confirmAction, setConfirmAction] = useState<{
		type: "merge" | "delete";
		workspace: WorkspaceWithStatus;
	} | null>(null);
	const [orphanCount, setOrphanCount] = useState<number | null>(null);
	const [showOrphanConfirm, setShowOrphanConfirm] = useState(false);

	const selectedProjectIdRef = useRef(selectedProjectId);
	selectedProjectIdRef.current = selectedProjectId;

	useEffect(() => {
		api.listProjects().then(setProjects).catch((e) => setError(String(e)));
		api.getSettings().then(setSettings).catch((e) => setError(String(e)));
	}, []);

	async function handleSaveSettings(patch: Partial<HostSettings>) {
		setBusy(true);
		setSettingsError(null);
		try {
			const updated = await api.updateSettings(patch);
			setSettings(updated);
			setShowSettingsModal(false);
		} catch (e) {
			setSettingsError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function handleCleanupOrphans() {
		setBusy(true);
		setShowOrphanConfirm(false);
		try {
			const result = await api.cleanupOrphanedWorktrees();
			setSettingsError(
				result.failed > 0
					? `Removed ${result.removed}, ${result.failed} failed (check they aren't in use).`
					: null,
			);
			const orphans = await api.listOrphanedWorktrees();
			setOrphanCount(orphans.length);
		} catch (e) {
			setSettingsError(String(e));
		} finally {
			setBusy(false);
		}
	}

	const refreshWorkspaces = useCallback((projectId: string) => {
		return api
			.listWorkspaces(projectId)
			.then((ws) => {
				if (selectedProjectIdRef.current === projectId) setWorkspaces(ws);
			})
			.catch((e) => setError(String(e)));
	}, []);

	// Patches ONE workspace in place (same array, only that item's reference
	// changes) instead of replacing the whole list — so WorkspaceCard's memo
	// skips re-rendering every other card, and no diff summary is recomputed
	// for workspaces that didn't change.
	const applyWorkspaceUpdate = useCallback((updated: WorkspaceWithStatus) => {
		setWorkspaces((prev) => {
			if (!prev.some((w) => w.id === updated.id)) return prev;
			return prev.map((w) => (w.id === updated.id ? updated : w));
		});
	}, []);

	useEffect(() => {
		if (!selectedProjectId) {
			setWorkspaces([]);
			return;
		}
		refreshWorkspaces(selectedProjectId);

		// Live: an agent status change names exactly one workspace — refetch
		// just that one instead of recomputing every workspace's diff summary.
		const unsubscribe = subscribeToStatusEvents((workspaceId) => {
			api
				.getWorkspace(workspaceId)
				.then(applyWorkspaceUpdate)
				.catch(() => {
					// Benign race (e.g. workspace deleted concurrently) — the
					// periodic poll below will reconcile either way.
				});
		});
		// Fallback: diff summaries (git state) aren't pushed — poll slowly.
		const id = setInterval(() => refreshWorkspaces(selectedProjectId), DIFF_REFRESH_INTERVAL_MS);
		return () => {
			unsubscribe();
			clearInterval(id);
		};
	}, [selectedProjectId, refreshWorkspaces, applyWorkspaceUpdate]);

	async function handleAddProject(repoPath: string) {
		setBusy(true);
		setError(null);
		try {
			const project = await api.addProject(repoPath);
			setProjects((prev) =>
				prev.some((p) => p.id === project.id) ? prev : [...prev, project],
			);
			setSelectedProjectId(project.id);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	function handleRemoveProject(projectId: string) {
		api.removeProject(projectId).catch((e) => setError(String(e)));
		setProjects((prev) => prev.filter((p) => p.id !== projectId));
		if (selectedProjectId === projectId) {
			setSelectedProjectId(null);
			setSelectedWorkspaceId(null);
			setOpenTerminal(null);
		}
	}

	async function handleCreateWorkspace(prompt: string, name?: string) {
		if (!selectedProjectId) return;
		setBusy(true);
		setModalError(null);
		try {
			const result = await api.createWorkspace(selectedProjectId, prompt, name);
			setShowNewWorkspaceModal(false);
			// Show it immediately — the create response already has everything
			// needed. Don't block on a full workspace-list refetch (which
			// recomputes a git diff summary for every OTHER workspace too);
			// that runs in the background instead and just backfills status/diff.
			setWorkspaces((prev) => [
				...prev,
				{ ...result.workspace, status: "starting", terminalId: result.terminalId, diff: null },
			]);
			setSelectedWorkspaceId(result.workspace.id);
			setActiveTab("terminal");
			setOpenTerminal({ workspaceId: result.workspace.id, terminalId: result.terminalId });
			refreshWorkspaces(selectedProjectId);
		} catch (e) {
			setModalError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function handleSelectWorkspace(ws: WorkspaceWithStatus) {
		setSelectedWorkspaceId(ws.id);
		setActionMessage(null);
		setActiveTab("terminal");
		if (ws.terminalId) {
			api.markSeen(ws.id).catch(() => {});
			setOpenTerminal({ workspaceId: ws.id, terminalId: ws.terminalId });
			return;
		}
		// No live terminal — resume in the same worktree rather than dead-ending.
		setBusy(true);
		try {
			const { terminalId } = await api.resumeWorkspace(ws.id);
			api.markSeen(ws.id).catch(() => {});
			setOpenTerminal({ workspaceId: ws.id, terminalId });
			if (selectedProjectId) refreshWorkspaces(selectedProjectId);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function handleRename(ws: WorkspaceWithStatus, name: string) {
		setBusy(true);
		try {
			await api.renameWorkspace(ws.id, name);
			if (selectedProjectId) await refreshWorkspaces(selectedProjectId);
		} catch (e) {
			setActionMessage(`Rename failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy(false);
		}
	}

	async function handleMerge(ws: WorkspaceWithStatus) {
		setBusy(true);
		setActionMessage("Merging…");
		try {
			const result = await api.merge(ws.id);
			setActionMessage(result.message);
			if (selectedProjectId) refreshWorkspaces(selectedProjectId);
		} catch (e) {
			setActionMessage(`Merge failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy(false);
		}
	}

	async function handleOpen(ws: WorkspaceWithStatus) {
		setBusy(true);
		try {
			await api.openInEditor(ws.id);
			setActionMessage("Opened in editor.");
		} catch (e) {
			setActionMessage(`Open failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete(ws: WorkspaceWithStatus) {
		setBusy(true);
		try {
			// Confirming the dialog IS the "yes, even with uncommitted changes"
			// signal — the warning was already shown there.
			await api.deleteWorkspace(ws.id, false, true);
			if (selectedWorkspaceId === ws.id) {
				setSelectedWorkspaceId(null);
				setOpenTerminal(null);
			}
			if (selectedProjectId) await refreshWorkspaces(selectedProjectId);
		} catch (e) {
			setActionMessage(`Delete failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			setBusy(false);
		}
	}

	function requestMerge(ws: WorkspaceWithStatus) {
		setConfirmAction({ type: "merge", workspace: ws });
	}

	function requestDelete(ws: WorkspaceWithStatus) {
		setConfirmAction({ type: "delete", workspace: ws });
	}

	async function handleConfirmAction() {
		if (!confirmAction) return;
		const { type, workspace } = confirmAction;
		setConfirmAction(null);
		if (type === "merge") await handleMerge(workspace);
		else await handleDelete(workspace);
	}

	const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
	const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

	return (
		<div className="flex h-screen bg-background text-foreground">
			<ProjectSidebar
				projects={projects}
				selectedProjectId={selectedProjectId}
				onSelect={(id) => {
					setSelectedProjectId(id);
					setSelectedWorkspaceId(null);
					setOpenTerminal(null);
				}}
				onAdd={handleAddProject}
				onRemove={handleRemoveProject}
				onOpenSettings={() => {
					setSettingsError(null);
					setShowSettingsModal(true);
					setOrphanCount(null);
					api
						.listOrphanedWorktrees()
						.then((orphans) => setOrphanCount(orphans.length))
						.catch(() => setOrphanCount(0));
				}}
				busy={busy}
			/>

			{selectedProjectId ? (
				<>
					<WorkspaceGrid
						workspaces={workspaces}
						selectedWorkspaceId={selectedWorkspaceId}
						onSelect={handleSelectWorkspace}
						onNew={() => {
							setModalError(null);
							setShowNewWorkspaceModal(true);
						}}
						onContextMenu={(workspace, e) => {
							e.preventDefault();
							setContextMenu({ workspace, x: e.clientX, y: e.clientY });
						}}
					/>

					<div className="flex flex-1 flex-col overflow-hidden">
						{selectedWorkspace ? (
							<>
								<div className="flex items-center justify-between border-b border-border px-4 py-2">
									<div className="min-w-0">
										<div className="truncate text-sm font-medium">
											{selectedWorkspace.name}
										</div>
										<div className="truncate text-xs text-muted-foreground">
											{selectedWorkspace.branch}
										</div>
									</div>
									<div className="flex shrink-0 gap-1.5">
										<button
											type="button"
											disabled={busy}
											onClick={() => requestMerge(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
										>
											Merge
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => handleOpen(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
										>
											Open
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => requestDelete(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
										>
											Delete
										</button>
									</div>
								</div>
								{actionMessage && (
									<div className="border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
										{actionMessage}
									</div>
								)}
								<div className="flex border-b border-border px-4">
									{DETAIL_TABS.map((tab) => (
										<button
											key={tab.id}
											type="button"
											onClick={() => setActiveTab(tab.id)}
											className={cn(
												"border-b-2 px-3 py-2 text-sm transition-colors",
												activeTab === tab.id
													? "border-primary font-medium text-foreground"
													: "border-transparent text-muted-foreground hover:text-foreground",
											)}
										>
											{tab.label}
										</button>
									))}
								</div>
								<div className="flex-1 overflow-hidden">
									<ErrorBoundary resetKey={`${selectedWorkspace.id}:${activeTab}`}>
										{activeTab === "terminal" &&
											(openTerminal && openTerminal.workspaceId === selectedWorkspace.id ? (
												<WebTerminal
													workspaceId={openTerminal.workspaceId}
													terminalId={openTerminal.terminalId}
												/>
											) : (
												<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
													{busy ? "Resuming…" : "No active terminal."}
												</div>
											))}
										{activeTab === "diff" && (
											<Suspense
												fallback={
													<div className="p-4 text-sm text-muted-foreground">Loading…</div>
												}
											>
												<DiffPane workspaceId={selectedWorkspace.id} />
											</Suspense>
										)}
										{activeTab === "files" && (
											<Suspense
												fallback={
													<div className="p-4 text-sm text-muted-foreground">Loading…</div>
												}
											>
												<FilesPane workspaceId={selectedWorkspace.id} />
											</Suspense>
										)}
									</ErrorBoundary>
								</div>
							</>
						) : (
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
								Select a workspace, or create a new one.
							</div>
						)}
					</div>
				</>
			) : (
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					{projects.length === 0
						? 'Add a project on the left to get started.'
						: "Select a project."}
				</div>
			)}

			{error && (
				<div className="fixed bottom-3 right-3 max-w-sm rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg">
					{error}
					<button
						type="button"
						onClick={() => setError(null)}
						className="ml-2 underline"
					>
						dismiss
					</button>
				</div>
			)}

			{showNewWorkspaceModal && selectedProject && (
				<NewWorkspaceModal
					projectName={selectedProject.name}
					busy={busy}
					error={modalError}
					onCreate={handleCreateWorkspace}
					onClose={() => setShowNewWorkspaceModal(false)}
				/>
			)}

			{contextMenu && (
				<WorkspaceContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					workspaceName={contextMenu.workspace.name}
					busy={busy}
					onClose={() => setContextMenu(null)}
					onRename={(name) => handleRename(contextMenu.workspace, name)}
					onMerge={() => requestMerge(contextMenu.workspace)}
					onOpen={() => handleOpen(contextMenu.workspace)}
					onDelete={() => requestDelete(contextMenu.workspace)}
				/>
			)}

			{showSettingsModal && settings && (
				<SettingsModal
					settings={settings}
					busy={busy}
					error={settingsError}
					orphanCount={orphanCount}
					onSave={handleSaveSettings}
					onCleanupOrphans={() => setShowOrphanConfirm(true)}
					onClose={() => setShowSettingsModal(false)}
				/>
			)}

			{showOrphanConfirm && (
				<ConfirmDialog
					title="Clean up orphaned worktrees?"
					message={`Remove ${orphanCount} orphaned worktree${orphanCount === 1 ? "" : "s"} from disk? Each still-registered project's worktree is deregistered with git (branch kept); any with no project left is deleted outright.`}
					confirmLabel="Clean up"
					destructive
					busy={busy}
					onConfirm={handleCleanupOrphans}
					onCancel={() => setShowOrphanConfirm(false)}
				/>
			)}

			{confirmAction?.type === "merge" && (
				<ConfirmDialog
					title="Merge workspace?"
					message={`Merge "${confirmAction.workspace.branch}" into ${
						confirmAction.workspace.baseBranch ?? "its base branch"
					}?`}
					confirmLabel="Merge"
					busy={busy}
					onConfirm={handleConfirmAction}
					onCancel={() => setConfirmAction(null)}
				/>
			)}

			{confirmAction?.type === "delete" && (
				<ConfirmDialog
					title="Delete workspace?"
					message={`Remove the worktree for "${confirmAction.workspace.name}". The branch is kept.`}
					warning={
						confirmAction.workspace.diff && confirmAction.workspace.diff.uncommitted > 0
							? `This worktree has ${confirmAction.workspace.diff.uncommitted} uncommitted change(s) that will be permanently lost.`
							: undefined
					}
					confirmLabel="Delete"
					destructive
					busy={busy}
					onConfirm={handleConfirmAction}
					onCancel={() => setConfirmAction(null)}
				/>
			)}
		</div>
	);
}
