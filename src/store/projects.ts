// Project + workspace controller: DB rows are authoritative, reconciled
// against `git worktree list`. Wraps the engine (worktrees/agents/pty) so the
// UI has a small, synchronous-feeling API for creating, listing, and tearing
// down local workspaces.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import {
	type AgentType,
	type Project,
	type Workspace,
	projects,
	terminalSessions,
	workspaces,
} from "../db/schema.ts";
import { launchAgent } from "../engine/agents.ts";
import {
	deduplicateBranchName,
	generateBranchName,
	generateFriendlyBranchName,
} from "../engine/branchName.ts";
import { invalidateDiffCache, isClean } from "../engine/diff.ts";
import { createUserSimpleGit } from "../engine/gitClient.ts";
import {
	findOrphanedWorktrees,
	type OrphanedWorktree,
	pruneEmptyWorktreeDirs,
	removeOrphanedWorktree,
} from "../engine/orphans.ts";
import type { PtyBackend } from "../engine/ptyBackend.ts";
import { runSetupCommand } from "../engine/setupCommand.ts";
import type { StatusStore } from "../engine/status.ts";
import {
	addWorktree,
	removeWorktree,
	resolveDefaultBranch,
} from "../engine/worktrees.ts";
import { trustWorktree } from "../setup/trustWorktree.ts";
import { type HostSettings, getHostSettings, updateHostSettings } from "./hostSettings.ts";

/** One created workspace from a batch, tagged with the preset it launched. */
export interface BatchCreateSuccess {
	workspace: Workspace;
	terminalId: string;
	agentType: AgentType;
	setupWarning?: string;
}

/** One target from a batch that couldn't be created, with the reason. */
export interface BatchCreateFailure {
	branch: string;
	agentType: AgentType;
	error: string;
}

export interface BatchCreateResult {
	succeeded: BatchCreateSuccess[];
	failed: BatchCreateFailure[];
}

