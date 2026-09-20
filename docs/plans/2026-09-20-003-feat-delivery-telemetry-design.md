---
title: "feat: Delivery telemetry — what a feature cost, and whether anton is getting better"
type: feat
status: draft
date: 2026-09-20
origin: brainstorming session (planning:brainstorming), 2026-09-20
---

# feat: Delivery telemetry — what a feature cost, and whether anton is getting better

## Summary

Two questions anton cannot currently answer:

1. **"What did this feature cost me?"** — tokens, dollars, duration, failures, split across
   implement / self-review / PR-fix.
2. **"Did my prompt change make anton better or worse?"** — the same figures, grouped by the
   prompt and formula that produced them, tracked across months and across projects.

The first is a **read** over facts anton already records. The second needs **three new columns**,
and is the half that loses data every day it is not shipped: what prompt text ran is gone the
moment the file is edited.

Everything else here is a fold. No new tables, no new write paths beyond the stamps, no backfill.

---

## Problem Frame

### What already exists

`claude_invocations` (`src/lib/db/schema.ts:793`) is already a well-built fact table — one row per
`(invocation, model)`, append-only, written from the result event with the dimensions as they stood
at that moment:

| carried today | columns |
|---|---|
| dimensions | `projectId`, `jobType`, `jobId`, `step`, `runId`, **`beadId`**, `claudeSessionId`, `modelRequested`, `modelReported`, `endpointHost` |
| measures | `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `numTurns`, `durationMs`, `durationApiMs`, `outcome` |

Around it:

| capability | where |
|---|---|
| USD derived from token counts against anton's own price table | `src/lib/model-pricing.ts` |
| fold by model and by task, windowed | `src/lib/spend-breakdown.ts` |
| the rendered Spend page | `src/app/projects/[slug]/spend/page.tsx` |
| requested-vs-served model divergence | `src/lib/model-divergence.ts` |
| per-run model, formula, review score, attempts, three timestamps | `runs` table |
| per-job quota burn samples | `burn_samples` table |
| review rounds + per-round verdicts, persisted as bead comments | `src/lib/jobs/review-score.ts` |
| escalations, resolutions, dismissals | `escalations` table |
| content-digest primitive (12-hex, tested) | `src/lib/claude/skill-stamp.mjs` → `skillDigest` |
| runtime version + git revision | `src/lib/build/identity.mjs` |

**"Self-review runs" and "PR review fix runs" are therefore already separable** — they are
`step = 'review'` and `jobType ∈ {review-fix, review-fix-pr}` on rows anton writes today. Nothing
new needs collecting for the per-phase token, cost, duration, and model figures.

### The three real gaps

**Gap 1 — No attribution stamp. Cannot be backfilled.**

Nothing records *which prompt, which formula, which anton* produced an invocation. `runs.formula`
is a filesystem **path**, not content — a tuned pipeline is invisible in it. Without a stamp you can
observe that cost changed after a prompt edit and never attribute it. This is the only part of the
design that destroys data by being deferred.

**Gap 2 — "Duration" is three numbers that diverge wildly.**

- **active** — `Σ durationMs`. What Claude actually worked.
- **wall** — `Σ (run.endedAt − run.attemptStartedAt)`. Includes retries.
- **lead** — first invocation → last delivery. Includes overnight quota parks.

A feature parked 14h on a usage limit has ~20min active and ~14h lead. Reporting one number hides
whichever question is being asked. `lead − wall` is queue/park time — the figure that says whether
to buy more quota.

**Gap 3 — "Failures" is six things with opposite meanings.**

| event | source | is it anton failing? |
|---|---|---|
| invocation error | `claude_invocations.outcome = 'error'` | yes |
| run failed | `runs.status = 'failed'` | yes |
| job parked (non-quota) | `jobs.status = 'parked'` | yes |
| **job parked on quota** | `jobs.status = 'parked'`, quota reason | **no** |
| operator cancel | `jobs.status = 'cancelled'` | no |
| review round rejected | `ReviewScoreEntry` verdict | **no — the system working** |

Collapsing these into one counter makes the metric worse the more anton is used, because quota
parks scale with usage.

### What is NOT built

- No per-feature rollup: `beadId` is on every row, but nothing folds by it or walks bd parentage.
- No cost-per-*delivered*-feature: abandoned runs' spend has no denominator, so
  cheap-because-it-gave-up reads as efficient.
- No cross-machine aggregation. `anton.db` is machine-local SQLite; beads syncs via Dolt, this
  ledger does not. **Explicitly out of scope** (see Non-goals).

---

## Decisions

Four decisions taken in the brainstorming session, with what each one costs.

### D1 — Rollup is derived at read time, not frozen

Fold `claude_invocations` by `beadId`, walking parentage from the bd board snapshot the page
already loads. No new tables, no backfill, no drift — the view always matches the board as it
stands today.

**Accepted cost:** a reparented bead retroactively moves its spend, and a purged bead orphans its
rows. Acceptable because the board is the source of truth for structure, and a frozen copy that
disagreed with it would be worse than one that moves.

**Consequence:** the over-time series is rebuilt on every read rather than accumulated. If read
cost becomes a problem at volume, a materialized `deliveries` row on settle is the escape hatch —
but it is not built now, and the stamps in D2 are what make it possible later.

### D2 — Attribution stamps are written, not derived

Three columns on `claude_invocations`, written at `dispatchClaude`'s existing `dimensions`
assembly (`src/lib/jobs/steps/dispatch.ts:71`), so every step gets them without remembering to:

| column | value | rationale |
|---|---|---|
| `prompt_digest` | 12-hex sha256 of the **composed** system prompt (base + agent + seed) | the prompt *is* the behavior of every producer; the composed text is what actually ran |
| `formula_digest` | 12-hex content hash of the cooked formula | `runs.formula` is a path; a pipeline edit must be visible |
| `anton_version` | `identity.mjs` version + git revision | separates "my prompt improved" from "I upgraded anton" |

Reuses `skillDigest`'s conventions from `src/lib/claude/skill-stamp.mjs` — same length, same
hashing discipline, already tested.

**This is the only new write path in the design.** It follows `claude_invocations`' existing rule:
**recording never fails a run.** A digest that cannot be computed is recorded as null, and a throw
is swallowed. A run that did the work must not fail because a meter could not be written.

### D3 — Effectiveness is measured from observed signals only

No rating input, no human-equivalent estimate. Everything is counted from tables anton already
writes, so the series cannot rot from neglect.

**Accepted cost:** these are a *proxy* for quality, not a measure of it. `reviewRounds > 1` is the
best cheap signal available, and it is still only a signal. No surface may present these as a
quality score.

**Consequence:** a later one-tap verdict field would make every other metric correlatable
("cheap runs I rated badly" is the finding that changes a prompt). Deferred, not rejected.

### D4 — Overhead is attributed to the project, never divided into features

Scheduled passes (`gardener`, `product-master`, `board-picker`, `nightly-stringer`) spend real
money serving the whole board. Splitting that across features would be a fabricated number.

Reported as a project-level line, visible and unallocated — the same discipline as
`spend-breakdown`'s unpriced-model rule: **showing an unallocated remainder beats silently
dropping it, and beats inventing a split.**

---

## Design

### The read: `featureLedger(projectId, beadId)`

```
featureLedger(project, beadId) →
  scope:    { beadId, childIds[], title, status, recorded: boolean }
  phases:   Map<Phase, PhaseTotals>
  totals:   PhaseTotals
  timing:   { activeMs, wallMs, leadMs }
  friction: Friction
  stamps:   { promptDigests[], formulaDigests[], antonVersions[], models[] }
