---
title: "ADR-0001: Every feature is instrumented into the delivery ledger"
status: accepted
date: 2026-09-20
deciders: henri
supersedes: none
---

# ADR-0001 — Every feature is instrumented into the delivery ledger

## Status

**Accepted** — 2026-09-20.

## Context

anton exists to deliver work unattended. Whether it is *worth* running — in one project or across
several, before a prompt change or after — is a question about cost, duration, friction, and
outcome, over time.

That question can only be answered from facts recorded **at the moment work happened**. Almost
none of it is reconstructible later:

- The prompt that shaped a run is gone the moment the file is edited.
- A formula is a path; its content changes under the same path.
- A bead is relabelled, reparented, or closed.
- Settings, model routes, and gateway endpoints are all mutable.

`claude_invocations` already encodes this discipline, and its header states the rule plainly: it is
a fact table whose dimensions "are only true at the moment the invocation ran and are gone by the
time anyone asks."

The failure mode this ADR exists to prevent is **silent, gradual blindness**. No single feature
skipping instrumentation is visible. The damage appears months later, as a trend line with a gap in
it, or a cohort comparison that cannot be made — at which point the data is unrecoverable. A
telemetry system with holes is worse than none, because it still produces confident numbers.

See `docs/plans/2026-09-20-003-feat-delivery-telemetry-design.md` for the ledger design this
enforces.

## Decision

**Every new feature that spends tokens, takes time, fails, or requires a human is instrumented
into the delivery ledger as part of the feature — not as follow-up work.**

Concretely:

1. **Every Claude dispatch goes through the metered path.** New dispatch sites use
   `dispatchClaude` (`src/lib/jobs/steps/dispatch.ts`) or wrap their driver in `metered(...)`
   (`src/lib/claude-invocations.ts`). A new dispatch site that writes no ledger row is a defect,
   not an omission.

2. **Every new dimension worth asking about later is a column, written at the time.** If a reader
   in three months would want to group by it, and it cannot be reconstructed from what is already
   stored, it is recorded now. Derivable facts are derived — this is not licence to widen the
   table for things a join already answers.

3. **Every new job type, pipeline step, and pass declares its phase.** The phase mapping in the
   ledger fold is exhaustive: a `(jobType, step)` pair matching no phase must fail a test, not
   fall into an `unattributed` bucket that nobody reads. New work is classified when it is
   written, by the person who knows what it is.

4. **Every new failure, park, or human-intervention path is classified.** A new way for work to
   stop is a new row in the friction taxonomy, explicitly marked as anton failing or not. An
   unclassified stop is invisible in exactly the metric built to catch it.

5. **Recording never fails the work.** This is the existing `claude_invocations` rule and it is
   not relaxed: unknown values record as null, a write that throws is swallowed. A run that did
   the work must not fail because a meter could not be written. Instrumentation that can break
   delivery will be removed, and rightly.

6. **A feature that deliberately records nothing says so, in writing.** Instrumentation may be
   skipped — some work genuinely has nothing to meter — but the bead's `## Out of scope` states
   it and why. Silence is not a decision.

### Scope

This binds work that consumes Claude, occupies the queue, or requires a human. It does not bind
pure refactors, documentation, or UI that reads existing data.

## Consequences

### Positive

- The over-time series stays complete. Cohort comparisons remain possible because every cohort has
  data on both sides of the change.
- Attribution of prompt, formula, and runtime changes stays honest — the thing anton is *for* is
  measurable as it evolves.
- New job types and steps are classified by whoever understands them, not guessed at later.
- The cost of instrumentation is paid once per feature, when context is fresh, instead of as an
  archaeology project.

### Negative

- Every qualifying feature carries instrumentation work. This is a real, recurring tax.
- The phase mapping's exhaustiveness check means adding a job type touches the ledger module. This
  is intentional friction — it is the mechanism that makes the rule hold rather than decay.
- Some recorded dimensions will never be queried. Accepted: the asymmetry is total, since a column
  not written is unrecoverable and a column not read costs bytes.

### Enforcement

Reviewable, not aspirational. A feature under this ADR is incomplete without:

- a ledger row for every dispatch it adds (test: the dispatch path is metered);
- a phase for every `(jobType, step)` it introduces (test: exhaustiveness fails on an unmapped pair);
- a friction classification for every new stop path (test: the stop increments the intended counter
  and no other);
- or an explicit `## Out of scope` note saying none of the above applies, and why.

The `/shape` skill surfaces this ADR when shaping work that spends tokens, so the instrumentation
tickets are written onto the board with the feature rather than remembered afterwards.

## Alternatives considered

**Instrument retroactively, when a question comes up.** Rejected: the dimensions are gone by then.
This is precisely the failure the ledger was built to end, and adopting it as policy would
guarantee it.

**Instrument only features that look expensive.** Rejected: "expensive" is a judgment made before
the data exists, and the cheap-looking scheduled passes are exactly where unattributed spend has
been accumulating.

**A generic event bus every feature emits to.** Rejected under *lean or dead*: a typed fact table
with real columns is queryable, index-able, and fails loudly on a missing dimension. A bag of JSON
events defers every schema decision to read time, which is when it is most expensive to get wrong.
