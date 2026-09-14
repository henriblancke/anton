-- Preserve the existing Anthropic pacing estimate across the quota-attempt-ledger upgrade.
--
-- `spent_attempts` was the prior estimate's durable counter (0033) and `updated_at` was its
-- deliberately approximate weekly boundary. A current router configuration cannot identify the
-- historical meter, so only projects that are still safely unrouted are carried forward. Already
-- recorded ledger rows are subtracted, making this safe if a machine had applied 0038 before 0040.
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
  INNER JOIN `projects` ON `projects`.`id` = `jobs`.`project_id`
  WHERE `jobs`.`spent_attempts` > (SELECT count(*) FROM `quota_attempts` WHERE `job_id` = `jobs`.`id`)
    AND `jobs`.`updated_at` >= unixepoch() - 7 * 24 * 60 * 60
    AND NOT (
      COALESCE(NULLIF(trim(CASE WHEN json_valid(`projects`.`settings_json`) THEN json_extract(`projects`.`settings_json`, '$.claudeBaseUrl') END), ''), '') <> ''
      AND COALESCE(NULLIF(trim(CASE WHEN json_valid(`projects`.`settings_json`) THEN json_extract(`projects`.`settings_json`, '$.routerConnectionId') END), ''), '') <> ''
    )
  UNION ALL
  SELECT
    'legacy:' || `job_id` || ':' || (`remaining` + 1),
    `job_id`, `project_id`, `job_type`, `created_at`, `remaining` - 1
  FROM attempts
  WHERE `remaining` > 1
)
SELECT `id`, `job_id`, `project_id`, `job_type`, 'anthropic', `created_at`
FROM attempts;
