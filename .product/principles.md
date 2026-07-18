# PRINCIPLES

Curated, enforced rules for this project. Read by `/shape` and by every dispatched agent
before it writes code. These start as seeds; recurring learnings in `learnings.md` graduate
into new ones over time. Keep it tight — it is read on every shape and every dispatch, so
bloat is a tax. A stable, invariant principle should graduate into `CLAUDE.md`/`AGENTS.md`.

Entry shape: `- **<imperative rule>.** <why.> Trigger: <when it applies>.`

## Scope
- **Implement only the bead's Acceptance; park drive-by changes.** The diff must match the
  ticket, or the review can't trust it. Trigger: any change outside `## Context`/Acceptance.
- **A `size:L` ticket is a smell — split it.** Large tickets can't be reviewed cleanly and
  don't commit atomically. Trigger: shaping.

## Testing
- **Every bead ships the tests named in its `## Verify`.** No test, no merge. Trigger: always.

## <add your own areas as recurring learnings graduate>
