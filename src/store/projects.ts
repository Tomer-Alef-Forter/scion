// Project + workspace controller: DB rows are authoritative, reconciled
// against `git worktree list`. Wraps the engine (worktrees/agents/pty) so the
// UI has a small, synchronous-feeling API. Mirrors the intent of superset's
// workspaces.create / workspace.list, minus the cloud.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import {
	type Project,
	type Workspace,
	projects,
	terminalSessions,
	workspaces,
} from "../db/schema.ts";
import { launchClaude } from "../engine/agents.ts";
import {
	deduplicateBranchName,
	generateBranchName,
	generateFriendlyBranchName,
} from "../engine/branchName.ts";
import { createUserSimpleGit } from "../engine/gitClient.ts";
import { getSession, listSessions } from "../engine/pty.ts";
import type { StatusStore } from "../engine/status.ts";
import {
	addWorktree,
	removeWorktree,
	resolveDefaultBranch,
} from "../engine/worktrees.ts";

export interface Store {
	listProjects(): Project[];
	addProject(repoPath: string): Promise<Project>;
	removeProject(id: string): void;
	listWorkspaces(projectId: string): Workspace[];
	getProject(id: string): Project | undefined;
	getWorkspace(id: string): Workspace | undefined;
	createWorkspace(args: {
		projectId: string;
		prompt: string;
	}): Promise<{ workspace: Workspace; terminalId: string }>;
	/**
	 * Launch a fresh terminal in an EXISTING workspace's worktree — for when
	 * its previous terminal ended (no background daemon keeps PTYs alive
	 * across an app restart). No new worktree/branch is created. Resumes the
	 * prior Claude conversation via `--resume <session_id>` when one was
	 * captured from the lifecycle hook.
	 */
	resumeWorkspace(args: {
		workspaceId: string;
		prompt?: string;
	}): Promise<{ terminalId: string }>;
	deleteWorkspace(args: { workspaceId: string; deleteBranch: boolean }): Promise<void>;
}

function titleFromPrompt(prompt: string, fallback: string): string {
	const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) return fallback;
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

async function listBranchNames(repoPath: string): Promise<string[]> {
	const git = createUserSimpleGit(repoPath);
	const raw = await git
		.raw(["for-each-ref", "refs/heads/", "--format=%(refname:short)"])
		.catch(() => "");
	return raw.trim().split("\n").filter(Boolean);
}

export function createStore(db: Db, status: StatusStore): Store {
	return {
		listProjects() {
			return db.select().from(projects).all();
		},

		getProject(id) {
			return db.select().from(projects).where(eq(projects.id, id)).get();
		},

		getWorkspace(id) {
			return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
		},

		async addProject(repoPath) {
			const git = createUserSimpleGit(repoPath);
			const isRepo = await git.checkIsRepo().catch(() => false);
			if (!isRepo) throw new Error(`Not a git repository: ${repoPath}`);
			// Use the repo's top-level dir as the canonical path.
			const top = (await git.revparse(["--show-toplevel"]).catch(() => repoPath)).trim();

			const existing = db
				.select()
				.from(projects)
				.where(eq(projects.repoPath, top))
				.get();
			if (existing) return existing;

			const defaultBranch = await resolveDefaultBranch(top);
			const row = {
				id: randomUUID(),
				name: basename(top),
				repoPath: top,
				defaultBranch,
				worktreeBaseDir: null,
				createdAt: Date.now(),
			};
			db.insert(projects).values(row).run();
			return row;
		},

		removeProject(id) {
			db.delete(projects).where(eq(projects.id, id)).run();
		},

		listWorkspaces(projectId) {
			const rows = db
				.select()
				.from(workspaces)
				.where(eq(workspaces.projectId, projectId))
				.all();
			// Reconcile: drop rows whose worktree dir is gone.
			const live: Workspace[] = [];
			for (const row of rows) {
				if (existsSync(row.worktreePath)) {
					live.push(row);
				} else {
					db.delete(workspaces).where(eq(workspaces.id, row.id)).run();
				}
			}
			return live;
		},

		async createWorkspace({ projectId, prompt }) {
			const project = db
				.select()
				.from(projects)
				.where(eq(projects.id, projectId))
				.get();
			if (!project) throw new Error("Project not found");

			const existing = await listBranchNames(project.repoPath);
			const candidate = prompt.trim()
				? generateBranchName(prompt)
				: generateFriendlyBranchName();
			const branch = deduplicateBranchName(candidate, existing);

			const { worktreePath, baseBranch } = await addWorktree({
				projectId,
				repoPath: project.repoPath,
				branch,
			});

			const workspace: Workspace = {
				id: randomUUID(),
				projectId,
				worktreePath,
				branch,
				baseBranch,
				name: titleFromPrompt(prompt, branch),
				type: "worktree",
				createdAt: Date.now(),
			};
			db.insert(workspaces).values(workspace).run();

			const { terminalId } = launchClaude({
				workspaceId: workspace.id,
				worktreePath,
				prompt,
			});
			db.insert(terminalSessions)
				.values({
					id: terminalId,
					workspaceId: workspace.id,
					status: "active",
					createdAt: Date.now(),
					endedAt: null,
				})
				.run();

			// When the PTY exits, drop the agent-status binding.
			getSession(terminalId)?.onExit(() => status.markExited(terminalId));

			return { workspace, terminalId };
		},

		async resumeWorkspace({ workspaceId, prompt }) {
			const workspace = db
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get();
			if (!workspace) throw new Error("Workspace not found");

			// Already has a live terminal — nothing to resume.
			const live = listSessions(workspaceId).find((s) => !s.exited);
			if (live) return { terminalId: live.id };

			// Reuse the most recent Claude session_id captured from the lifecycle
			// hook (if any) so `--resume` continues the same conversation instead
			// of starting fresh.
			const bindings = status.listByWorkspace(workspaceId);
			const resumeSessionId = bindings[0]?.agentSessionId ?? null;

			// Old terminal_sessions rows for this workspace are now defunct (their
			// PTY is gone) — clear them before inserting the new one; cascades
			// remove their stale terminal_agent_bindings too.
			for (const session of db
				.select()
				.from(terminalSessions)
				.where(eq(terminalSessions.workspaceId, workspaceId))
				.all()) {
				db.delete(terminalSessions).where(eq(terminalSessions.id, session.id)).run();
			}

			const { terminalId } = launchClaude({
				workspaceId,
				worktreePath: workspace.worktreePath,
				prompt,
				resumeSessionId,
			});
			db.insert(terminalSessions)
				.values({
					id: terminalId,
					workspaceId,
					status: "active",
					createdAt: Date.now(),
					endedAt: null,
				})
				.run();

			getSession(terminalId)?.onExit(() => status.markExited(terminalId));

			return { terminalId };
		},

		async deleteWorkspace({ workspaceId, deleteBranch }) {
			const row = db
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get();
			if (!row) return;
			const project = db
				.select()
				.from(projects)
				.where(eq(projects.id, row.projectId))
				.get();

			// Kill any live PTYs for this workspace.
			for (const session of db
				.select()
				.from(terminalSessions)
				.where(eq(terminalSessions.workspaceId, workspaceId))
				.all()) {
				getSession(session.id)?.kill();
			}

			if (project) {
				await removeWorktree({
					repoPath: project.repoPath,
					worktreePath: row.worktreePath,
					deleteBranch: deleteBranch ? row.branch : null,
				});
			}
			db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
		},
	};
}
