DROP INDEX `workspaces_one_main_per_project`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `type`;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `total_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `total_output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `total_cache_creation_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `total_cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `turn_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `terminal_agent_bindings` ADD `usage_updated_at` integer;