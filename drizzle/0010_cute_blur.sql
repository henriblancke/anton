CREATE TABLE `scan_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text,
	`session_id` text,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`total_signals` integer DEFAULT 0 NOT NULL,
	`by_severity_json` text DEFAULT '{}' NOT NULL,
	`by_class_json` text DEFAULT '{}' NOT NULL,
	`delta_json` text,
	`beads_created` integer,
	`beads_deduped` integer,
	`collector_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scan_summaries_project_idx` ON `scan_summaries` (`project_id`,`generated_at`);