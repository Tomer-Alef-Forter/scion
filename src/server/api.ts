// REST API for the web UI. Thin wrappers over the same store/engine the Ink
// TUI uses — no new business logic, just JSON in/out.
import { homedir } from "node:os";
import { Hono } from "hono";
import type { AgentType, EditorType, Project, Workspace } from "../db/schema.ts";
import { getCachedDiffSummary, getUnifiedDiff, invalidateDiffCache } from "../engine/diff.ts";
import { listFiles, readWorktreeFile } from "../engine/files.ts";
import { mergeBack } from "../engine/mergeBack.ts";
import {
	getCachedPullRequestStatus,
	invalidatePullRequestStatusCache,
} from "../engine/prStatus.ts";
import { createPullRequest } from "../engine/pullRequest.ts";
import type { PtyBackend } from "../engine/ptyBackend.ts";
import type { StatusStore } from "../engine/status.ts";
import { openInEditor } from "../lib/openInEditor.ts";
import type { Store } from "../store/projects.ts";

const AGENT_TYPES: AgentType[] = [
	"claude",
	"gemini",
	"codex",
	"cursor-agent",
	"droid",
	"opencode",
	"copilot",
];
const EDITOR_TYPES: EditorType[] = ["vscode", "cursor", "zed"];

export interface ApiDeps {
	store: Store;
	status: StatusStore;
	backend: PtyBackend;
}

