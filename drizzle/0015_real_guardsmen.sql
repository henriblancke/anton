ALTER TABLE `sessions` ADD `job_id` text REFERENCES jobs(id);--> statement-breakpoint
CREATE INDEX `sessions_job_idx` ON `sessions` (`job_id`);