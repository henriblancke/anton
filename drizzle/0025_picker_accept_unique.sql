-- A duplicate accept can only exist where the racing read-then-insert this index replaces already
-- ran, and `picker_verdicts` itself is unreleased — so this collapses branch-local history only,
-- keeping the earliest row of each pick. Without it the constraint below could fail the migration
-- on a developer's own db, which stops the server from starting at all.
DELETE FROM `picker_verdicts`
WHERE `verdict` = 'accepted'
  AND `plan_digest` IS NOT NULL
  AND `rowid` NOT IN (
    SELECT MIN(`rowid`) FROM `picker_verdicts`
    WHERE `verdict` = 'accepted' AND `plan_digest` IS NOT NULL
    GROUP BY `project_id`, `bead_id`, `plan_digest`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `picker_verdicts_accept_unique` ON `picker_verdicts` (`project_id`,`bead_id`,`plan_digest`) WHERE "picker_verdicts"."verdict" = 'accepted';