function expandHome(path: string): string {
	return path.startsWith("~") ? homedir() + path.slice(1) : path;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function resolveWorkspace(store: Store, workspaceId: string) {
	const workspace = store.getWorkspace(workspaceId);
	if (!workspace) return null;
	const project = store.getProject(workspace.projectId);
	if (!project) return null;
	return { workspace, project };
}

// Shared by the list route and the single-workspace route so a status-change
// event (which names exactly one workspace) can be re-enriched WITHOUT
// re-running getCachedDiffSummary — and thus a real `git` subprocess pair —
// for every other workspace in the project.
async function enrichWorkspace(
	status: StatusStore,
	backend: PtyBackend,
	project: Project,
	workspace: Workspace,
) {
	const liveSessions = (await backend.listSessions(workspace.id)).filter((s) => !s.exited);
	const diff = await getCachedDiffSummary(
		project.repoPath,
		workspace.worktreePath,
	).catch(() => null);
	// A binding row can outlive its process — killAll() calls session.kill()
	// but the app then exits before node-pty's async onExit (which would
	// normally call status.markExited) has a chance to fire, leaving a stale
	// row. Gate on a LIVE session so a dead workspace always reports "done",
	// never a stale status.
	let derivedStatus: string;
	if (liveSessions.length === 0) {
		derivedStatus = "done";
	} else if (workspace.agentType !== "claude") {
		// Only Claude Code reports lifecycle events via hooks — other agents
		// have no equivalent, so there's no way to distinguish
		// working/waiting/review for them. Best effort: just "working" for
		// the life of the session.
		derivedStatus = "working";
	} else {
		const bindings = status.listByWorkspace(workspace.id);
		derivedStatus = bindings[0]?.status ?? "starting";
	}
	return {
		...workspace,
		status: derivedStatus,
		terminalId: liveSessions[0]?.id ?? null,
		diff,
	};
}

// Kills every live agent for a single workspace WITHOUT stopping the daemon or
// touching any other workspace/project. Each PTY is its own OS session, so
// killing this subset never signals another project's agents. Composed from the
// same primitives store.deleteWorkspace() uses, so it stays a pure blast-radius
// scoping helper — no new daemon machinery. Returns how many sessions it killed.
async function stopWorkspaceAgents(backend: PtyBackend, workspaceId: string): Promise<number> {
	const live = (await backend.listSessions(workspaceId)).filter((s) => !s.exited);
	for (const session of live) {
		await backend.killSession(session.id);
	}
	return live.length;
}

export function createApiRoutes({ store, status, backend }: ApiDeps): Hono {
	const api = new Hono();

	api.get("/health", (c) => c.json({ ok: true }));

	// ---- settings ----

	api.get("/settings", (c) => c.json(store.getSettings()));

	api.put("/settings", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const patch: {
			defaultAgent?: AgentType;
			defaultEditor?: EditorType;
			lastOpenedWorkspaceId?: string | null;
		} = {};
		if (AGENT_TYPES.includes(body.defaultAgent)) patch.defaultAgent = body.defaultAgent;
		if (EDITOR_TYPES.includes(body.defaultEditor)) patch.defaultEditor = body.defaultEditor;
		if (typeof body.lastOpenedWorkspaceId === "string" || body.lastOpenedWorkspaceId === null) {
			patch.lastOpenedWorkspaceId = body.lastOpenedWorkspaceId;
		}
		return c.json(store.updateSettings(patch));
	});

	// ---- orphaned worktrees (dirs on disk with no matching workspace row —
	// left behind by a removed project/workspace whose worktree didn't get
	// cleaned up) ----

	api.get("/orphaned-worktrees", (c) => c.json(store.listOrphanedWorktrees()));

	api.post("/orphaned-worktrees/cleanup", async (c) => {
		const result = await store.cleanupOrphanedWorktrees();
		return c.json(result);
	});

	// ---- PTY daemon (owns every live agent independently of this process —
	// see src/daemon/*) ----

	api.get("/daemon/status", async (c) => {
		const sessions = await backend.listSessions();
		return c.json({ liveSessionCount: sessions.filter((s) => !s.exited).length });
	});

	// GLOBAL kill switch (explicit, wide blast radius): stops the daemon process
	// itself, which kills EVERY live agent across EVERY project at once, since
	// the daemon is a single shared process. This is the deliberate "stop
	// everything" escape hatch — to stop just one project's or one workspace's
	// agents while leaving the daemon and every other project running, use the
	// scoped POST /projects/:id/agents/stop or /workspaces/:id/agents/stop below.
	api.post("/daemon/shutdown", async (c) => {
		await backend.shutdownDaemon();
		return c.json({ ok: true });
	});

	// ---- projects ----

	api.get("/projects", (c) => c.json(store.listProjects()));

	api.post("/projects", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const repoPath =
			typeof body.repoPath === "string" ? body.repoPath.trim() : "";
		if (!repoPath) {
			return c.json({ error: "repoPath is required" }, 400);
		}
		try {
			const project = await store.addProject(expandHome(repoPath));
			return c.json(project, 201);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	api.delete("/projects/:id", (c) => {
		store.removeProject(c.req.param("id"));
		return c.json({ ok: true });
	});

	// Scoped stop: kills every live agent across THIS project's workspaces only,
	// leaving the daemon and every OTHER project's agents running. Preferred
	// over the global /daemon/shutdown whenever the intent is to stop work on
	// one project.
	api.post("/projects/:id/agents/stop", async (c) => {
		const projectId = c.req.param("id");
		if (!store.getProject(projectId)) return c.json({ error: "Project not found" }, 404);
		let killed = 0;
		for (const workspace of store.listWorkspaces(projectId)) {
			killed += await stopWorkspaceAgents(backend, workspace.id);
		}
		return c.json({ ok: true, killed });
	});

	// setupCommand runs standalone in a new workspace's worktree, before the
	// agent launches — see engine/setupCommand.ts.
	api.patch("/projects/:id", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const raw = typeof body.setupCommand === "string" ? body.setupCommand.trim() : "";
		try {
			const project = store.updateProject(c.req.param("id"), {
				setupCommand: raw ? raw : null,
			});
			return c.json(project);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	// ---- workspaces (listed/created under a project) ----

	api.get("/projects/:id/workspaces", async (c) => {
		const projectId = c.req.param("id");
		const project = store.getProject(projectId);
		if (!project) return c.json({ error: "Project not found" }, 404);

		const enriched = await Promise.all(
			store
				.listWorkspaces(projectId)
				.map((workspace) => enrichWorkspace(status, backend, project, workspace)),
		);
		return c.json(enriched);
	});

	// Single-workspace fetch — used by the client to refresh just the one
	// workspace named in a status-change event, instead of the whole list
	// (and thus instead of a diff recompute for every OTHER workspace too).
	api.get("/workspaces/:id", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const enriched = await enrichWorkspace(status, backend, resolved.project, resolved.workspace);
		return c.json(enriched);
	});

	api.post("/projects/:id/workspaces", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}));
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
		try {
			const result = await store.createWorkspace({ projectId, prompt, name });
			return c.json(result, 201);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	// ---- workspace-scoped actions ----

	api.post("/workspaces/:id/resume", async (c) => {
		const workspaceId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}));
		const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
		try {
			const result = await store.resumeWorkspace({ workspaceId, prompt });
			return c.json(result, 201);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	// Scoped stop: kills every live agent for a single workspace, leaving the
	// daemon and all other workspaces/projects untouched.
	api.post("/workspaces/:id/agents/stop", async (c) => {
		const workspaceId = c.req.param("id");
		if (!store.getWorkspace(workspaceId)) return c.json({ error: "Workspace not found" }, 404);
		const killed = await stopWorkspaceAgents(backend, workspaceId);
		return c.json({ ok: true, killed });
	});

	api.post("/workspaces/:id/rename", async (c) => {
		const workspaceId = c.req.param("id");
		if (!store.getWorkspace(workspaceId)) {
			return c.json({ error: "Workspace not found" }, 404);
		}
		const body = await c.req.json().catch(() => ({}));
		const name = typeof body.name === "string" ? body.name : "";
		try {
			store.renameWorkspace(workspaceId, name);
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	api.delete("/workspaces/:id", async (c) => {
		const workspaceId = c.req.param("id");
		const deleteBranch = c.req.query("deleteBranch") === "true";
		const force = c.req.query("force") === "true";
		try {
			await store.deleteWorkspace({ workspaceId, deleteBranch, force });
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	api.get("/workspaces/:id/diff", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const diff = await getUnifiedDiff(
			resolved.project.repoPath,
			resolved.workspace.worktreePath,
		);
		return c.text(diff);
	});

	api.post("/workspaces/:id/merge", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const result = await mergeBack({
			repoPath: resolved.project.repoPath,
			branch: resolved.workspace.branch,
			worktreePath: resolved.workspace.worktreePath,
		});
		invalidateDiffCache(resolved.workspace.worktreePath);
		return c.json(result);
	});

	api.post("/workspaces/:id/pr", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		try {
			const result = await createPullRequest({
				worktreePath: resolved.workspace.worktreePath,
				branch: resolved.workspace.branch,
			});
			return c.json(result);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	// Read-only PR status (state, review decision, CI checks) for the
	// workspace's branch, via `gh pr view` — see engine/prStatus.ts. Returns
	// `null` (not a 4xx) whenever there's nothing to show: no PR for this
	// branch, `gh` missing/unauthenticated, no network, etc. `?force=true`
	// bypasses the server-side cache — used by the UI's manual refresh button.
	api.get("/workspaces/:id/pr-status", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		if (c.req.query("force") === "true") {
			invalidatePullRequestStatusCache(resolved.workspace.worktreePath);
		}
		const prStatus = await getCachedPullRequestStatus(resolved.workspace.worktreePath);
		return c.json(prStatus);
	});

	api.post("/workspaces/:id/open", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const { defaultEditor } = store.getSettings();
		await openInEditor(resolved.workspace.worktreePath, defaultEditor);
		return c.json({ ok: true });
	});

	api.post("/workspaces/:id/seen", (c) => {
		status.markSeen(c.req.param("id"));
		return c.json({ ok: true });
	});

	api.get("/workspaces/:id/tree", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const files = await listFiles(resolved.workspace.worktreePath);
		return c.json(files);
	});

	api.get("/workspaces/:id/file", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		const path = c.req.query("path");
		if (!path) return c.json({ error: "path query param is required" }, 400);
		try {
			const contents = await readWorktreeFile(resolved.workspace.worktreePath, path);
			return c.text(contents);
		} catch (err) {
			return c.json({ error: errMsg(err) }, 400);
		}
	});

	return api;
}
