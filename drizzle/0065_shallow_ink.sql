CREATE INDEX `escalations_project_raised_idx` ON `escalations` (`project_id`,`raised_at`);--> statement-breakpoint
CREATE INDEX `run_attempts_project_ended_idx` ON `run_attempts` (`project_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `runs_project_started_idx` ON `runs` (`project_id`,`started_at`);