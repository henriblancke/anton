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

The first is a **read** over facts anton already records. The second needs **eight new columns**,
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
- **wall** — start-to-finish including retries. **Not recorded today** — `attemptStartedAt` is
  overwritten on every resume, so prior intervals are already lost (see `timing`).
- **lead** — first invocation → last delivery. Includes overnight quota parks.

A feature parked 14h on a usage limit has ~20min active and ~14h lead. Reporting one number hides
whichever question is being asked. `lead − active` separates working from waiting — the figure that
says whether to buy more quota.

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

Eight columns on `claude_invocations`, written at the **`metered(...)` boundary**
(`src/lib/claude-invocations.ts:244`) — not at `dispatchClaude`. Three are the attribution stamps,
`step_handler` is required by the phase fold for the same reason, and four record **what ran**:

| column | value | rationale |
|---|---|---|
| `prompt_digest` | 12-hex sha256 of the **composed** system prompt (base + agent + seed) | the prompt *is* the behavior of every producer; the composed text is what actually ran |
| `formula_digest` | 12-hex content hash of the cooked formula | `runs.formula` is a path; a pipeline edit must be visible |
| `anton_version` | `identity.mjs` version + git revision | separates "my prompt improved" from "I upgraded anton" |
| `step_handler` | the resolved `stepName(step)` — the handler, not the author's step id | a custom formula's step id matches no phase predicate; the mapping is editable, so it is not reconstructible |
| `agent_tag` | the `agent:<tag>` the ticket resolved to (`steps/agent.ts:31`), null when none | which specialist ran is a per-invocation fact; `runs.agent_tag` is per-RUN and misses a multi-ticket run's mix |
| `skill_id` / `skill_digest` | the `skill:<id>` a `step:claude` resolved, and its content digest | a skill is edited in place and resolves project-local-first; both the identity and the version it ran at are gone by the next edit |
| `prompt_id` | the `prompt:<id>` a `step:claude` resolved, null otherwise | the sibling of `skill_id` — `loadStepReasoning` takes one or the other |

Reuses `skillDigest`'s conventions from `src/lib/claude/skill-stamp.mjs` — same length, same
hashing discipline, already tested.

**Which agent and which skill ran.** Both are resolved at dispatch and both are mutable, so they
fall under the same rule as the prompt digest. `runs.agent_tag` already exists but is the wrong
grain: it is per-RUN, while `agent:` is a per-TICKET label, so a run whose tickets used three
different specialists records one of them. `loadStepReasoning` (`steps/resolve.ts:89`) resolves
`prompt:<id>` XOR `skill:<id>`, and `loadProjectSkill` prefers the project's own copy over the
bundled one — so the same `skill:review` means different text in different repos, and different
text in the same repo a week later. `skill_digest` reuses `skillDigest` again, which makes
"did the new reviewer skill help?" the same cohort question as "did the new prompt help?".

These are cheap: every value is already computed at dispatch, and recording them is passing what
is in hand rather than resolving anything new.

