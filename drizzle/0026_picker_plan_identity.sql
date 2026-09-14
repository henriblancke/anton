-- A plan's board digest identifies its INPUTS, and inputs repeat: a pass that re-admits a target once
-- its veto expires stamps the very digest the decline was filed against, so the new pick would
-- inherit the old answer. Verdicts name the plan GENERATION instead.
ALTER TABLE `board_picker_plans` ADD `plan_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `board_picker_plans` SET `plan_id` = lower(hex(randomblob(16)));--> statement-breakpoint
DROP INDEX `picker_verdicts_accept_unique`;--> statement-breakpoint
ALTER TABLE `picker_verdicts` RENAME COLUMN `plan_digest` TO `plan_id`;--> statement-breakpoint
-- Verdicts already recorded name a board digest — an identity no plan id will ever mint again, so a
-- stale decline could outlive the plan it answered. Cleared rather than deleted: a plan-less verdict
-- still counts in the track record, it just constrains no future pick, exactly as the index below
-- leaves NULLs unconstrained.
UPDATE `picker_verdicts` SET `plan_id` = NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `picker_verdicts_accept_unique` ON `picker_verdicts` (`project_id`,`bead_id`,`plan_id`) WHERE "picker_verdicts"."verdict" = 'accepted';
