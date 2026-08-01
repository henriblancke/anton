CREATE TABLE `escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`finding_key` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`bead_id` text,
	`epic_bead_id` text,
	`run_id` text,
	`job_id` text,
	`since` integer,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`noted_at` integer,
	`raised_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `escalations_open_unique` ON `escalations` (`project_id`,`finding_key`) WHERE "escalations"."status" = 'open';--> statement-breakpoint
CREATE INDEX `escalations_project_status_idx` ON `escalations` (`project_id`,`status`);