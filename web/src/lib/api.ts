// Typed fetch wrappers over the backend REST API (src/server/api.ts). Types
// are local, minimal mirrors of the server's shapes — kept web/ fully
// decoupled from the root package (separate tsconfig/module system).
import { authHeaders } from "./auth";
export interface Project {
	id: string;
	name: string;
	repoPath: string;
	defaultBranch: string | null;
	worktreeBaseDir: string | null;
	setupCommand: string | null;
	createdAt: number;
}

export interface DiffSummary {
	filesChanged: number;
	insertions: number;
	deletions: number;
	uncommitted: number;
}

// Cumulative token usage for a workspace's current Claude Code session, read
// straight from Claude Code's own transcript file (see
// src/engine/usage.ts) — real counts, not an estimate. Deliberately no cost
// field: Claude Code's hook payloads and transcripts carry no price/cost
// data at all, so there's nothing real to show (see docs/WEB_GUIDE.md §12).
export interface SessionUsage {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	turnCount: number;
	usageUpdatedAt: number | null;
	model: string | null;
}

export type AgentStatus = "working" | "waiting" | "review" | "idle" | "starting" | "done";
export type AgentType =
	| "claude"
	| "gemini"
	| "codex"
	| "cursor-agent"
	| "droid"
	| "opencode"
	| "copilot";
export type EditorType = "vscode" | "cursor" | "zed";

export interface HostSettings {
	defaultAgent: AgentType;
	defaultEditor: EditorType;
	lastOpenedWorkspaceId: string | null;
}

export interface WorkspaceWithStatus {
	id: string;
	projectId: string;
	worktreePath: string;
	branch: string;
	baseBranch: string | null;
	name: string;
	agentType: AgentType;
	createdAt: number;
	status: AgentStatus;
	terminalId: string | null;
	diff: DiffSummary | null;
	usage: SessionUsage | null;
}

export interface CreateWorkspaceResult {
	workspace: {
		id: string;
		projectId: string;
		worktreePath: string;
		branch: string;
		baseBranch: string | null;
		name: string;
		agentType: AgentType;
		createdAt: number;
	};
	terminalId: string;
	setupWarning?: string;
}

export interface BatchCreateResult {
	succeeded: Array<{
		workspace: CreateWorkspaceResult["workspace"];
		terminalId: string;
		agentType: AgentType;
		setupWarning?: string;
	}>;
	failed: Array<{ branch: string; agentType: AgentType; error: string }>;
}

export interface MergeResult {
	ok: boolean;
	base: string;
	message: string;
}

export interface FileEntry {
	path: string;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrCheckState = "passing" | "failing" | "pending" | "none";

export interface PullRequestStatus {
	url: string;
	number: number;
	title: string;
	state: PrState;
	isDraft: boolean;
	reviewDecision: string | null;
	checks: {
		state: PrCheckState;
		total: number;
		failing: string[];
	};
}

async function requestText(path: string): Promise<string> {
	const res = await fetch(`/api${path}`, { headers: { ...authHeaders() } });
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? `${res.status} ${res.statusText}`);
	}
	return res.text();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...authHeaders(), ...init?.headers },
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error ?? `${res.status} ${res.statusText}`);
	}
	return res.json() as Promise<T>;
}

