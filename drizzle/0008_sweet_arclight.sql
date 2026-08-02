CREATE TABLE `hygiene_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`findings_json` text DEFAULT '[]' NOT NULL,
	`closed_epics_json` text DEFAULT '[]' NOT NULL,
	`rows_recomputed` integer DEFAULT 0 NOT NULL,
	`finding_count` integer DEFAULT 0 NOT NULL,
	`closed_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hygiene_reports_project_idx` ON `hygiene_reports` (`project_id`,`generated_at`);