ALTER TABLE `picker_verdicts` ADD `veto_kind` text;--> statement-breakpoint
-- THE INTERPRETATION (anton-gtcd). Every decline recorded before this column existed is classified
-- from what the row already knows, so nothing here is a guess:
--
--   * `action = 'never'`      — the operator was sent at the rule. Disagreement.
--   * `criterion IS NOT NULL` — only a `Never` ever writes a criterion, and a repeat veto KEEPS it
--                               while overwriting `action`. So a row reading `not-now` that carries
--                               a criterion is a `Never` a later `not-now` painted over, and the
--                               disagreement it recorded is recovered here rather than lost.
--   * everything else declined — pacing. `✕ not now` is the only other affordance that declines.
--
-- Accepts keep NULL: a release vetoes nothing, so there is no veto to classify. Where the two clues
-- disagree the row is read as DISAGREEMENT, because that is the reading that cannot invent consent:
-- a decline wrongly filed as pacing would drop out of the record the autonomy floor reads and count
-- as evidence the operator never objected.
--
-- Only rows nobody has classified, so re-applying this file is a no-op: the running code UPGRADES a
-- pacing decline to disagreement in place and leaves `action` reading `not-now`, so an unguarded
-- rerun would retract exactly the judgment that upgrade exists to keep.
UPDATE `picker_verdicts`
SET `veto_kind` = CASE
    WHEN `action` = 'never' OR `criterion` IS NOT NULL THEN 'disagreement'
    ELSE 'pacing'
  END
WHERE `verdict` = 'declined' AND `veto_kind` IS NULL;
