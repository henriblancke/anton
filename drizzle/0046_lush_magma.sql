CREATE INDEX `jobs_queued_due_idx` ON `jobs` (`run_at`) WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX `jobs_running_lease_idx` ON `jobs` (`lease_expires_at`) WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `jobs_project_updated_idx` ON `jobs` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runs_open_epic_updated_idx` ON `runs` (`project_id`,`epic_bead_id`,`updated_at`) WHERE "runs"."status" in ('queued', 'running', 'parked');--> statement-breakpoint
CREATE INDEX `sessions_run_started_idx` ON `sessions` (`run_id`,`started_at`);