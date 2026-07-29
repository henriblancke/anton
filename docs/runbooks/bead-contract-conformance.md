---
title: "Runbook: bead-contract conformance report"
type: runbook
status: validated
date: 2026-07-29
ticket: anton-odlr
epic: anton-6u6y
---

# Runbook: bead-contract conformance report

## Summary

`anton-j9zs` switches the bead contract from advice to a **hard gate**: approve refuses and a run
parks when the bead has no Acceptance criteria. Flipping that switch on a board that still has
unshaped beads strands real work. This report is how you know before you flip it.

```bash
bun scripts/contract-report.ts                 # every board registered in anton.db
bun scripts/contract-report.ts /path/to/repo   # explicit board(s)
```

**Exit code is the decision.** Non-zero means at least one open bead is missing Acceptance — turning
the gate on today would strand it. Advisory gaps (Goal / Context / Out of scope / Verify) are
reported but never fail the command: they degrade the spec, they do not make the work unrunnable.

## What it judges

The same function the gate will call — `validateBeadContract` in `src/lib/beads/contract.ts`. The
report re-implements nothing, so the two can't drift.

- **Denominator**: beads the contract applies to. `chore` and non-work types are exempt, and a bead
  that never came from a bd read is never faulted, so both are excluded rather than counted as
  passing. A conformance rate over the whole board would be a flattering lie.
- **Statuses**: open, in_progress, blocked, **and deferred**. A snoozed bead is work that comes back
  and hits the gate the day it wakes; closed beads can no longer strand a run.

## Measured baseline

| Date | Judged | Conformant | Blocking | Advisory |
|------|--------|-----------|----------|----------|
| 2026-07-28 (anton-6u6y shaping) | 97 | 84 (87%) | 7 Acceptance | 5 Context, 5 Verify, 3 Out of scope, 2 Goal |
| 2026-07-29 (before anton-odlr) | 110 | 98 (89%) | 2 Acceptance | 7 Context, 5 Verify, 4 Out of scope, 2 Goal |
| 2026-07-29 (after anton-odlr) | 109 | **109 (100%)** | **0** | **0** |

The gap between the two 2026-07-29 rows is 11 beads repaired by authoring the missing sections, plus
`anton-9l5e` closed: it asked for a bd-schema preflight that `anton-x7la` had already shipped in the
very PR whose review filed it (`assertRepoSchemaCurrent`, `src/lib/beads/bd-bin.ts`). Closing it beat
writing a rubric for work already in `main`.

## Repairing a violation

Repair is **authoring**, not generation. The report says which section is missing; it never says what
belongs in it. Do not auto-generate an Acceptance box — a fabricated rubric is worse than an absent
one, because the self-review gate scores the diff against it and would score against the wrong thing.
If a bead can't be shaped because nobody still wants it, close it with a reason. Both outcomes clear
the gate; only one of them lies.

`bd update` has no `--context` flag — `## Context` is a section of the description, so repairing it
means rewriting the description (`bd update <id> --body-file -`). Acceptance is the one genuinely
separate field (`bd update <id> --acceptance`).
