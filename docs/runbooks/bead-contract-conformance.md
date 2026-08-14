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

`anton-j9zs` switched the bead contract from advice to a **hard gate**: approve refuses (422) and a
run parks when the bead has no Acceptance criteria. A board carrying unshaped beads therefore has
stranded work on it. This report is how you find it — before the switch, and ever since.

```bash
bun scripts/contract-report.ts                 # every board registered in anton.db
bun scripts/contract-report.ts /path/to/repo   # explicit board(s)
```

**Exit code is the decision.** Non-zero means at least one open bead is missing Acceptance — turning
the gate on today would strand it. Advisory gaps (Goal / Context / Out of scope / Verify) and form
gaps (below) are reported but never fail the command: they degrade the spec, they do not make the
work unrunnable.

## What it judges

The same function the gate will call — `validateBeadContract` in `src/lib/beads/contract.ts`. The
report re-implements nothing, so the two can't drift.

- **Denominator**: beads the contract applies to. `task` / `bug` / `chore` / `feature` are the
  ticket tier (a `chore` under a feature is dispatched by the run like any other ticket, so it owes
  the same Acceptance); `epic` is its own tier. Non-work types (`learning`, `molecule`, …) are
  exempt, and a bead that never came from a bd read is never faulted, so both are excluded rather
  than counted as passing. A conformance rate over the whole board would be a flattering lie.
- **Unfilled prompts**: a section still holding the bead formula's `TODO —` default counts as
  unwritten, not present. The formula ships prompts, not content — a run against a placeholder
  rubric is the false green the gate exists to prevent.
- **Statuses**: open, in_progress, blocked, **and deferred**. A snoozed bead is work that comes back
  and hits the gate the day it wakes; closed beads can no longer strand a run.

## The form rate: a second question over the same beads

`contractFormGaps` (same module) asks what the gate deliberately does not — does the **description
alone** carry every section the bead's tier owes? The gate accepts acceptance from bd's
`acceptance_criteria` field as an equal home and must keep doing so: beads whose rubric lives only
there approve and run today, correctly. That dual home is precisely why producer drift into the
field-only shape went unseen for three weeks — `bd lint` passes either home too, so nothing on the
board ever said the number was moving.

So the report prints both rates over one denominator. The contract rate answers "would the gate
refuse this"; the form rate answers "does the markdown say it". A bead can pass the first and fall
short of the second, and most of this board does. **A form gap is never blocking and never reaches
the exit code** — it is a producer-quality reading, not a run verdict.

**Why this is not an `anton board-check` advisory.** board-check judges tiers (`epic → feature →
ticket`) and prints roughly a dozen advisories on this board. Adding 117 form gaps to that stream
would bury the tier signal the command exists to give. This report already has the rate-plus-detail
shape and an exit code that means one specific thing, so the second rate belongs here.
`bin/anton.test.ts` pins the boundary: board-check's output is identical whether a board's beads
carry their contract in the description or only in bd's field.

## Measured baseline

| Date | Judged | Conformant | Blocking | Advisory | Form |
|------|--------|-----------|----------|----------|------|
| 2026-07-28 (anton-6u6y shaping) | 97 | 84 (87%) | 7 Acceptance | 5 Context, 5 Verify, 3 Out of scope, 2 Goal | not yet judged |
| 2026-07-29 (before anton-odlr) | 110 | 98 (89%) | 2 Acceptance | 7 Context, 5 Verify, 4 Out of scope, 2 Goal | not yet judged |
| 2026-07-29 (after anton-odlr) | 109 | **109 (100%)** | **0** | **0** | not yet judged |
| 2026-08-05 (anton-9dda shaping) | 113 | 108 (96%) | 1 Acceptance | not recorded | 104 board-wide gaps — see below |
| 2026-08-14 (anton-5ltn, first printed) | 138 | 133 (96%) | 1 Acceptance | 15: Goal 4, Out of scope 4, Verify 4, Context 3 | **21 (15%)** — Acceptance 117, Goal 4, Out of scope 4, Verify 4, Context 3 |

The 2026-08-05 form numbers were measured by hand during shaping, before the report could print
them, and over the whole board rather than the run-gated set: **104 live ticket-tier beads carried
no `## Acceptance` heading in the description**, 0 of 57 stringer-filed beads and 18 of 535
board-wide carried the canonical section order. The 2026-08-14 row is the first reading from the
shipped report — same drift, now over the contract rate's own denominator, so it is the number the
next run compares against.

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
