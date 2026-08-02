# Approval stays the `approved` label — it does not become a bd human gate
Date: 2026-08-01
Status: accepted
Ticket: anton-xx59 (spike) · settles the anton-1k8i out-of-scope line that delegated
"replacing the approved label with a human gate" to anton-4lad

## Decision

**Decline.** Founder approval keeps its current shape: the `approved` label written by
`POST /api/projects/[slug]/epics/[epicId]/approve`, with pickup driven by anton-9anc's
`bd ready --type feature --label approved --unassigned` query.

The `approved` label is **kept unchanged** — not a cache of a gate, not dual-written, not
migrated. It stays the single approval fact, and the approve route stays the single approval
action. Nothing in anton-9anc or anton-1k8i changes.

This decline is about **approval only**. anton-4lad ships gates for what they are good at —
`gh:pr`, `gh:run`, `timer` waits — and that work is unaffected.

Raw transcripts: [`docs/spikes/2026-08-01-approval-as-human-gate.md`](../../docs/spikes/2026-08-01-approval-as-human-gate.md).
Every claim below names the command that proves it.

## What the spike found in favour of adopting

Stated first, because it is real and it is the reason the option was shaped at all.

A human gate **does** keep a feature out of `bd ready` until resolved (`bd gate create
--type=human --blocks <f>` → `bd ready` omits it; `bd blocked` names the gate), and the exclusion
is **transitive to the feature's children** — after `bd gate resolve`, the child task appears in
`bd ready` while its parent is still open. That is the one capability the label model lacks, and
it is exactly pztl's revisit trigger 3: only approval-as-gate could make `bd ready` the single
pickup authority for a worker that does not know anton's label convention.

The composition question also came back clean: gate and label AND together. Resolving the gate on
an *unapproved* feature puts it in bare `bd ready` but **not** in
`bd ready --type feature --label approved --unassigned`. Neither dimension subsumes the other, so
anton-9anc's query needs no redesign under either outcome.

And `bd gate check` never enumerates human gates (`Checked 0 gates` with two open ones), so
anton-4lad's "human gates never auto-close" AC is satisfied by bd itself rather than by anton
convention.

## Why we decline anyway

### 1. Gate-only approval fails open; the label fails closed

A freshly shaped feature that nobody gated is claimable the moment it exists —
`bd ready --type feature --unassigned` lists it, while
`bd ready --type feature --label approved --unassigned` does not. Under gates, **a missing gate
reads as approved**.

Approval is the founder's sovereignty control point. A control point must fail closed. Restoring
that property would mean gating every feature at shape time *plus* a sweep that gates any ungated
one — new machinery to buy back something the label's absence gives for free.

### 2. A divergent gate resolve wedges Dolt sync board-wide; a divergent label add does not

Two clones, each writing without pulling, then pulling — the anton topology (founder's laptop +
a server instance, one `refs/dolt/data`):

| write | divergent outcome | reps |
| --- | --- | --- |
| `bd gate resolve <g>` | `merge conflicts in issues require operator resolution; merge aborted` | 3/3 |
| `bd update <f> --add-label approved` (same label both sides) | `Pull complete.` | 1/1 |

This is pztl §2's fatal failure mode: the pull aborts entirely and the board stops syncing until an
operator intervenes. Approval is the *most* likely write to happen on two machines at once, so it
is the worst candidate to move onto a status cell.

Honest accounting: today's approve already holds one wedge-capable write — the `bd assign` in its
CAS wedges on divergence even when both sides write the **same** assignee. Adopting gates would
make it two, and would put the second one on approval semantics itself. `bd dolt pull` before
resolving is a sufficient mitigation (verified: pull → see `closed` → re-resolve → clean pull) —
but a founder typing `bd gate resolve` at a terminal does not pull first, and that CLI path is the
entire UX case for adopting.

### 3. `bd gate create` is not idempotent — approving twice creates two gates

Two creates on one feature yield two gates; resolving one leaves the feature blocked by the other,
and across clones the two creates merge clean into a silent double-gate needing two resolves.
`bd update --add-label approved` is idempotent by construction. anton's approve route is
re-entrant by design (Force run, re-approve after a failed enqueue, take-over) — it would need a
resolve-existing-before-create wrapper to stay safe.