export const api = {
	getSettings: () => request<HostSettings>("/settings"),
	updateSettings: (patch: Partial<HostSettings>) =>
		request<HostSettings>("/settings", {
			method: "PUT",
			body: JSON.stringify(patch),
		}),

	listOrphanedWorktrees: () =>
		request<{ projectId: string; path: string }[]>("/orphaned-worktrees"),
	cleanupOrphanedWorktrees: () =>
		request<{ removed: number; failed: number; emptyDirsRemoved: number }>(
			"/orphaned-worktrees/cleanup",
			{ method: "POST" },
		),

	getDaemonStatus: () => request<{ liveSessionCount: number }>("/daemon/status"),
	// Stops the daemon process — kills EVERY live agent across every project.
	shutdownDaemon: () => request<{ ok: true }>("/daemon/shutdown", { method: "POST" }),

	listProjects: () => request<Project[]>("/projects"),
	addProject: (repoPath: string) =>
		request<Project>("/projects", {
			method: "POST",
			body: JSON.stringify({ repoPath }),
		}),
	removeProject: (id: string) =>
		request<{ ok: true }>(`/projects/${id}`, { method: "DELETE" }),
	// setupCommand runs standalone in a new workspace's worktree, before the
	// agent launches. Empty string clears it (server normalizes to null).
	updateProjectSetupCommand: (id: string, setupCommand: string) =>
		request<Project>(`/projects/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ setupCommand }),
		}),

	listWorkspaces: (projectId: string) =>
		request<WorkspaceWithStatus[]>(`/projects/${projectId}/workspaces`),
	// Re-fetches just ONE workspace's enriched row (status/diff/terminalId) —
	// used to apply a status-change event without recomputing a diff summary
	// for every other workspace in the project.
	getWorkspace: (id: string) => request<WorkspaceWithStatus>(`/workspaces/${id}`),
	createWorkspace: (projectId: string, prompt: string, name?: string) =>
		request<CreateWorkspaceResult>(`/projects/${projectId}/workspaces`, {
			method: "POST",
			body: JSON.stringify({ prompt, name }),
		}),
	// Fan one prompt out across N worktrees at once. Pass an explicit `agents`
	// list (one workspace per preset) and/or a `count` (that many copies of each
	// — or of the default agent when no presets are given). Returns which
	// targets succeeded and which failed; partial success is normal.
	createWorkspaceBatch: (
		projectId: string,
		prompt: string,
		opts: { agents?: AgentType[]; count?: number; name?: string },
	) =>
		request<BatchCreateResult>(`/projects/${projectId}/workspaces/batch`, {
			method: "POST",
			body: JSON.stringify({ prompt, ...opts }),
		}),
	// Launches a fresh terminal in an EXISTING workspace whose previous one
	// ended (no new worktree/branch) — resumes the prior Claude conversation
	// when a session_id was captured.
	resumeWorkspace: (id: string) =>
		request<{ terminalId: string }>(`/workspaces/${id}/resume`, {
			method: "POST",
		}),
	renameWorkspace: (id: string, name: string) =>
		request<{ ok: true }>(`/workspaces/${id}/rename`, {
			method: "POST",
			body: JSON.stringify({ name }),
		}),
	deleteWorkspace: (id: string, deleteBranch: boolean, force = false) =>
		request<{ ok: true }>(`/workspaces/${id}?deleteBranch=${deleteBranch}&force=${force}`, {
			method: "DELETE",
		}),
	getDiff: (id: string) => requestText(`/workspaces/${id}/diff`),
	merge: (id: string) =>
		request<MergeResult>(`/workspaces/${id}/merge`, { method: "POST" }),
	// Pushes the branch and opens a GitHub PR via `gh` (requires it installed
	// + authenticated). Falls back to an existing PR's URL on a repeat call.
	createPullRequest: (id: string) =>
		request<{ url: string }>(`/workspaces/${id}/pr`, { method: "POST" }),
	// Read-only PR state/review/CI status for the workspace's branch — `null`
	// when there's no PR, or `gh` isn't installed/authenticated. Server-side
	// cached (~30s) so `force` (the manual refresh button) is the only path
	// that's guaranteed to hit `gh` again.
	getPullRequestStatus: (id: string, force = false) =>
		request<PullRequestStatus | null>(
			`/workspaces/${id}/pr-status${force ? "?force=true" : ""}`,
		),
	openInEditor: (id: string) =>
		request<{ ok: true }>(`/workspaces/${id}/open`, { method: "POST" }),
	markSeen: (id: string) =>
		request<{ ok: true }>(`/workspaces/${id}/seen`, { method: "POST" }),
	getTree: (id: string) => request<FileEntry[]>(`/workspaces/${id}/tree`),
	getFile: (id: string, path: string) =>
		requestText(`/workspaces/${id}/file?path=${encodeURIComponent(path)}`),
};
