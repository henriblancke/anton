-- Coalesce any pre-existing duplicate active jobs before the unique index is created. Installs that
-- accumulated duplicate (queued|running) jobs for the same (type, project_id, epicBeadId) — the exact
-- state possible before this dedupe fix, from double approvals or retriggers — would otherwise fail
-- the CREATE UNIQUE INDEX validation and, since `anton start` now migrates before serving, fail to
-- boot. Keep one active job per group (preferring a live `running` lease over a `queued` one, then the
-- most recent) and mark the superseded duplicates `failed`. Only rows whose index columns are all
-- non-NULL can collide (SQLite treats NULLs as distinct in unique indexes), so job types without an
-- epicBeadId in their payload, and rows without a project, are left untouched.
UPDATE `jobs`
SET `status` = 'failed',
    `last_error` = 'superseded: duplicate active job coalesced before jobs_active_epic_unique index',
    `lease_expires_at` = NULL,
    `updated_at` = unixepoch()
WHERE `rowid` IN (
  SELECT `rowid` FROM (
    SELECT `rowid`,
           ROW_NUMBER() OVER (
             PARTITION BY `type`, `project_id`, json_extract(`payload_json`, '$.epicBeadId')
             ORDER BY (`status` = 'running') DESC, `created_at` DESC, `rowid` DESC
           ) AS rn
    FROM `jobs`
    WHERE `status` in ('queued', 'running')
      AND `project_id` IS NOT NULL
      AND json_extract(`payload_json`, '$.epicBeadId') IS NOT NULL
  ) WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_epic_unique` ON `jobs` (`type`,`project_id`,json_extract(`payload_json`, '$.epicBeadId')) WHERE `status` in ('queued', 'running');
