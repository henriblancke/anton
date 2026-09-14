CREATE TABLE `picker_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`bead_id` text NOT NULL,
	`verdict` text NOT NULL,
	`action` text NOT NULL,
	`rule` text,
	`criterion` text,
	`rank` integer,
	`plan_digest` text,
	`deferred_until` integer,
	`decided_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `picker_verdicts_project_idx` ON `picker_verdicts` (`project_id`,`decided_at`);--> statement-breakpoint
CREATE INDEX `picker_verdicts_deferred_idx` ON `picker_verdicts` (`project_id`,`deferred_until`);