CREATE TABLE `host_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`worktree_base_dir` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`repo_path` text NOT NULL,
	`default_branch` text,
	`worktree_base_dir` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_idx` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE TABLE `terminal_agent_bindings` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_session_id` text,
	`started_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`last_event_type` text NOT NULL,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `terminal_agent_bindings_workspace_id_idx` ON `terminal_agent_bindings` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_workspace_id_idx` ON `terminal_sessions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text,
	`name` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'worktree' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspaces_project_id_idx` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_one_main_per_project` ON `workspaces` (`project_id`) WHERE type = 'main';