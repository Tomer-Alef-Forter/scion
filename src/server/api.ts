// REST API for the web UI. Thin wrappers over the same store/engine the Ink
// TUI uses — no new business logic, just JSON in/out.
import { homedir } from "node:os";
import { Hono } from "hono";
import { getDiffSummary, getUnifiedDiff } from "../engine/diff.ts";
import { listFiles, readWorktreeFile } from "../engine/files.ts";
import { mergeBack } from "../engine/mergeBack.ts";
import { listSessions } from "../engine/pty.ts";
import type { StatusStore } from "../engine/status.ts";
import { openInEditor } from "../lib/openInEditor.ts";
import type { Store } from "../store/projects.ts";

export interface ApiDeps {
	store: Store;
	status: StatusStore;
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

export function createApiRoutes({ store, status }: ApiDeps): Hono {
	const api = new Hono();

	api.get("/health", (c) => c.json({ ok: true }));

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

	// ---- workspaces (listed/created under a project) ----

	api.get("/projects/:id/workspaces", async (c) => {
		const projectId = c.req.param("id");
		const project = store.getProject(projectId);
		if (!project) return c.json({ error: "Project not found" }, 404);

		const enriched = await Promise.all(
			store.listWorkspaces(projectId).map(async (workspace) => {
				const liveSessions = listSessions(workspace.id).filter(
					(s) => !s.exited,
				);
				const diff = await getDiffSummary(
					project.repoPath,
					workspace.worktreePath,
				).catch(() => null);
				// A binding row can outlive its process — killAll() calls
				// session.kill() but the app then exits before node-pty's async
				// onExit (which would normally call status.markExited) has a
				// chance to fire, leaving a stale row. Gate on a LIVE session so
				// a dead workspace always reports "done", never a stale status.
				let derivedStatus: string;
				if (liveSessions.length === 0) {
					derivedStatus = "done";
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
			}),
		);
		return c.json(enriched);
	});

	api.post("/projects/:id/workspaces", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json().catch(() => ({}));
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		try {
			const result = await store.createWorkspace({ projectId, prompt });
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

	api.delete("/workspaces/:id", async (c) => {
		const workspaceId = c.req.param("id");
		const deleteBranch = c.req.query("deleteBranch") === "true";
		await store.deleteWorkspace({ workspaceId, deleteBranch });
		return c.json({ ok: true });
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
		return c.json(result);
	});

	api.post("/workspaces/:id/open", async (c) => {
		const resolved = resolveWorkspace(store, c.req.param("id"));
		if (!resolved) return c.json({ error: "Workspace not found" }, 404);
		await openInEditor(resolved.workspace.worktreePath);
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
