CREATE TABLE `run_health_reports` (
	`project_id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`findings_json` text DEFAULT '[]' NOT NULL,
	`finding_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