**Why `metered(...)` and not `dispatchClaude` (PR #311 review).** `dispatchClaude` is *a* metered
call site, not *the* metered boundary. There are six, and five bypass it:

| site | phase it produces |
|---|---|
| `jobs/steps/dispatch.ts:82` | the formula walk (`implement`, `describe`, `claude`) |
| `jobs/execute-epic-ticket.ts:169` | ticket retries (`recordsEachAttempt: true` — meters its own attempts) |
| `jobs/review-gate.ts:289` | **self-review** |
| `jobs/review-fix.ts:679` | **PR-fix** |
| `jobs/product-master.ts:176` | overhead |
| `jobs/nightly-stringer.ts:65` | overhead |

Stamping only `dispatchClaude` would leave `prompt_digest` NULL on self-review and PR-fix — two of
the three phases this design exists to attribute — and on every resumed ticket attempt. The stamps
therefore belong on `InvocationDimensions`, resolved inside `metered(...)` so a site that forgets
to pass them still records what can be resolved from process state (`anton_version` always;
`formula_digest` whenever the run is known).

This is the same reasoning `claude-invocations.ts`'s own header gives for the wrapper existing at
all: *"a per-site recording call is one a new dispatch site forgets."* A per-site *stamp* is the
same mistake one level down.

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
  timing:   { activeMs, leadMs }        // wallMs: blocked on a per-attempt record
  friction: Friction
  stamps:   { promptDigests[], formulaDigests[], antonVersions[], models[] }
```

**Phases** derive from `(jobType, handler)`:

| phase | predicate |
|---|---|
| `implement` | `handler ∈ {implement, verify, commit, claude}` |
| `self-review` | `handler = 'review'` |
| `describe` | `handler = 'describe'` |
| `pr-fix` | `jobType ∈ {review-fix, review-fix-pr}`, **or** `step = 'review-fix'` under `execute-epic` |
| `overhead` | `jobType ∈ {gardener, product-master, board-picker, nightly-stringer}` — project-level only (D4) |

**`handler`, not `step` (PR #311 review).** `dispatch.ts:75` records `ctx.step?.id` — the cooked
step's *arbitrary author-chosen id*, not the `step:<name>` label that names its handler. On the
bundled formula the two coincide; on a project formula whose implement step is called
`code-ticket` they do not, and every predicate above would miss. A custom pipeline's whole spend
would land in `unattributed`, which is honest but useless — and D4's discipline says an
unallocated remainder is a last resort, not a design.

So `claude_invocations` gains a fourth recorded dimension alongside D2's three: **`step_handler`**,
the resolved `stepName(step)` value, written where `step` already is. It is the semantic fact; the
step id is the author's label for it. Same argument as the stamps — it is not reconstructible
later, because the formula that defined the mapping is editable.

The `pr-fix` row's second clause covers the in-formula self-review correction dispatch, which
records `step = 'review-fix'` while its `jobType` is still `execute-epic`, and would otherwise be
counted as implement spend.

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

`humanTouches = nonGateEscalations + humanGates + sendBacks + cancels`, where
`nonGateEscalations = escalations − humanGates`.

**`humanGates` is a SUBSET of `escalations`, not a sibling (PR #311 review).** `needs-human` is a
`kind` *within* the escalations table (`run-health.ts:498`), so summing both counted every gate
twice — inflating exactly the features that needed the most attention, and biasing every cohort
comparison toward whichever prompt raised more gates. The two are reported separately because they
mean different things, and summed once.

**`quotaParks` is excluded from `humanTouches` deliberately.** Counting a usage limit as anton
failing would make the metric degrade every time anton is used more — the opposite of what it is
for. It is reported alongside, never inside.

### `timing`

- `activeMs` = `Σ durationMs` over the scope's invocations. Derived; exact.
- `leadMs` = first invocation → last delivery (`listDeliveriesByBead`). Derived; exact.
- `wallMs` = **not derivable from what exists today.** See below.

**`wallMs` needs a per-attempt record (PR #311 review).** `attemptStartedAt` is *overwritten* every
time a resume picks a parked run back up (`execute-epic-start.ts:338`) — the column's own comment
says so, since that is precisely what the repair weigher needs it for. So a settled row carries
only the LAST attempt's start beside a final `endedAt`; every earlier interval is already gone.
`Σ (endedAt − attemptStartedAt)` therefore yields the last attempt's duration while claiming to be
wall time *including retries*, and it understates exactly the runs that struggled most.

Two honest options, and the design takes the first:

1. **Report `activeMs` and `leadMs` now; add `wallMs` when a per-attempt record exists.** Both are
   exact, and `lead − active` still separates "working" from "waiting", which is the question that
   motivated the split. A `run_attempts` row (run id, attempt, started, ended, outcome) is the
   prerequisite, and it is a fact table of the same shape as `claude_invocations` — filed as its
   own bead rather than smuggled into the fold.
2. Report the last attempt's duration and call it `lastAttemptMs`. Rejected: it is a third number
   nobody asked for, and its resemblance to wall time is the trap.

**Nothing derives a number it cannot stand behind** — the same rule as unpriced-is-not-zero. A
missing `wallMs` is a gap; a plausible wrong one is a lie that survives into every cohort.

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

### Cohorts by agent and by skill

The same fold, keyed differently. `promptSeries` groups on a stamp tuple; agent and skill are two
more dimensions of that tuple, so "is `agent:nextjs` worth its cost versus the default?" and "did
the reviewer skill edit help?" are the same query with a different key — not new machinery.

Both carry the same `MIN_COHORT` floor, and one extra caution: **an agent cohort is confounded by
what it was given.** `agent:alembic` rides `risk:high` migration work by convention, so its higher
cost per feature says as much about the tickets as the specialist. The view reports the key and the
n; it does not claim a specialist caused a difference.

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
| A new `metered(...)` call site forgets the stamps | resolved inside the wrapper, not passed per-site; a site that passes nothing still records `anton_version` |
| `wallMs` is wanted before the per-attempt record exists | it is absent rather than approximated; the gap is visible, a wrong number would not be |

---

## Verify

- `featureLedger` over a fixture board returns per-phase totals matching hand-summed rows.
- An unpriced model yields `usd: undefined` and a non-zero `unpricedRows`, never `usd: 0`.
- An empty scope returns `recorded: false`, distinct from a scope totalling zero.
- A quota park increments `quotaParks` and does **not** increment `humanTouches`.
- A digest that throws records null and does not fail the run.
- `promptSeries` suppresses the verdict below `MIN_COHORT` and flags mixed `anton_version` cohorts.
- `activeMs` and `leadMs` are independently correct on a run that parked overnight and resumed, and
  no `wallMs` is reported until a per-attempt record exists.
- A custom formula whose implement step is named something else still folds into `implement`, via
  `step_handler` rather than the step id.
- A feature with one `needs-human` escalation and nothing else reports `humanTouches: 1`, not 2.
- A ticket carrying `agent:nextjs` records that tag on its invocation rows; a run mixing two
  specialists records both, one per invocation, rather than one for the run.
- A `skill:<id>` resolved from the project's own copy records a different `skill_digest` than the
  bundled one of the same name.

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
