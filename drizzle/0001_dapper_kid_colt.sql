CREATE UNIQUE INDEX `jobs_active_epic_unique` ON `jobs` (`type`,`project_id`,json_extract(`payload_json`, '$.epicBeadId')) WHERE `status` in ('queued', 'running');