```

**Phases** derive from `(jobType, step)` already recorded — no new dimension:

| phase | predicate |
|---|---|
| `implement` | `step ∈ {implement, verify, commit, claude}` |
| `self-review` | `step = 'review'` |
| `describe` | `step = 'describe'` |
| `pr-fix` | `jobType ∈ {review-fix, review-fix-pr}` |
| `overhead` | `jobType ∈ {gardener, product-master, board-picker, nightly-stringer}` — project-level only (D4) |

`PhaseTotals`: `runs`, `tokens{in, out, thinking, cacheRead, cacheWrite}`, `usd`, `unpricedRows`,
`activeMs`, `apiMs`, `turns`, `errors`.

### Three rules that keep the numbers honest

Two inherited verbatim from `spend-breakdown.ts`, one new. All three are about not lying with a
number:

1. **Unpriced is tokens-only, never free.** A model anton has no price for reports its tokens and
   `usd: undefined`. Folding it in as 0 understates the total with no sign anything is missing.
2. **Nothing recorded is empty, not zero.** An empty scope returns `recorded: false` and no
   phases. "We measured nothing" and "we measured zero" are opposite facts.
3. **Cost is never split proportionally.** *(new)* Spend that cannot be attributed to a phase
   lands in an `unattributed` bucket. A split number looks precise and is not.

### `friction` — the effectiveness half

| field | source |
|---|---|
| `reviewRounds` | `ReviewScoreEntry[]` on the bead's thread — rounds to a clean verdict |
| `prFixRounds` | count of `review-fix*` jobs for the bead |
| `escalations` | `escalations` rows by `beadId` |
| `humanGates` | `kind = 'needs-human'` escalations |
| `sendBacks` | rework writes (stage-label strip, `rework-pipeline.ts`) |
| `cancels` | `jobs.status = 'cancelled'` |
| `quotaParks` | `jobs.status = 'parked'` with a quota reason |

`humanTouches = escalations + humanGates + sendBacks + cancels`.

**`quotaParks` is excluded from `humanTouches` deliberately.** Counting a usage limit as anton
failing would make the metric degrade every time anton is used more — the opposite of what it is
for. It is reported alongside, never inside.

### `timing`

All three durations from Gap 2, all derived from existing columns:

- `activeMs` = `Σ durationMs` over the scope's invocations
- `wallMs` = `Σ (endedAt − attemptStartedAt)` per run, falling back to `startedAt` on rows written
  before `attemptStartedAt` existed
- `leadMs` = first invocation → last delivery (`listDeliveriesByBead`)

### The attribution read: `promptSeries(projectId, window)`

What D2's stamps buy. Groups **delivered** features by their stamp tuple:

```
prompt_digest  a3f1…   n=11   Aug 2 – Sep 4
  $/feature 4.12    review rounds 2.4    touches 1.8    escalations 0.4

