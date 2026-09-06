-- Attribute each burn sample to the project that spent it (anton-wj3d), so per-project quota share
-- can be measured at all — until now spend was knowable only by job TYPE.
--
-- Additive and nullable: existing rows keep a NULL project rather than being backfilled with a guess,
-- because they genuinely do not know theirs and inventing one would poison the very averages the
-- shares depend on. Per-project reads match on equality, so those rows are excluded, not misattributed.
--
-- Reverse (SQLite requires the index to go first — a column under an index cannot be dropped):
--   DROP INDEX `burn_samples_project_type_created_idx`;
--   ALTER TABLE `burn_samples` DROP COLUMN `project_id`;
ALTER TABLE `burn_samples` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
CREATE INDEX `burn_samples_project_type_created_idx` ON `burn_samples` (`project_id`,`job_type`,`created_at`);
