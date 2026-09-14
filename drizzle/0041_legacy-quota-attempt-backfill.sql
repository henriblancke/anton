-- Preserve the existing Anthropic pacing estimate across the quota-attempt-ledger upgrade.
--
-- `spent_attempts` was the prior estimate's durable counter (0033) and `updated_at` was its
-- deliberately approximate weekly boundary. It contains no meter provenance, and a current route cannot
-- prove a past attempt used Anthropic: a project may have used a gateway earlier this quota week and
-- cleared its URL before upgrading. Preserve that ambiguity instead of misattributing the attempt to
-- Anthropic; already recorded ledger rows are subtracted, making this safe if a machine had applied
-- 0039 before 0041.
--
-- Reverse:
--   DELETE FROM `quota_attempts` WHERE `id` LIKE 'legacy:%';
INSERT INTO `quota_attempts` (`id`, `job_id`, `project_id`, `job_type`, `meter_key`, `created_at`)
WITH RECURSIVE attempts (`id`, `job_id`, `project_id`, `job_type`, `created_at`, `remaining`) AS (
  SELECT
    'legacy:' || `jobs`.`id` || ':1',
    `jobs`.`id`,
    `jobs`.`project_id`,
    `jobs`.`type`,
    `jobs`.`updated_at`,
    `jobs`.`spent_attempts` - (SELECT count(*) FROM `quota_attempts` WHERE `job_id` = `jobs`.`id`)
  FROM `jobs`
  WHERE `jobs`.`spent_attempts` > (SELECT count(*) FROM `quota_attempts` WHERE `job_id` = `jobs`.`id`)
    AND `jobs`.`updated_at` >= unixepoch() - 7 * 24 * 60 * 60
    -- No legacy counter has a meter identity. Do not create Anthropic-attributed rows from a
    -- mutable project's current router settings; all pre-ledger attempts remain unattributed.
    AND 0
  UNION ALL
  SELECT
    'legacy:' || `job_id` || ':' || (`remaining` + 1),
    `job_id`, `project_id`, `job_type`, `created_at`, `remaining` - 1
  FROM attempts
  WHERE `remaining` > 1
)
SELECT `id`, `job_id`, `project_id`, `job_type`, 'anthropic', `created_at`
FROM attempts;
