-- THE DECISION LOG (anton-q5ixf): one append-only row per decide() call, plus the operator's own
-- answer to the same question whenever it arrives. Purely additive, and applies to a populated
-- anton.db.
--
-- Shadow mode has no other product: a point in shadow computes the answer auto would have acted on
-- and then acts on nothing, so unless the answer is written down beside what the operator actually
-- did, nothing measures whether the point is trustworthy. `operator_answer`/`operator_action`/
-- `outcome`/`settled_at` are the settle half, filled in LATER (sometimes days later) by the settle
-- API, and NULL on every row until then.
--
-- NO BACKFILL: nothing decided before this table existed, so there is no prior decision to
-- reconstruct. An empty log reads as "not measured", and `agreement` reports zero samples rather
-- than an agreement figure over nothing.
--
-- `project_id` is deliberately NOT a foreign key (like `run_attempts`): the write is best-effort, and
-- a reference the writer cannot satisfy is one more way to reject a row about a decision that really
-- happened.
--
-- Reverse:
--   DROP TABLE `decisions`;
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`point` text NOT NULL,
	`mode` text NOT NULL,
	`decided_by` text NOT NULL,
	`answer` text,
	`confidence` real NOT NULL,
	`distribution` text,
	`backend` text,
	`model_version` text,
	`input_hash` text NOT NULL,
	`acted` integer NOT NULL,
	`reason` text,
	`decided_at` integer DEFAULT (unixepoch()) NOT NULL,
	`operator_answer` text,
	`operator_action` text,
	`outcome` text,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `decisions_point_idx` ON `decisions` (`point`,`decided_at`);