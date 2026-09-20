CREATE INDEX `jobs_status_run_at_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_lease_expires_at_idx` ON `jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_project_updated_idx` ON `jobs` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runs_project_epic_updated_idx` ON `runs` (`project_id`,`epic_bead_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sessions_run_started_idx` ON `sessions` (`run_id`,`started_at`);
