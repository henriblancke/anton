ALTER TABLE `runs` ADD `delivered` integer DEFAULT true NOT NULL;
--> statement-breakpoint
-- The default above is right for a row written before this column existed IF it was a genuine
-- delivery — but `settleRetiredStandalone` and `finishRun`'s `targetRetired` path (both anton-5bpd,
-- #238) predate this column and already settled a verified already-shipped retirement `done` with
-- no pull request opened. On a populated database those legacy rows would default to `delivered =
-- true` and read as false delivery evidence in `listDeliveriesByBead` (PR #320 review). Both paths
-- have written this exact, unchanged sentence into `error` since #238, so it is a reliable marker
-- for backfilling them to `false` — new rows never need it, since #320 itself sets `delivered`
-- explicitly at write time.
UPDATE `runs`
SET `delivered` = false
WHERE `status` = 'done'
  AND `error` LIKE '%this run opened no pull request and nothing is left to run.%';