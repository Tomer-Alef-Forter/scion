// Real dashboard: Project sidebar | Workspace list | Detail panel (terminal +
// actions) for the selected workspace. Live status via /ws/events (pushed,
// not polled); a slower fallback tick keeps diff summaries fresh since git
// state changes aren't pushed. New-workspace flow is a real modal.
import { useCallback, useEffect, useRef, useState } from "react";
import { DiffPane } from "./components/DiffPane/DiffPane";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { FilesPane } from "./components/FileBrowser/FilesPane";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal/NewWorkspaceModal";
import { ProjectSidebar } from "./components/ProjectSidebar/ProjectSidebar";
import { WebTerminal } from "./components/WebTerminal";
import { WorkspaceGrid } from "./components/WorkspaceGrid/WorkspaceGrid";
import { api, type Project, type WorkspaceWithStatus } from "./lib/api";
import { subscribeToStatusEvents } from "./lib/eventsSocket";
import { cn } from "./lib/utils";

const DIFF_REFRESH_INTERVAL_MS = 5000;

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

	const selectedProjectIdRef = useRef(selectedProjectId);
	selectedProjectIdRef.current = selectedProjectId;

	useEffect(() => {
		api.listProjects().then(setProjects).catch((e) => setError(String(e)));
	}, []);

	const refreshWorkspaces = useCallback((projectId: string) => {
		return api
			.listWorkspaces(projectId)
			.then((ws) => {
				if (selectedProjectIdRef.current === projectId) setWorkspaces(ws);
			})
			.catch((e) => setError(String(e)));
	}, []);

	useEffect(() => {
		if (!selectedProjectId) {
			setWorkspaces([]);
			return;
		}
		refreshWorkspaces(selectedProjectId);

		// Live: refetch the instant an agent's status changes.
		const unsubscribe = subscribeToStatusEvents(() => {
			refreshWorkspaces(selectedProjectId);
		});
		// Fallback: diff summaries (git state) aren't pushed — poll slowly.
		const id = setInterval(() => refreshWorkspaces(selectedProjectId), DIFF_REFRESH_INTERVAL_MS);
		return () => {
			unsubscribe();
			clearInterval(id);
		};
	}, [selectedProjectId, refreshWorkspaces]);

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

	async function handleCreateWorkspace(prompt: string) {
		if (!selectedProjectId) return;
		setBusy(true);
		setModalError(null);
		try {
			const result = await api.createWorkspace(selectedProjectId, prompt);
			setShowNewWorkspaceModal(false);
			await refreshWorkspaces(selectedProjectId);
			setSelectedWorkspaceId(result.workspace.id);
			setActiveTab("terminal");
			setOpenTerminal({ workspaceId: result.workspace.id, terminalId: result.terminalId });
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
			await api.deleteWorkspace(ws.id, false);
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
											onClick={() => handleMerge(selectedWorkspace)}
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
											onClick={() => handleDelete(selectedWorkspace)}
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
										{activeTab === "diff" && <DiffPane workspaceId={selectedWorkspace.id} />}
										{activeTab === "files" && <FilesPane workspaceId={selectedWorkspace.id} />}
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
		</div>
	);
}
