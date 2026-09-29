-- The per-ROUND review record (anton-1pjo0): one append-only row per PR-fix round that dispatched
-- claude — the threads GitHub's reviewers left it, who left them, and how anton answered each.
--
-- It exists because the review-fix job already reads these counts and throws them away, and they are
-- only observable while the PR is open: after a merge GitHub reports the end state, and "3 threads
-- from 2 reviewers, 2 fixed and 1 left" cannot be reconstructed from it. Purely additive, and applies
-- to a populated anton.db.
--
-- A row per ROUND, never per JOB: most review-fix jobs are polling ticks that dispatch no claude at
-- all, so a row per job would count the poller. A tick with nothing actionable writes nothing.
--
-- NO BACKFILL, deliberately: a PR that merged before this table existed carries only its end state,
-- and synthesizing rows from that would report every legacy PR as having carried no review threads —
-- the exact wrong number this record exists to stop anyone reporting. A PR with no rows reads as "not
-- measured" and never as a PR nobody reviewed.
--
-- Reverse:
--   DROP TABLE `review_rounds`;
CREATE TABLE `review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`bead_id` text,
	`job_id` text,
	`pr_number` integer NOT NULL,
	`round` integer NOT NULL,
	`threads_seen` integer DEFAULT 0 NOT NULL,
	`threads_unresolved` integer DEFAULT 0 NOT NULL,
	`threads_outdated` integer DEFAULT 0 NOT NULL,
	`threads_actionable` integer DEFAULT 0 NOT NULL,
	`outcomes_fixed` integer DEFAULT 0 NOT NULL,
	`outcomes_left` integer DEFAULT 0 NOT NULL,
	`outcomes_needs_human` integer DEFAULT 0 NOT NULL,
	`by_author_json` text DEFAULT '{}' NOT NULL,
	`pr_state` text,
	`pr_state_at` integer,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_rounds_project_idx` ON `review_rounds` (`project_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `review_rounds_pr_idx` ON `review_rounds` (`project_id`,`pr_number`,`round`);--> statement-breakpoint
CREATE INDEX `review_rounds_bead_idx` ON `review_rounds` (`bead_id`);