export interface Store {
	listProjects(): Project[];
	addProject(repoPath: string): Promise<Project>;
	removeProject(id: string): void;
	/** Currently just the per-project setup command run on new workspaces. */
	updateProject(id: string, patch: { setupCommand: string | null }): Project;
	listWorkspaces(projectId: string): Workspace[];
	getProject(id: string): Project | undefined;
	getWorkspace(id: string): Workspace | undefined;
	renameWorkspace(id: string, name: string): void;
	createWorkspace(args: {
		projectId: string;
		prompt: string;
		name?: string;
	}): Promise<{ workspace: Workspace; terminalId: string; setupWarning?: string }>;
	/**
	 * Fan one prompt out across N worktrees in a single call. Each entry in
	 * `agents` produces one independent workspace running that preset on the
	 * same prompt — so `["claude","claude","claude"]` gives three parallel
	 * attempts to compare, and `["claude","gemini","codex"]` compares how three
	 * CLIs handle the same task. Branch names are pre-allocated collision-free
	 * up front. Each workspace is created all-or-nothing (a failure rolls its
	 * own worktree back); the batch keeps going past a failed one and reports
	 * which succeeded and which failed.
	 */
	createWorkspaces(args: {
		projectId: string;
		prompt: string;
		agents: AgentType[];
		name?: string;
	}): Promise<BatchCreateResult>;
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
	/**
	 * Removes the worktree (and optionally the branch). Refuses if the
	 * worktree has uncommitted changes unless `force` is set — `git worktree
	 * remove --force --force` would otherwise silently discard real work.
	 */
	deleteWorkspace(args: {
		workspaceId: string;
		deleteBranch: boolean;
		force?: boolean;
	}): Promise<void>;
	getSettings(): HostSettings;
	updateSettings(patch: Partial<HostSettings>): HostSettings;
	listOrphanedWorktrees(): OrphanedWorktree[];
	cleanupOrphanedWorktrees(): Promise<{ removed: number; failed: number; emptyDirsRemoved: number }>;
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

export function createStore(db: Db, status: StatusStore, backend: PtyBackend): Store {
	// The whole "create one worktree + launch one agent into it" flow, shared by
	// the single- and batch-creation entry points so neither duplicates it. The
	// caller has already picked a collision-free branch, an agent preset, and a
	// display name. Everything past `addWorktree` is wrapped so a failure never
	// strands a created worktree (or a half-inserted workspace row): we roll the
	// whole thing back and rethrow, making each workspace all-or-nothing.
	async function createWorkspaceInWorktree(args: {
		project: Project;
		branch: string;
		agentType: AgentType;
		prompt: string;
		name: string;
	}): Promise<{ workspace: Workspace; terminalId: string; setupWarning?: string }> {
		const { project, branch, agentType, prompt, name } = args;

		const { worktreePath, baseBranch } = await addWorktree({
			projectId: project.id,
			repoPath: project.repoPath,
			branch,
		});

		let workspace: Workspace | undefined;
		try {
			// Before the agent ever launches — otherwise Claude Code's own
			// workspace-trust dialog (separate from --dangerously-skip-permissions)
			// would block on stdin the first time this brand-new directory opens.
			trustWorktree(worktreePath);

			workspace = {
				id: randomUUID(),
				projectId: project.id,
				worktreePath,
				branch,
				baseBranch,
				name,
				type: "worktree",
				agentType,
				createdAt: Date.now(),
			};
			db.insert(workspaces).values(workspace).run();

			// Runs concurrently with the agent launch, not before it — see
			// engine/setupCommand.ts. Non-blocking: a failure only surfaces as a
			// warning, it never stops (or waits on) the agent starting up.
			const [setupResult, { terminalId }] = await Promise.all([
				project.setupCommand
					? runSetupCommand(worktreePath, project.setupCommand)
					: Promise.resolve(null),
				launchAgent({
					backend,
					agentType,
					workspaceId: workspace.id,
					worktreePath,
					prompt,
				}),
			]);
			const setupWarning =
				setupResult && !setupResult.ok ? setupResult.message : undefined;
			db.insert(terminalSessions)
				.values({
					id: terminalId,
					workspaceId: workspace.id,
					status: "active",
					createdAt: Date.now(),
					endedAt: null,
				})
				.run();

			// PTY-exit -> markExited is wired by the daemon itself (it owns the
			// session for its whole lifetime) — see daemon/socketServer.ts.
			return { workspace, terminalId, setupWarning };
		} catch (err) {
			if (workspace) {
				db.delete(workspaces).where(eq(workspaces.id, workspace.id)).run();
			}
			await removeWorktree({
				repoPath: project.repoPath,
				worktreePath,
				deleteBranch: branch,
			}).catch(() => {});
			throw err;
		}
	}

	function getProjectOrThrow(projectId: string): Project {
		const project = db
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (!project) throw new Error("Project not found");
		return project;
	}

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

		renameWorkspace(id, name) {
			const trimmed = name.trim();
			if (!trimmed) throw new Error("Name cannot be empty");
			db.update(workspaces).set({ name: trimmed }).where(eq(workspaces.id, id)).run();
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
				setupCommand: null,
				createdAt: Date.now(),
			};
			db.insert(projects).values(row).run();
			return row;
		},

		removeProject(id) {
			db.delete(projects).where(eq(projects.id, id)).run();
		},

