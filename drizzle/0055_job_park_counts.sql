-- Durable park counters for the friction ledger (PR #322 review). `reschedule`/`park` clear
-- `lastError` and flip `status` on the very next settle, so `countQuotaParks`/`countFailureParks`
-- reading those columns saw at most the CURRENT pause: a job quota-parked twice, or resumed after a
-- failure park, undercounted or fell back to zero as work proceeded — a friction number that
-- decreases as anton keeps running is one nobody can trend.
--
-- These only ever increment, mirroring `spent_attempts` (0033): `quota_park_count` on every quota
-- reschedule, `failure_park_count` on every `park()` call, neither ever cleared by a resume.
--
-- Reverse:
--   ALTER TABLE `jobs` DROP COLUMN `quota_park_count`;
--   ALTER TABLE `jobs` DROP COLUMN `failure_park_count`;
ALTER TABLE `jobs` ADD `quota_park_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `failure_park_count` integer DEFAULT 0 NOT NULL;