prompt_digest  9c2e…   n=7    Sep 4 – now
  $/feature 3.06 ↓  review rounds 1.6 ↓  touches 0.9 ↓  escalations 0.1 ↓
```

Two guardrails, because this is where a metrics surface most easily lies:

1. **A cohort under `MIN_COHORT` (5) features reports `n` and no verdict.** No arrow, no delta.
   At realistic volume most comparisons are underpowered, and an arrow drawn on n=2 is worse than
   no arrow at all.
2. **A cohort spanning mixed `anton_version`s says so, in the cohort header.** Otherwise a runtime
   change gets credited to a prompt edit.

### The denominator

**Cost per *delivered* feature**, where abandoned and failed runs' spend stays in the numerator.
Anything else lets cheap-because-it-gave-up read as efficient — which would make the metric
actively recommend the wrong prompt.

---

## Non-goals

- **Cross-machine aggregation.** `anton.db` is machine-local by design, like `burn_samples`. A
  multi-machine roll-up needs a sync story this feature does not have and does not invent.
- **A rating input, or a human-equivalent-hours estimate.** D3. Deferred, not rejected.
- **A frozen `deliveries` fact table.** D1. The stamps make it possible later; it is not built now.
- **Splitting scheduled-pass overhead across features.** D4.
- **Presenting friction signals as a quality score.** They are proxies and must be labeled as such.
- **Re-deriving cost from the vendor's `cost_usd`.** `model-pricing.ts` owns this and its header
  explains why; this feature does not revisit it.

---

## Risks

| risk | mitigation |
|---|---|
| Read-time fold gets slow as `claude_invocations` grows | existing `claude_invocations_project_idx` covers the windowed project read; a `bead_id` index is added with the feature |
| Reparenting silently rewrites history | accepted in D1; the view is labeled as reflecting the board *as it stands now* |
| Stamp columns tempt a "recording must succeed" change | the never-fail-a-run rule is restated in the column comments, as `claude_invocations` already does |
| Underpowered cohorts produce confident-looking noise | `MIN_COHORT` guardrail; no verdict under it |
| Friction proxies get read as quality | surfaces label them as signals, never as a score |

---

## Verify

- `featureLedger` over a fixture board returns per-phase totals matching hand-summed rows.
- An unpriced model yields `usd: undefined` and a non-zero `unpricedRows`, never `usd: 0`.
- An empty scope returns `recorded: false`, distinct from a scope totalling zero.
- A quota park increments `quotaParks` and does **not** increment `humanTouches`.
- A digest that throws records null and does not fail the run.
- `promptSeries` suppresses the verdict below `MIN_COHORT` and flags mixed `anton_version` cohorts.
- Three timings are independently correct on a run that parked overnight and resumed.

---

## Recommended Agents

| Phase | Agent | Responsibility |
|-------|-------|---------------|
| 1 | `@nextjs` | stamp columns + migration, `dispatchClaude` wiring |
| 2 | `@nextjs` | `feature-ledger.ts` pure fold + tests |
| 3 | `@nextjs` | `prompt-series.ts` + cohort guardrails |
| 4 | `@nextjs` | UI surfaces (feature ledger panel, trend view) |

### Agent Chain

nextjs (stamps) → nextjs (fold) → nextjs (series) → nextjs (UI)

Single-agent chain: this is one Next.js app with a Drizzle/SQLite data layer, and every phase is
TypeScript in the same module graph. The phases are sequenced by data dependency, not by
specialism — phase 1 must land first because its data cannot be backfilled.
