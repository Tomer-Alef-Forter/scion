// Real dashboard: Project sidebar | Workspace list | Detail panel (terminal +
// actions) for the selected workspace. Live status via /ws/events (pushed,
// not polled); a slower fallback tick keeps diff summaries fresh since git
// state changes aren't pushed. New-workspace flow is a real modal.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type Command, CommandPalette } from "./components/CommandPalette/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal/NewWorkspaceModal";
import { PrStatusBadge } from "./components/PrStatus/PrStatusBadge";
import { ProjectSidebar } from "./components/ProjectSidebar/ProjectSidebar";
import { SettingsModal } from "./components/SettingsModal/SettingsModal";
import { type WebTerminalHandle, WebTerminal } from "./components/WebTerminal";
import { WorkspaceContextMenu } from "./components/WorkspaceGrid/WorkspaceContextMenu";
import { WorkspaceGrid } from "./components/WorkspaceGrid/WorkspaceGrid";
import { api, type AgentStatus, type HostSettings, type Project, type WorkspaceWithStatus } from "./lib/api";
import { subscribeToStatusEvents } from "./lib/eventsSocket";
import { isTypingTarget } from "./lib/keyboardShortcuts";
import { notifyAgentAttention } from "./lib/notifications";
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

// Fixed anchor for the keyboard-triggered ("r") rename box — there's no
// click coordinate to anchor it to like the real context menu has, so it's
// pinned just past the sidebar (256px) + workspace grid (320px) width.
const KEYBOARD_RENAME_ANCHOR = { x: 592, y: 96 };

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
		initialMode?: "menu" | "rename";
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
	const [liveSessionCount, setLiveSessionCount] = useState<number | null>(null);
	const [showStopAllAgentsConfirm, setShowStopAllAgentsConfirm] = useState(false);
	const [showCommandPalette, setShowCommandPalette] = useState(false);

	const selectedProjectIdRef = useRef(selectedProjectId);
	selectedProjectIdRef.current = selectedProjectId;
	const webTerminalRef = useRef<WebTerminalHandle>(null);
	// True only for an explicit "activate this workspace" action (click,
	// Enter, command palette) — never for arrow-key preview-browsing, which
	// must never steal focus into the terminal mid-browse. Read once by
	// WebTerminal at mount, so it only matters at the instant openTerminal
	// changes and a new instance mounts.
	const autoFocusTerminalRef = useRef(false);

	useEffect(() => {
		api.listProjects().then(setProjects).catch((e) => setError(String(e)));
		api.getSettings().then((s) => {
			setSettings(s);
			// Reopen whatever was open last time — if it's gone (deleted since),
			// getWorkspace 404s and we just leave nothing selected.
			if (s.lastOpenedWorkspaceId) {
				api
					.getWorkspace(s.lastOpenedWorkspaceId)
					.then((ws) => {
						setSelectedProjectId(ws.projectId);
						handleSelectWorkspace(ws);
					})
					.catch(() => {});
			}
		}).catch((e) => setError(String(e)));
	}, []);

	// Auto-dismiss the error toast — re-arms on every new error (including one
	// replacing an already-showing one), and never fires after a manual
	// dismiss (error becomes null, so the effect's condition skips it).
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(null), 6000);
		return () => clearTimeout(timer);
	}, [error]);

	// The full keyboard-shortcut listener lives further down (after
	// selectedProject/selectedWorkspace/commands are computed) — see the
	// comment there for why.

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

	async function handleStopAllAgents() {
		setBusy(true);
		setShowStopAllAgentsConfirm(false);
		try {
			await api.shutdownDaemon();
			setLiveSessionCount(0);
			if (selectedProjectId) refreshWorkspaces(selectedProjectId);
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
		// Fallback: diff summaries (git state) aren't pushed — poll slowly.
		const id = setInterval(() => refreshWorkspaces(selectedProjectId), DIFF_REFRESH_INTERVAL_MS);
		return () => clearInterval(id);
	}, [selectedProjectId, refreshWorkspaces]);

	// Tracks status BY WORKSPACE ID ACROSS ALL PROJECTS (unlike `workspaces`
	// state above, which only ever holds the selected project's rows) — the
	// whole point of a notification is noticing something in a project you
	// aren't currently looking at. One single /ws/events subscription for the
	// app's lifetime (not scoped to selectedProjectId like the effect above),
	// doing double duty: attention-tracking/notifying here, and patching the
	// visible list via applyWorkspaceUpdate (which already safely no-ops for
	// a workspace outside the current project).
	const lastKnownStatusRef = useRef<Map<string, AgentStatus>>(new Map());
	const attentionWorkspaceIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		function updateTabTitle() {
			const n = attentionWorkspaceIdsRef.current.size;
			document.title = n > 0 ? `(${n}) Scion` : "Scion";
		}
		const unsubscribe = subscribeToStatusEvents((workspaceId) => {
			api
				.getWorkspace(workspaceId)
				.then((updated) => {
					const prevStatus = lastKnownStatusRef.current.get(updated.id);
					if (updated.status === "waiting" || updated.status === "review") {
						if (prevStatus !== updated.status) {
							notifyAgentAttention(
								{ id: updated.id, name: updated.name, status: updated.status },
								() => selectProject(updated.projectId),
							);
						}
						attentionWorkspaceIdsRef.current.add(updated.id);
					} else {
						attentionWorkspaceIdsRef.current.delete(updated.id);
					}
					lastKnownStatusRef.current.set(updated.id, updated.status);
					updateTabTitle();
					applyWorkspaceUpdate(updated);
				})
				.catch(() => {
					// Benign race (e.g. workspace deleted concurrently) — the
					// per-project poll reconciles the visible list either way.
				});
		});
		return () => {
			unsubscribe();
			document.title = "Scion";
		};
	}, [applyWorkspaceUpdate]);

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

	// Named (not inline) so both the sidebar's project list and the command
	// palette's "Switch to project" entries call the exact same logic.
	function selectProject(id: string) {
		setSelectedProjectId(id);
		setSelectedWorkspaceId(null);
		setOpenTerminal(null);
	}

	// Named (not inline) so both the sidebar's settings button and the
	// command palette's "Open settings" entry call the exact same logic.
	function openSettings() {
		setSettingsError(null);
		setShowSettingsModal(true);
		setOrphanCount(null);
		api
			.listOrphanedWorktrees()
			.then((orphans) => setOrphanCount(orphans.length))
			.catch(() => setOrphanCount(0));
		setLiveSessionCount(null);
		api
			.getDaemonStatus()
			.then((s) => setLiveSessionCount(s.liveSessionCount))
			.catch(() => setLiveSessionCount(0));
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
				{
					...result.workspace,
					status: "starting",
					terminalId: result.terminalId,
					diff: null,
					usage: null,
				},
			]);
			setSelectedWorkspaceId(result.workspace.id);
			setActiveTab("terminal");
			setOpenTerminal({ workspaceId: result.workspace.id, terminalId: result.terminalId });
			if (result.setupWarning) setActionMessage(result.setupWarning);
			refreshWorkspaces(selectedProjectId);
			api.updateSettings({ lastOpenedWorkspaceId: result.workspace.id }).catch(() => {});
		} catch (e) {
			setModalError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function handleUpdateSetupCommand(projectId: string, setupCommand: string) {
		try {
			const updated = await api.updateProjectSetupCommand(projectId, setupCommand);
			setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
		} catch (e) {
			setError(String(e));
		}
	}

	// Side-effect-free: sets the selection and attaches ONLY if a live
	// terminal already exists. Safe to call repeatedly while arrow-key
	// browsing — unlike handleSelectWorkspace below, this never spawns an
	// agent, so scrolling past a dozen finished workspaces never resumes any
	// of them.
	function previewWorkspace(ws: WorkspaceWithStatus) {
		setSelectedWorkspaceId(ws.id);
		setActionMessage(null);
		setActiveTab("terminal");
		if (ws.terminalId) {
			api.markSeen(ws.id).catch(() => {});
			setOpenTerminal({ workspaceId: ws.id, terminalId: ws.terminalId });
		} else {
			setOpenTerminal(null);
		}
	}

	// The explicit "activate" gesture (mouse click, Enter, command palette) —
	// resumes a finished workspace's agent if needed. autoFocusTerminalRef is
	// set true here so the terminal focuses itself once it (re)mounts, since
	// unlike preview-browsing this is a deliberate "open this" action.
	async function handleSelectWorkspace(ws: WorkspaceWithStatus) {
		autoFocusTerminalRef.current = true;
		previewWorkspace(ws);
		api.updateSettings({ lastOpenedWorkspaceId: ws.id }).catch(() => {});
		if (ws.terminalId) return;
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

	async function handleCreatePr(ws: WorkspaceWithStatus) {
		setBusy(true);
		setActionMessage("Pushing branch and creating PR…");
		try {
			const { url } = await api.createPullRequest(ws.id);
			setActionMessage(`PR ready: ${url}`);
			window.open(url, "_blank");
		} catch (e) {
			setActionMessage(`Create PR failed: ${e instanceof Error ? e.message : e}`);
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
			// Drop it immediately — don't block on a full workspace-list refetch
			// (which recomputes a git diff summary for every OTHER workspace
			// too); that runs in the background instead, same as create.
			setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
			if (selectedWorkspaceId === ws.id) {
				setSelectedWorkspaceId(null);
				setOpenTerminal(null);
			}
			if (selectedProjectId) refreshWorkspaces(selectedProjectId);
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

	// Every entry reuses an EXISTING handler — destructive ones (merge/delete)
	// still route through requestMerge/requestDelete's confirm dialogs, never
	// executing directly. Nothing here bypasses that safety.
	const commands: Command[] = [
		...(selectedProject
			? [
					{
						id: "new-workspace",
						label: "New workspace",
						hint: selectedProject.name,
						run: () => {
							setModalError(null);
							setShowNewWorkspaceModal(true);
						},
					},
				]
			: []),
		...(selectedWorkspace
			? [
					{
						id: "merge-workspace",
						label: `Merge "${selectedWorkspace.name}"`,
						run: () => requestMerge(selectedWorkspace),
					},
					{
						id: "delete-workspace",
						label: `Delete "${selectedWorkspace.name}"`,
						run: () => requestDelete(selectedWorkspace),
					},
					{
						id: "open-editor",
						label: `Open "${selectedWorkspace.name}" in editor`,
						run: () => handleOpen(selectedWorkspace),
					},
					{
						id: "create-pr",
						label: `Create PR for "${selectedWorkspace.name}"`,
						run: () => handleCreatePr(selectedWorkspace),
					},
				]
			: []),
		...workspaces
			.filter((ws) => ws.id !== selectedWorkspaceId)
			.map((ws) => ({
				id: `goto-workspace-${ws.id}`,
				label: `Go to "${ws.name}"`,
				hint: ws.branch,
				run: () => handleSelectWorkspace(ws),
			})),
		...projects
			.filter((p) => p.id !== selectedProjectId)
			.map((p) => ({
				id: `switch-project-${p.id}`,
				label: `Switch to project "${p.name}"`,
				run: () => selectProject(p.id),
			})),
		{ id: "open-settings", label: "Open settings", run: openSettings },
	];

	// Full keyboard operability: navigate/act on workspaces and projects
	// without a mouse. Deliberately has NO dependency array (runs after every
	// render) rather than tracking every referenced value — this effect
	// reads a lot of state/handlers, and re-attaching a single document
	// keydown listener every render is cheap; the alternative (an exact
	// dependency list) is easy to get subtly wrong and let a stale closure
	// slip through. Guarded first by isTypingTarget (never fires while
	// typing in an input OR while the terminal has focus) and then by
	// "is any modal/dialog open" (those don't always have a focused input,
	// e.g. Settings' <select>s, so isTypingTarget alone isn't enough).
	const anyOverlayOpen =
		showNewWorkspaceModal ||
		showSettingsModal ||
		!!contextMenu ||
		!!confirmAction ||
		showOrphanConfirm ||
		showStopAllAgentsConfirm;

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (isTypingTarget(e)) return;

			// Cmd/Ctrl+K toggles the palette regardless of other overlays, so
			// it can also close itself.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setShowCommandPalette((v) => !v);
				return;
			}
			if (anyOverlayOpen || showCommandPalette) return;

			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				if (!selectedProjectId || workspaces.length === 0) return;
				e.preventDefault();
				const currentIndex = workspaces.findIndex((w) => w.id === selectedWorkspaceId);
				let nextIndex: number;
				if (currentIndex === -1) {
					nextIndex = e.key === "ArrowDown" ? 0 : workspaces.length - 1;
				} else {
					const delta = e.key === "ArrowDown" ? 1 : -1;
					nextIndex = Math.min(Math.max(currentIndex + delta, 0), workspaces.length - 1);
				}
				const next = workspaces[nextIndex];
				if (next) {
					autoFocusTerminalRef.current = false; // browsing — never steal focus
					previewWorkspace(next);
				}
				return;
			}

			if (e.key === "Enter") {
				if (!selectedWorkspace) return;
				e.preventDefault();
				if (openTerminal && openTerminal.workspaceId === selectedWorkspace.id) {
					webTerminalRef.current?.focus();
					return;
				}
				handleSelectWorkspace(selectedWorkspace).then(() => {
					// Give React a chance to commit the new WebTerminal instance
					// (triggered by the resume above) before focusing it — a
					// pragmatic one-off fix, not worth an effect-based
					// ready-signal for.
					requestAnimationFrame(() => webTerminalRef.current?.focus());
				});
				return;
			}

			if (e.key.toLowerCase() === "n" && selectedProject) {
				e.preventDefault();
				setModalError(null);
				setShowNewWorkspaceModal(true);
				return;
			}

			if (e.key === "[" || e.key === "]") {
				if (!selectedProjectId || projects.length < 2) return;
				e.preventDefault();
				const idx = projects.findIndex((p) => p.id === selectedProjectId);
				const delta = e.key === "]" ? 1 : -1;
				const next = projects[(idx + delta + projects.length) % projects.length];
				if (next) selectProject(next.id);
				return;
			}

			if (!selectedWorkspace) return;

			if (e.key.toLowerCase() === "m") {
				e.preventDefault();
				requestMerge(selectedWorkspace);
				return;
			}
			if (e.key.toLowerCase() === "x") {
				e.preventDefault();
				requestDelete(selectedWorkspace);
				return;
			}
			if (e.key.toLowerCase() === "o") {
				e.preventDefault();
				handleOpen(selectedWorkspace);
				return;
			}
			if (e.key.toLowerCase() === "p") {
				e.preventDefault();
				handleCreatePr(selectedWorkspace);
				return;
			}
			if (e.key.toLowerCase() === "r") {
				e.preventDefault();
				setContextMenu({
					workspace: selectedWorkspace,
					x: KEYBOARD_RENAME_ANCHOR.x,
					y: KEYBOARD_RENAME_ANCHOR.y,
					initialMode: "rename",
				});
				return;
			}
			if (e.key === "1" || e.key === "2" || e.key === "3") {
				const tab = DETAIL_TABS[Number(e.key) - 1];
				if (tab) {
					e.preventDefault();
					setActiveTab(tab.id);
				}
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	return (
		<div className="flex h-screen bg-background text-foreground">
			<ProjectSidebar
				projects={projects}
				selectedProjectId={selectedProjectId}
				onSelect={selectProject}
				onAdd={handleAddProject}
				onRemove={handleRemoveProject}
				onUpdateSetupCommand={handleUpdateSetupCommand}
				onOpenSettings={openSettings}
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
								<div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
									<div className="min-w-0">
										<div className="truncate text-sm font-medium">
											{selectedWorkspace.name}
										</div>
										<div className="truncate text-xs text-muted-foreground">
											{selectedWorkspace.branch}
										</div>
										<div className="mt-1">
											<PrStatusBadge key={selectedWorkspace.id} workspaceId={selectedWorkspace.id} />
										</div>
									</div>
									<div className="flex shrink-0 gap-1.5">
										<button
											type="button"
											disabled={busy}
											title="Merge (m)"
											onClick={() => requestMerge(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
										>
											Merge
										</button>
										<button
											type="button"
											disabled={busy}
											title="Open in editor (o)"
											onClick={() => handleOpen(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
										>
											Open
										</button>
										<button
											type="button"
											disabled={busy}
											title="Push branch + create PR (p)"
											onClick={() => handleCreatePr(selectedWorkspace)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
										>
											Create PR
										</button>
										<button
											type="button"
											disabled={busy}
											title="Delete (x)"
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
													ref={webTerminalRef}
													workspaceId={openTerminal.workspaceId}
													terminalId={openTerminal.terminalId}
													autoFocus={autoFocusTerminalRef.current}
													onDetach={() =>
														setActionMessage(
															"Detached from terminal — arrow keys navigate the workspace list again.",
														)
													}
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
							<div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
								<span>Select a workspace, or create a new one.</span>
								<span className="text-xs">
									<kbd className="rounded border border-border px-1">↑↓</kbd> navigate ·{" "}
									<kbd className="rounded border border-border px-1">n</kbd> new ·{" "}
									<kbd className="rounded border border-border px-1">⌘K</kbd>/
									<kbd className="rounded border border-border px-1">Ctrl+K</kbd> commands
								</span>
							</div>
						)}
					</div>
				</>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
					<span>
						{projects.length === 0
							? 'Add a project on the left to get started.'
							: "Select a project."}
					</span>
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
					initialMode={contextMenu.initialMode}
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
					liveSessionCount={liveSessionCount}
					onSave={handleSaveSettings}
					onCleanupOrphans={() => setShowOrphanConfirm(true)}
					onStopAllAgents={() => setShowStopAllAgentsConfirm(true)}
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

			{showStopAllAgentsConfirm && (
				<ConfirmDialog
					title="Stop all agents?"
					message={`Stop the agent daemon, ending ${liveSessionCount} running agent${liveSessionCount === 1 ? "" : "s"} across every project. Worktrees and branches are untouched — each workspace can be resumed afterward.`}
					confirmLabel="Stop all agents"
					destructive
					busy={busy}
					onConfirm={handleStopAllAgents}
					onCancel={() => setShowStopAllAgentsConfirm(false)}
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

			{showCommandPalette && (
				<CommandPalette commands={commands} onClose={() => setShowCommandPalette(false)} />
			)}
		</div>
	);
}
