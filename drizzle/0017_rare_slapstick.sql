CREATE TABLE `board_picker_plans` (
	`project_id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`board_digest` text NOT NULL,
	`board_observed_at_ms` integer NOT NULL,
	`board_bead_count` integer DEFAULT 0 NOT NULL,
	`entries_json` text DEFAULT '[]' NOT NULL,
	`exclusions_json` text DEFAULT '[]' NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
