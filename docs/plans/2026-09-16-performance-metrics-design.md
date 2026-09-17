# Performance metrics over time — design

**Date:** 2026-09-16
**Status:** design, pending approval
**Mockups:** `docs/design/2026-09-16-perf-metrics-a-timeline.html`, `docs/design/2026-09-16-perf-metrics-b-cohorts.html`

## Goal

Learn which configurations, models, and prompt changes move which metrics — token use, cost,
execution time, failure rate, review score — per project, over time.

The decision this must drive, layered:

1. **Monitor** — surface that something changed.
2. **Attribute** — explain which dimension owns the change.
3. **Experiment** — validate that a deliberate change helped.

## What already exists

`claude_invocations` (`src/lib/db/schema.ts:786`) is already a proper fact table at
(invocation, model) grain, append-only, never revised. It carries:

- **Dimensions:** `projectId`, `jobType`, `step`, `runId`, `beadId`, `modelRequested`,
  `modelReported`, `endpointHost`, `claudeSessionId`
- **Measures:** input/output/thinking/cacheRead/cacheCreation tokens, `webSearchRequests`,
  `numTurns`, `costUsd`, `durationMs`, `durationApiMs`, `outcome`

`runs` carries `model`, `agentTag`, `formula`, `formulaVariant`, `reviewScore`, `attempts`,
`startedAt`/`endedAt`. `burn_samples` carries quota deltas per job type.

Today's board holds **1,085 invocations across 7 distinct reported models**, with a ~60×
per-invocation token spread between the cheapest and most expensive step/model pair. The raw
material for this analysis is already on disk.

`/spend` (`src/app/projects/[slug]/spend/page.tsx`) folds one window by model and by task. It
answers *what did I spend*. It cannot answer *what should I change*.

## The four gaps

| # | Gap | Consequence |
|---|-----|-------------|
| 1 | **No config-version dimension** | `settings_json` is overwritten in place and skills are edited on disk. By the time you ask "did my prompt edit help", the config that produced the old rows is gone. Unanswerable, permanently. |
| 2 | **Quality is not joined to cost** | `reviewScore` is on `runs`; tokens are on `claude_invocations`. **108 runs carry a review score; only 2 also carry a model.** The cost-vs-quality join is broken today. |
| 3 | **No time axis** | `/spend` is a single window folded two ways. No trend, no before/after. |
| 4 | **No cohort comparison** | Nothing answers "config A vs config B on comparable work". |

## Decisions

### D1 — Config capture: fingerprint + snapshot table

On each invocation, hash the **resolved** config that governed it into a short
`config_fingerprint`. The first time a fingerprint is seen, write the full resolved config to a
`config_snapshots` table.

```
claude_invocations
  + config_fingerprint  TEXT        -- "a3f9c1", nullable on pre-existing rows

config_snapshots
    fingerprint    TEXT PK          -- content hash of the resolved config
    project_id     TEXT
    resolved_json  TEXT             -- model, prompts, review settings, formula
    skill_digests  TEXT             -- {review: "16ad2066…", review-fix: "9c02fe41…"}
    first_seen_at / last_seen_at
```

Rationale:

- **Reuses `skillDigest`** (`src/lib/claude/skill-stamp.mjs`), which already content-hashes every
  bundled skill directory for the pristine-check. On-disk prompt edits are captured for free.
- **Cost is bounded:** one hash per invocation, one row per *distinct* config — not per write.
- **Gives both halves:** an opaque cohort key for grouping, and a readable diff between any two
  versions for the "what actually changed" panel.
- Captures **unplanned** changes, which is where most surprises come from. An explicit
  experiment-tagging scheme would miss exactly those.

Follows the existing fact-table contract: `config_fingerprint` is a dimension true only at the
moment the invocation ran, so it is recorded rather than derived, never backfilled, and nullable
on rows written before the column existed.

**Also fix gap 2:** stamp `runs.model` reliably so the review-score join works. It is null on 106
of 108 scored runs today.

