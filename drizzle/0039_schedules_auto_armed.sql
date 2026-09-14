ALTER TABLE `schedules` ADD `auto_armed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- A row already enabled has already reflected a deliberate choice (its own creation, or an earlier
-- arm) and needs no further migration; carrying that forward as `auto_armed` stops the one-time
-- run-health arm in `backfillDefaultSchedules` from re-firing on a row an operator disables later.
--
-- A row that is currently disabled but has fired before (`last_run_at` is set) proves the SAME
-- thing: `last_run_at` is only ever stamped while a row is `enabled` (the scheduler and "Run now"
-- both refuse a disabled row — see jobs/scheduler.ts and `runScheduleNow`), so a fire on record
-- means an operator enabled it at some point and this row's current `enabled = false` is their own
-- later, deliberate disable — not the untouched legacy default the one-time arm exists to fix.
-- Marking it `auto_armed` here preserves that disable instead of silently overriding it.
--
-- Only a row that is disabled AND has never fired is indistinguishable from the legacy opt-out
-- default, so it alone is left `auto_armed = false` and gets its one-time arm on the next boot, same
-- as before this column existed.
UPDATE `schedules` SET `auto_armed` = (`enabled` = 1 OR `last_run_at` IS NOT NULL);
