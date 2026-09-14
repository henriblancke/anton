-- Keep each meter's rolling global burn read bounded as routed rows accumulate.
--
-- Reverse:
--   DROP INDEX `burn_samples_type_meter_created_idx`;
CREATE INDEX `burn_samples_type_meter_created_idx` ON `burn_samples` (`job_type`,`meter_key`,`created_at`);