		updateProject(id, patch) {
			db.update(projects).set(patch).where(eq(projects.id, id)).run();
			const row = db.select().from(projects).where(eq(projects.id, id)).get();
			if (!row) throw new Error("Project not found");
			return row;
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

		async createWorkspace({ projectId, prompt, name }) {
			const project = getProjectOrThrow(projectId);

			const existing = await listBranchNames(project.repoPath);
			const candidate = prompt.trim()
				? generateBranchName(prompt)
				: generateFriendlyBranchName();
			const branch = deduplicateBranchName(candidate, existing);

			// Captured now, not re-read later — a workspace keeps using the agent
			// it was created with even if the default setting changes afterward.
			const { defaultAgent } = getHostSettings(db);

			return createWorkspaceInWorktree({
				project,
				branch,
				agentType: defaultAgent,
				prompt,
				name: name ?? titleFromPrompt(prompt, branch),
			});
		},

		async createWorkspaces({ projectId, prompt, agents, name }) {
			const project = getProjectOrThrow(projectId);
			if (!Array.isArray(agents) || agents.length === 0) {
				throw new Error("Batch requires at least one target agent");
			}

			// Pre-allocate a collision-free branch per target up front,
			// deduplicating against BOTH the repo's existing branches and the
			// ones we're about to create in this same batch — the shared
			// random-suffix slug makes collisions unlikely but not impossible, and
			// two targets from the same prompt must never race to the same name.
			const taken = await listBranchNames(project.repoPath);
			const baseLabel = name?.trim() || titleFromPrompt(prompt, "");
			const plans = agents.map((agentType, i) => {
				const candidate = prompt.trim()
					? generateBranchName(prompt)
					: generateFriendlyBranchName();
				const branch = deduplicateBranchName(candidate, taken);
				taken.push(branch);
				// Distinguish otherwise-identical rows in the dashboard.
				const label = baseLabel || branch;
				const wsName =
					agents.length > 1 ? `${label} · ${agentType} #${i + 1}` : label;
				return { agentType, branch, name: wsName };
			});

			const succeeded: BatchCreateSuccess[] = [];
			const failed: BatchCreateFailure[] = [];
			for (const plan of plans) {
				try {
					const result = await createWorkspaceInWorktree({
						project,
						branch: plan.branch,
						agentType: plan.agentType,
						prompt,
						name: plan.name,
					});
					succeeded.push({ ...result, agentType: plan.agentType });
				} catch (err) {
					failed.push({
						branch: plan.branch,
						agentType: plan.agentType,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return { succeeded, failed };
		},

		async resumeWorkspace({ workspaceId, prompt }) {
			const workspace = db
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get();
			if (!workspace) throw new Error("Workspace not found");

			// Already has a live terminal — nothing to resume.
			const live = (await backend.listSessions(workspaceId)).find((s) => !s.exited);
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

			const { terminalId } = await launchAgent({
				backend,
				agentType: workspace.agentType,
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

			// PTY-exit -> markExited: daemon-owned now, see createWorkspace above.

			return { terminalId };
		},

		async deleteWorkspace({ workspaceId, deleteBranch, force }) {
			const row = db
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get();
			if (!row) return;

			if (!force && existsSync(row.worktreePath) && !(await isClean(row.worktreePath))) {
				throw new Error(
					"Worktree has uncommitted changes — commit or discard them first, or confirm to delete anyway.",
				);
			}

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
				await backend.killSession(session.id);
			}

			if (project) {
				await removeWorktree({
					repoPath: project.repoPath,
					worktreePath: row.worktreePath,
					deleteBranch: deleteBranch ? row.branch : null,
				});
			}
			db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
			invalidateDiffCache(row.worktreePath);

			if (getHostSettings(db).lastOpenedWorkspaceId === workspaceId) {
				updateHostSettings(db, { lastOpenedWorkspaceId: null });
			}
		},

		getSettings() {
			return getHostSettings(db);
		},

		updateSettings(patch) {
			return updateHostSettings(db, patch);
		},

		listOrphanedWorktrees() {
			const knownPaths = new Set(
				db.select().from(workspaces).all().map((w) => w.worktreePath),
			);
			return findOrphanedWorktrees(knownPaths);
		},

		async cleanupOrphanedWorktrees() {
			const knownPaths = new Set(
				db.select().from(workspaces).all().map((w) => w.worktreePath),
			);
			const orphans = findOrphanedWorktrees(knownPaths);
			const allProjects = db.select().from(projects).all();

			let removed = 0;
			let failed = 0;
			for (const orphan of orphans) {
				try {
					await removeOrphanedWorktree(orphan, allProjects);
					removed++;
				} catch {
					failed++;
				}
			}
			const emptyDirsRemoved = pruneEmptyWorktreeDirs();
			return { removed, failed, emptyDirsRemoved };
		},
	};
}
