CREATE TABLE `picker_starts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`bead_id` text NOT NULL,
	`rank` integer NOT NULL,
	`ranked` integer NOT NULL,
	`rule` text NOT NULL,
	`job_id` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `picker_starts_project_idx` ON `picker_starts` (`project_id`,`started_at`);