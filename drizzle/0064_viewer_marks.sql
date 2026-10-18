-- The viewer's watermark (anton-z8j4q): one row per viewer per project naming the instant they have
-- read the timeline up to, so the since-you-looked window has a lower bound that survives a reload.
--
-- Purely additive and applies to a populated anton.db: no existing table is touched, and a project
-- with no row simply has no mark yet — which reads as "has never looked", the correct answer for
-- every project that existed before this table did. Deliberately NOT backfilled to `now`: that would
-- silently mark every project's whole history as seen on upgrade, hiding exactly the events the
-- feature exists to surface.
--
-- `viewer_id` carries the literal `default` until accounts exist. A column rather than a single
-- hardcoded row so identity lands as data, not as a schema migration.
--
-- The composite PRIMARY KEY is the uniqueness rule the mark-seen write depends on — it makes the
-- write an upsert (ON CONFLICT on both ids) and a repeated POST idempotent. The monotonic
-- "never moves backwards" guard lives in that upsert's WHERE, not in a CHECK: it compares the
-- incoming value against the stored one, which a column constraint cannot see.
--
-- Reverse:
--   DROP TABLE `viewer_marks`;
CREATE TABLE `viewer_marks` (
	`viewer_id` text NOT NULL,
	`project_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`viewer_id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
