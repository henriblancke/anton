-- Preserve the quota meter that actually moved for every newly charged Claude attempt and burn sample.
-- A project's router can change while a job is retried, so the mutable project settings and the
-- row-level `jobs.spent_attempts` diagnostic cannot reconstruct which meter an old attempt used.
--
-- Existing burn samples predate meter attribution. Current project settings cannot prove which meter
-- a historical sample moved: a gateway route may have changed or been cleared before upgrade. Quarantine
-- every pre-ledger sample as `unattributed`; the column's `anthropic` default serves only new writes whose
-- meter is captured at collection time. The append-only `quota_attempts` ledger intentionally starts at
-- this migration; historical counters have no per-attempt meter identity and must not be guessed or
-- backfilled.
-- Its rows deliberately carry no foreign keys, preserving the accounting record across job cleanup;
-- project teardown removes that project's ledger entries with its jobs.
--
-- Reverse (drop the meter index before its column, then restore the replaced legacy indexes):
--   DROP INDEX `burn_samples_project_type_meter_created_idx`;
--   ALTER TABLE `burn_samples` DROP COLUMN `meter_key`;
--   CREATE INDEX `burn_samples_project_type_created_idx` ON `burn_samples` (`project_id`,`job_type`,`created_at`);
--   DROP TABLE `quota_attempts`;
--   CREATE INDEX `jobs_updated_project_idx` ON `jobs` (`updated_at`,`project_id`);
CREATE TABLE `quota_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`job_type` text NOT NULL,
	`meter_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quota_attempts_meter_created_project_idx` ON `quota_attempts` (`meter_key`,`created_at`,`project_id`,`job_type`);
--> statement-breakpoint
DROP INDEX `burn_samples_project_type_created_idx`;
--> statement-breakpoint
ALTER TABLE `burn_samples` ADD `meter_key` text DEFAULT 'anthropic' NOT NULL;
--> statement-breakpoint
UPDATE `burn_samples`
SET `meter_key` = 'unattributed';
--> statement-breakpoint
CREATE INDEX `burn_samples_project_type_meter_created_idx` ON `burn_samples` (`project_id`,`job_type`,`meter_key`,`created_at`);
--> statement-breakpoint
DROP INDEX `jobs_updated_project_idx`;