### 4. anton's board cannot read gates today, and misreads resolved ones as open blockers

Gate beads are absent from anton's whole-board read (`bd list --json --limit 0 --status all`,
`bd.ts:824`) while their `blocks` edges are present on the gated bead. `computeEpicGraph` drops
those edges (no unit ancestor), `epicStandaloneBlockers` recovers them and fails safe on an
unknown blocker (`epic-graph.ts:251`) — so **every gate reads as open forever, resolved or not**.

Proven by running anton's own rollup over a real gated board: `xx59-0t6.3`, whose six gates are all
closed and which `bd ready` lists as ready, comes back `blockedBy` all six. Consequence today, with
no migration: putting a human gate on a feature **permanently 409s its approve route**
(`Epic is blocked by …`), including after `bd gate resolve`. That is a live defect in anton-ve2r's
territory and a hard prerequisite for any adopt.

Resolved gates also accumulate `blocks` edges on the bead permanently — one per approval, visible
forever in `bd show`'s DEPENDS ON.

### 5. The founder-facing UX gain is zero, because approval is the run trigger

`bd gate resolve <id>` is one write. The approve route is a **run trigger** that runs seven gates
before it writes anything — run-target validity, the bead contract over the whole dispatch set,
open blockers, ownership/steal, stage, the claim CAS — and then enqueues `execute-epic` and answers
with `jobId` plus advisory contract gaps.

A founder resolving a gate from the CLI gets a claimable bead and **no run on any instance**:
`bd gate check` skips human gates entirely, so nothing observes the resolution. Preserving today's
behaviour means keeping the route and having it resolve a gate instead of adding a label — the same
UI, the same code, plus a gate lifecycle to own. The gate buys board-native visibility of the wait;
it buys no UX the route does not already provide, and it removes none.

## What happens to the `approved` label

**Kept, unchanged, as the sole approval fact.** No cache, no dual-write, no migration window.
`beads.approve` / `beads.isApproved` (`bd.ts:1122-1123`) and the claimable-set query stay exactly
as anton-9anc specifies.

## Rejected alternatives

- **Gate replaces the label.** Rejected on §1–§5 above; §1 (fail-open) and §4 (resolved gates read
  as permanent blockers) are each disqualifying on their own.
- **Dual-write: gate for `bd ready` truth, label as a cache.** Rejected — it pays every cost in
  §2–§4 *and* keeps the label, then adds a reconciliation problem (a resolved gate whose label was
  never written, or the reverse) that nothing on the board can detect.
- **Gate in addition, for visibility only (no readiness role).** Rejected — §4 means an extra gate
  is not inert today: it 409s the approve route permanently. Even after ve2r, it would be a second
  wedge-capable write bought purely for a badge.

## Revisit when all of these hold

1. **anton-ve2r has landed** and a resolved gate no longer reads as an open blocker — i.e. anton
   reads gate status via `bd list --status all --type gate` (or bd surfaces gate beads in the
   default list) instead of failing safe on an id it cannot see.
2. **`bd gate create` is idempotent** per (blocked bead, type) — or anton owns a
   resolve-existing-then-create wrapper that makes it so.
3. **Divergent resolves stop wedging Dolt** — pztl's trigger 2, unchanged: either bd auto-resolves
   `issues` cell conflicts or every approval write is serialized through one machine.
4. **A worker genuinely cannot be taught the label flag** — approval must be honoured by a consumer
   that speaks only bare `bd ready`. Until then the single-authority payoff is one CLI flag
   (`--label approved`), which anton-9anc already ships.

If they do all hold, the migration is small and the shape is known: `beads.approve` becomes
resolve-existing-gate-or-create-none, shaping creates a `human` gate on every new feature (the
fail-closed default from §1), the approve route resolves that gate under the same claim lock it
holds today and keeps every gate and the enqueue, and the claimable query drops `--label approved`.
Existing approved features need a one-time pass that creates no gate (already approved ⇒ already
resolved) and existing unapproved ones need a gate created. Re-run
`docs/spikes/2026-08-01-approval-as-human-gate.md`'s harness first — it is the acceptance test.
