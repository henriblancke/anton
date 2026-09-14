-- Preserve the quota meter that actually moved for every newly charged Claude attempt and burn sample.
-- A project's router can change while a job is retried, so the mutable project settings and the
-- row-level `jobs.spent_attempts` diagnostic cannot reconstruct which meter an old attempt used.
--
-- Existing burn samples predate router attribution. Rows belonging to a project that still has a
-- gateway URL are quarantined as `unattributed`; its current route cannot safely identify their old
-- router connection or prove Anthropic produced them. Only legacy rows on an unrouted project retain
-- `anthropic`. The append-only `quota_attempts` ledger intentionally starts at this migration;
-- historical counters have no per-attempt meter identity and must not be guessed or backfilled.
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
ALTER TABLE `burn_samples` ADD `meter_key` text DEFAULT 'unattributed' NOT NULL;
--> statement-breakpoint
UPDATE `burn_samples`
SET `meter_key` = 'anthropic'
WHERE `project_id` IS NULL
   OR `project_id` IN (
     SELECT `id`
     FROM `projects`
     WHERE COALESCE(
       NULLIF(trim(CASE WHEN json_valid(`settings_json`) THEN json_extract(`settings_json`, '$.claudeBaseUrl') END), ''),
       ''
     ) = ''
   );
--> statement-breakpoint
CREATE INDEX `burn_samples_project_type_meter_created_idx` ON `burn_samples` (`project_id`,`job_type`,`meter_key`,`created_at`);
--> statement-breakpoint
DROP INDEX `jobs_updated_project_idx`;
