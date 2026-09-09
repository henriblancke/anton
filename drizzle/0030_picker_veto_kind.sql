ALTER TABLE `picker_verdicts` ADD `veto_kind` text;--> statement-breakpoint
-- THE INTERPRETATION (anton-gtcd). A decline recorded before this column existed is classified only
-- from what the row can PROVE, and left unclassified where it cannot:
--
--   * `action = 'never'`      — the operator was sent at the rule. Disagreement.
--   * `criterion IS NOT NULL` — only a `Never` ever writes a criterion, and a repeat veto KEEPS it
--                               while overwriting `action`. So a row reading `not-now` that carries
--                               a criterion is a `Never` a later `not-now` painted over, and the
--                               disagreement it recorded is recovered here rather than lost.
--   * everything else declined — left NULL, because the row cannot say. A `not-now` with no
--                               criterion is USUALLY the plain `✕ not now`, but it is also exactly
--                               what a `Never` leaves behind once a later `not-now` overwrites its
--                               action — a `Never` on a project whose policy narrows nothing, or
--                               whose board read failed, records no criterion to recover it from.
--                               Nothing on the row tells those apart, and reading it as pacing would
--                               drop the operator's refusal out of the record the autonomy floor
--                               weighs (PR #245 review).
--
-- Accepts keep NULL: a release vetoes nothing, so there is no veto to classify. An unclassified
-- decline is still COUNTED by `pickerTrackRecord` — only an explicit pacing row is dropped — so the
-- reading here is the one that cannot invent consent: a legacy decline goes on weighing exactly as it
-- did before the column existed, and only a decline the running code files as pacing stops counting.
--
-- Only rows nobody has classified, so re-applying this file is a no-op: the running code UPGRADES a
-- pacing decline to disagreement in place and leaves `action` reading `not-now`, so an unguarded
-- rerun would retract exactly the judgment that upgrade exists to keep.
UPDATE `picker_verdicts`
SET `veto_kind` = 'disagreement'
WHERE `verdict` = 'declined'
  AND `veto_kind` IS NULL
  AND (`action` = 'never' OR `criterion` IS NOT NULL);
