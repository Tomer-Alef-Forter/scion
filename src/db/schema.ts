// Pruned copy of superset's host-service Drizzle schema
// (~/Projects/superset/packages/host-service/src/db/schema.ts).
// Dropped: pullRequests, workspaceCloudDeletes, and cloud-sync columns.
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
	"projects",
	{
		id: text().primaryKey(),
		name: text().notNull().default(""),
		repoPath: text("repo_path").notNull(),
		defaultBranch: text("default_branch"),
		worktreeBaseDir: text("worktree_base_dir"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [uniqueIndex("projects_repo_path_idx").on(table.repoPath)],
);

export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text().primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		worktreePath: text("worktree_path").notNull(),
		branch: text().notNull(),
		baseBranch: text("base_branch"),
		name: text().notNull().default(""),
		type: text().$type<"main" | "worktree">().notNull().default("worktree"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		uniqueIndex("workspaces_one_main_per_project")
			.on(table.projectId)
			.where(sql`type = 'main'`),
	],
);

export const terminalSessions = sqliteTable(
	"terminal_sessions",
	{
		id: text().primaryKey(),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "cascade",
		}),
		status: text().notNull().default("active"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		endedAt: integer("ended_at"),
	},
	(table) => [
		index("terminal_sessions_workspace_id_idx").on(table.workspaceId),
	],
);

export const terminalAgentBindings = sqliteTable(
	"terminal_agent_bindings",
	{
		terminalId: text("terminal_id")
			.primaryKey()
			.references(() => terminalSessions.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		agentId: text("agent_id").notNull(),
		agentSessionId: text("agent_session_id"),
		startedAt: integer("started_at").notNull(),
		lastEventAt: integer("last_event_at").notNull(),
		lastEventType: text("last_event_type").notNull(),
	},
	(table) => [
		index("terminal_agent_bindings_workspace_id_idx").on(table.workspaceId),
	],
);

export const hostSettings = sqliteTable("host_settings", {
	id: integer().primaryKey().default(1),
	worktreeBaseDir: text("worktree_base_dir"),
});

export type Project = typeof projects.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type TerminalSession = typeof terminalSessions.$inferSelect;
export type TerminalAgentBinding = typeof terminalAgentBindings.$inferSelect;
