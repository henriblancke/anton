ALTER TABLE `schedules` ADD `auto_armed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- A row already enabled has already reflected a deliberate choice (its own creation, or an earlier
-- arm) and needs no further migration; carrying that forward as `auto_armed` stops the one-time
-- run-health arm in `backfillDefaultSchedules` from re-firing on a row an operator disables later.
-- A row still disabled is exactly the legacy opt-out state that arm exists to fix once, so it is
-- left `auto_armed = false` and gets its one-time arm on the next boot, same as before this column
-- existed.
UPDATE `schedules` SET `auto_armed` = `enabled`;
