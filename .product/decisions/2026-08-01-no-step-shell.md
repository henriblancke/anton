# No `step:shell` in the run pipeline
Date: 2026-08-01
Status: accepted

## Decision

anton's step registry (`src/lib/jobs/step-registry.ts`, anton-4npr) ships **no `step:shell`**, and a
formula that names one is refused by name with a pointer to the two things that replace it: a verify
gate for "run a command", `step:claude` for anything else. This is settled — reopen it only with a
capability neither of those covers.

## Why

**The capability already exists, once.** "Run a command, fail on non-zero" IS the verify gate
(`resolveVerifyGates` → `runVerifyGates`): operator-pinned commands, serialized behind the host
verify-gate lock, output appended to the run's session log. A second arbitrary-command primitive adds
no capability — it adds a second, unlocked, differently-logged way to do the same thing, and the two
drift.

**The trust boundaries are not the same.** Verify-gate commands are project SETTINGS an operator
edits in anton's UI. A formula is git-tracked project data, so `step:shell` would make every branch
that edits `anton-run.formula.toml` a way to run an arbitrary command on the operator's machine —
during an autonomous run, outside the one lock and the one log the gates funnel through. That is a
real widening of the blast radius for zero gain.

**`step:claude` is the extension point.** It reuses `runClaude` wholesale — session recording,
`assertLeaseHeld`, quota backoff/parking, `ANTON-RESULT` parsing — so it adds no failure mode the
runtime doesn't already handle, and an agent can run whatever the project needs under those guards.

## Rejected

- **`step:shell` with an allowlist.** An allowlist is a second policy surface to write, ship, and
  keep in sync with the gates' — for a primitive that duplicates them.
- **Folding verify gates into `step:shell`.** The gates are configured per project in Settings and
  are what the UI, the review-fix job, and the operator already reason about; moving them into
  formula data would move a founder-facing setting into a file most projects never open.
