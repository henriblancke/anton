-- The per-invocation spend fact table (anton-77l9): one row per Claude invocation and model.
-- This migration is purely additive and applies to a populated anton.db.
--
-- Reverse:
--   DROP TABLE `claude_invocations`;
CREATE TABLE `claude_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`job_type` text,
	`job_id` text,
	`step` text,
	`run_id` text,
	`bead_id` text,
	`claude_session_id` text,
	`model_requested` text,
	`model_reported` text,
	`endpoint_host` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`thinking_tokens` integer,
	`cache_read_input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`web_search_requests` integer,
	`num_turns` integer,
	`cost_usd` real,
	`duration_ms` integer,
	`duration_api_ms` integer,
	`outcome` text NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claude_invocations_project_idx` ON `claude_invocations` (`project_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `claude_invocations_run_idx` ON `claude_invocations` (`run_id`);
