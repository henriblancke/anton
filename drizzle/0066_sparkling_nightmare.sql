CREATE INDEX `escalations_project_updated_idx` ON `escalations` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runs_project_updated_idx` ON `runs` (`project_id`,`updated_at`);