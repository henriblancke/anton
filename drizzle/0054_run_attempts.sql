-- The per-attempt run record (anton-rnrdr): one append-only row per attempt on a run, so wall time
-- including retries is recoverable. `runs.attempt_started_at` is rewritten by every resume (the
-- repair weigher needs it to mean the CURRENT attempt's start), so the earlier intervals only survive
-- if they are recorded beside it. Purely additive, and applies to a populated anton.db.
--
-- NO BACKFILL, deliberately: a run that already settled carries only its last attempt's start, so
-- there is nothing to reconstruct the earlier intervals from. Rows written before this table existed
-- have no attempts recorded at all, which reads as "not measured" (`attemptWallMs` returns undefined)
-- and never as a run that took no time.
--
-- Reverse:
--   DROP TABLE `run_attempts`;
CREATE TABLE `run_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text,
	`attempt` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_attempts_run_idx` ON `run_attempts` (`run_id`,`attempt`);