ALTER TABLE `host_settings` ADD `default_agent` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `host_settings` ADD `default_editor` text DEFAULT 'vscode' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `agent_type` text DEFAULT 'claude' NOT NULL;