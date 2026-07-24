CREATE TABLE `burn_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`session_delta` real NOT NULL,
	`weekly_delta` real NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `burn_samples_type_created_idx` ON `burn_samples` (`job_type`,`created_at`);