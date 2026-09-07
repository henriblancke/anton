-- Give the quota-share spend estimate (anton-yxux / R6.3, PR #248 review) a counter a resume cannot
-- rewind. It summed `attempts`, which is the RETRY budget: `resumeJob` zeroes it so an un-parked job
-- gets a fresh run at `maxAttempts`, and with it the meter forgot every attempt that job had already
-- burned this week — each park/resume cycle handed the project its share back.
--
-- `spent_attempts` moves with `attempts` on a lease and on a refund (an attempt that never reached
-- Claude is not spend), and nothing else touches it. Backfilled from `attempts` because, on the rows
-- an upgrading machine already holds, that is the only record of what was spent — and the estimate
-- charged exactly that until now, so the week's meter does not drop to zero on upgrade.
--
-- Reverse:
--   ALTER TABLE `jobs` DROP COLUMN `spent_attempts`;
ALTER TABLE `jobs` ADD `spent_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `jobs` SET `spent_attempts` = `attempts`;