### D2 — Comparison: normalize, and surface the caveat

Cohorts run different tickets. If B is cheaper it may be the model — or B's tickets were smaller.
So:

- Compare **per-unit rates** (tokens/run, $/run, duration/run, review rounds/run), never totals.
- Show each cohort's **composition** beside the numbers: n, size-label mix, risk mix, step mix.
- Render an explicit warning when composition diverges, naming which direction it biases the gap.
- The written read must **name its own weakness** rather than leaving the user to infer it.

A cohort board only earns trust if it can say "don't trust this."

## Surfaces

### Variant A — metric-first timeline (`…-a-timeline.html`)

Five metrics stacked on one shared x-axis: tokens/run, cost/run, duration/run, failure rate,
review score. Config changes render as markers on an annotation rail aligned to the same scale,
with a vertical rule through every plot.

The point: **a change's tradeoff is visible in one pass.** In the mock, the 09-09 model swap cut
tokens/run by a third while the failure rate climbed — two rows apart, same vertical line. No
single-metric chart shows that pairing.

Shared crosshair across all rows, keyboard-steppable, table-view twin.

### Variant B — cohort comparison board (`…-b-cohorts.html`)

Pick two fingerprints. Config diff on top (what actually changed, resolved — not just
`settings.json`), per-unit rate deltas below, composition warning underneath, written read last.

The composition block is the load-bearing part.

### Deferred — pivot explorer

The attribution layer (rows × columns × measure over the existing dimensions) is real but can be
built after A and B; both of those need the same rollup it would sit on.

## Visual conventions

Both mockups use Anton's Atelier tokens (`src/app/globals.css`) and follow `docs/ui-brief.md`.
Chart palette validated with the dataviz skill's checker:

- Light: `#6355e0` / `#eb6834` — all checks pass (orange carries a contrast WARN, so every bar is
  directly labeled and a table view ships).
- Dark: `#7a6ce8` / `#d95926` — all checks pass. Anton's dark primary `#8f82ff` **fails** the
  lightness band as a chart series (L 0.676 > 0.67), so the chart series uses the darker step
  while the UI accent stays `#8f82ff`.

One filter row above everything it scopes; no dual axes; recessive hairline grid; every chart has
a table-view twin. Verified rendering in light, dark, and at 390px with no console errors and no
horizontal overflow.

## Build order

1. **`config_fingerprint` + `config_snapshots`** — nothing else works without it, and every day
   it is not shipped is a day of rows that can never be attributed. Includes the `runs.model` fix.
2. **Rollup read** — per-project, per-day, per-config rates. One query, both surfaces.
3. **Variant A** — monitoring + the annotation rail.
4. **Variant B** — cohort comparison on top of the same rollup.
5. *(deferred)* pivot explorer.

Step 1 is time-sensitive in a way the others are not: it is the only step whose delay destroys
data permanently.

## Recommended agents

| Phase | Agent | Responsibility |
|-------|-------|----------------|
| 1 | `@nextjs` (or `@fastapi`-style backend pass) | Drizzle schema + migration, fingerprint computation, recording seam in `metered()` |
| 2 | `@nextjs` | Rollup read module beside `claude-invocations.ts` |
| 3–4 | `@nextjs` | Server Components + chart surfaces, matching `docs/ui-brief.md` |

### Agent chain

`schema/migration → rollup read → nextjs surfaces`

Anton's own board routes by `agent:` label; file these as beads with `agent:nextjs` unless the
migration warrants `agent:alembic`-equivalent handling (it does not — this is Drizzle/SQLite).

## Out of scope

- Pivot explorer (deferred, see above).
- Statistical significance testing. n is small; the composition warning plus stated n is the
  honest treatment, and a p-value here would imply rigor the sample does not support.
- Cross-project comparison. Projects differ too much for the rates to mean the same thing.
- Backfilling `config_fingerprint` onto existing rows. The config that produced them is gone;
  inventing one would poison exactly the comparison this feature exists to make.
