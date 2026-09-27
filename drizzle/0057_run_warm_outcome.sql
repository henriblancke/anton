-- Record what warming did to a run's checkout (anton-de17i), so the result survives the process
-- that produced it. Until now it reached only a console.warn the job runner does not persist: a
-- warm that failed on a missing devDependency surfaced minutes later as a git push error naming an
-- unrelated subsystem, with nothing queryable pointing back at the install.
--
-- `warm_outcome` is one of ok | failed | skipped | disabled — an install that exited 0, one that
-- did not (label in `warm_command`, bounded stderr tail in `warm_error`), one attempted with
-- nothing to run (no lockfile, an install already newer than it, no package manager on PATH), and
-- warming turned off. Nullable and NOT backfilled: null is "never attempted", which covers rows
-- that predate this column and callers that never warm — deliberately distinct from `skipped`, a
-- warm that ran and found nothing to do.
--
-- Reverse:
--   ALTER TABLE `runs` DROP COLUMN `warm_outcome`;
--   ALTER TABLE `runs` DROP COLUMN `warm_command`;
--   ALTER TABLE `runs` DROP COLUMN `warm_error`;
ALTER TABLE `runs` ADD `warm_outcome` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `warm_command` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `warm_error` text;