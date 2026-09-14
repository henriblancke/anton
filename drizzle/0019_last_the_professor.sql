CREATE TABLE `autopilot_disarms` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`escalation_id` text,
	`disarmed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`rearmed_at` integer,
	`rearmed_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autopilot_disarms_latched_unique` ON `autopilot_disarms` (`project_id`) WHERE "autopilot_disarms"."rearmed_at" is null;--> statement-breakpoint
CREATE INDEX `autopilot_disarms_project_idx` ON `autopilot_disarms` (`project_id`,`disarmed_at`);