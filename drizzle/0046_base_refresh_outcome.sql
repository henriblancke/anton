-- Record what refreshOntoBase (worktree.ts) did to a REUSED checkout before the agent was
-- dispatched (anton-s55u): noop | fast_forwarded | rebased | merged | skipped_dirty, plus the
-- base commit it settled on.
-- Without this, a stale-tree resume left no evidence anywhere queryable — the outcome only ever
-- reached a console.log the job runner doesn't persist.
--
-- Nullable and NOT backfilled: null covers both a freshly-created checkout (nothing to refresh)
-- and a caller that didn't opt into refresh (review-fix's PR branches).
--
-- Reverse:
--   ALTER TABLE `runs` DROP COLUMN `base_refresh_outcome`;
--   ALTER TABLE `runs` DROP COLUMN `base_refresh_sha`;
ALTER TABLE `runs` ADD `base_refresh_outcome` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `base_refresh_sha` text;
