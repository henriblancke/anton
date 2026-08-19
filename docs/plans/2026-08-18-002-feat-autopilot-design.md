---
title: "feat: Autopilot — anton starts work from the board on a standing approval"
type: feat
status: active
date: 2026-08-18
origin: brainstorming session (planning:brainstorming), 2026-08-18
---

# feat: Autopilot — anton starts work from the board on a standing approval

## Summary

Give anton the one loop it is missing: a cheap, deterministic pass that reads a project's board,
applies an operator-authored **standing approval policy**, ranks what qualifies, and starts it —
bounded by a WIP limit, two disarm breakers, and a per-project share of the Claude quota.

Everything downstream of the `approved` label already runs unattended. The gate moves from
**per-target** ("approve this bead") to **per-policy** ("run anything that looks like this"). A new
`board-picker` job becomes a second writer of that label; a human stays the only author of the rule.

Alongside it, `product-master`'s existing armed-apply path gains the move vocabulary it lacks
(`approve`, plus four repair verbs), so the judgment tier can act on its conclusions instead of only
filing tickets about them.

**Repo-agnostic by construction.** anton is used across arbitrary repos. The policy ships no
vocabulary: it is generated from the label namespaces each board actually uses, plus the bd-native
fields guaranteed everywhere.

---

## Problem Frame

### What exists today

anton already automates the entire lifecycle *after* approval:

| capability | where |
|---|---|
| cron → enqueue (never executes) | `src/lib/jobs/scheduler.ts` |
| worktree, formula walk, agent dispatch, verify gates, self-review, one PR | `src/lib/jobs/execute-epic.ts` |
| PR comment + CI auto-resolution | `src/lib/jobs/review-fix.ts` |
| stall detection → safe auto-resume, else escalate | `src/lib/jobs/run-health.ts`, `unstick.ts` |
| gate closure → resume blocked work | `src/lib/jobs/gate-check.ts` |
| code scan → contract-shaped beads | `src/lib/jobs/nightly-stringer.ts` |
| board hygiene detection + armed apply | `src/lib/gardener/` |
| whole-board product judgment (Claude session) | `src/lib/jobs/product-master.ts` |
| idle-fill quota governor + per-job value gate | `src/lib/jobs/budget.ts` |

### The three gaps

**G1 — Nothing selects work.** `execute-epic` is enqueued from exactly three sites: the approve route
(`src/app/api/projects/[slug]/epics/[epicId]/approve/route.ts:499`), `unstick` (resume a stall), and
`gate-check` (resume gated work). `src/lib/schedules.ts:16` states it outright: *"execute-epic is
enqueued on approval, never on cron."* Nothing in the codebase ever **writes** the `approved` label.
`.beads/PRIME.md` documents a complete claimable-set query and a total deterministic ranking, but
that is the protocol an external worker follows — anton's runtime never runs it for itself.

**G2 — product-master can conclude but barely act.** `src/lib/jobs/product-master-steps.ts:132`
already calls `applyArmedProposals`, so the armed path exists and is shared with the gardener. But the
`GardenerMove` union (`src/lib/gardener/detections.ts:45-51`) is `reparent | link | retire |
reprioritize | split | unapprove` — note there is no `rehome` (re-homing is `reparent`) and no
`kill` (closing or deferring is `retire` with a `retireAs` of `close`/`defer`/`supersede`). There is
no `approve`: through `degraded-approval → unapprove`, product-master can **un**-approve your work
and never start any.

**G3 — Failure has one outcome: stop.** A blocked run parks and escalates. `ANTON-RESULT: blocked —
<reason>` (`src/lib/claude/anton-result.ts`) carries free prose, so anton cannot dispatch on *why*.
Beads that block on a fixable defect in their own description block forever.

### Two latent defects this work must fix

- **`jobValueScore` is not repo-agnostic.** `src/lib/jobs/budget.ts:297,299` hardcode `"risk:high"`
  and `"blocking-PR"`. Ranking in any repo not using anton/loom label conventions is already
  silently degraded to pure age.
- **`burn_samples` has no `project_id`.** `src/lib/db/schema.ts:117` attributes spend by job **type**
  only. Per-project quota shares are impossible without a migration.

---

## Decisions

Decisions taken during the brainstorm, with the alternatives rejected.

| # | Decision | Rejected |
|---|---|---|
| D1 | **Scoped standing approval.** A human pre-blesses a *boundary*; anton approves and runs anything inside it. | Per-target batch release only; a project master switch; hardcoded trust tiers by work class |
| D2 | **Two loops at their natural speeds.** Weekly-ish Claude judgment writes priority/order onto the board; a continuous mechanical picker reads it. | Teaching product-master to `approve` as the sole picker (starts work in weekly batches); event-driven triggers (new coupling at 4 sites) |
| D3 | **The picker is plain TypeScript. No Claude.** | An LLM picker — breaks the determinism `.beads/PRIME.md` depends on for cross-machine agreement, costs a session per tick, and makes "why did this run?" unanswerable from board state |
| D4 | **Board-native supervision.** An `Up Next` lane **between Backlog and Implementing**, provenance badges, veto on the card. | A dedicated Autopilot console page; a composed morning-briefing digest |
| D5 | **Brakes: WIP hold + score-regression disarm + consecutive-failure disarm.** | "Any open escalation pauses autopilot" — too blunt; one stale PR freezes everything |
| D6 | **All four repair classes may reach `apply`.** | Restricting the two inventive classes to `shadow` (see Risks — this deliberately overrides a stated principle in `rework.ts`) |
| D7 | **Per-project share of the quota**, with automatic idle renormalization. | One global ranked queue (needs cross-repo priority normalization); single-focus project; round-robin |

### D3 rationale, expanded

The picker must not call Claude, for four reasons in descending severity:

1. **Cost inverts the purpose.** Every ~10 min × every enabled repo. A session per tick spends the
   quota autopilot exists to spend on implementation.
2. **Determinism is load-bearing.** `.beads/PRIME.md`: the ranking is *"total and deterministic, so
   two machines agree on what is next."* An unstable comparator produces claim races.
3. **Auditability.** "Why did this run at 02:14?" must resolve to a rule and a rank, not a transcript.
4. **It is anton's own principle.** `product-master.ts:14`: *"An LLM cannot be a hash function."* The
   same argument makes it a poor comparator. The session judges; anton owns everything mechanical.

Claude remains in the loop at four places, none of them on the tick: product-master (judgment),
repair drafting (fires on a block), `execute-epic` (the work), and the review gate.

---

## Architecture

```
  daily when armed · 1 session      continuous · 0 tokens
 ┌──────────────────────┐          ┌──────────────────────┐
 │    product-master    │          │     board-picker     │  ◄── new
 │   (Claude session,   │          │     (mechanical)     │
 │    read-only tools)  │          │                      │
 └──────────┬───────────┘          └───────────┬──────────┘
            │ priority, ordering edges,        │ eligibility policy
            │ split, retire, repair            │ + PRIME rank
            │                                  │ + WIP + quota share
            └────────►  T H E   B O A R D  ◄───┘
                              │
                              ▼   write `approved`, enqueue
                   budget governor (idle-fill, per-project share)
                              │
                              ▼
                       execute-epic  (unchanged)
```

**The load-bearing idea: judgment is expressed as board state, never as a second selection path.**
product-master writes priority and ordering edges as armed proposals. The picker only reads what is
there. Objectives therefore influence execution without the picker ever calling an LLM — and a human
dragging a card steers autopilot through the *identical* channel, so there is no separate override
concept to reconcile and the correction propagates to every machine as ordinary board state.

`board-picker` introduces no new subsystem:

- reads the board via `loadAllIssues`
- re-uses `makeApprovalGate` (`src/lib/approval-gate.ts`) for approval's four promises
- re-uses `jobValueScore` (made agnostic, see R2.4) for ranking
- enqueues via `enqueueExecuteEpicIfAbsent` (`src/lib/jobs/queue.ts:355`) — the same idempotent path
  `unstick` and `gate-check` use, so overlapping passes enqueue exactly one run
- registers on the existing `Scheduler`, seeded **disabled**, per the `gardener` / `product-master`
  precedent in `src/lib/schedules.ts`

---

## Requirements

### R1 — `board-picker` job

- **R1.1** New `JobType` `"board-picker"` (`src/lib/jobs/queue.ts:17`) and `ScheduledJobType`
  (`src/lib/schedules.ts`). Default cadence `*/10 * * * *`, seeded `enabled: false`.
- **R1.2** The pass is a pure function over a board snapshot plus policy plus runtime state
  (WIP, quota, breaker state), returning a ranked list of targets to start. Purity is the testability
  contract, mirroring `approval-gate.ts` and `budget.ts`.
- **R1.3** Eligibility = the claimable-set definition in `.beads/PRIME.md`, narrowed by policy:
  a **run target** (a `feature`, or a parentless `task`/`bug`, or an `epic` with no `feature`
  children), `open`, unassigned, no unmet blockers, and matching the policy predicate.
- **R1.4** Ranking is the PRIME order: priority (P0 first, unset last) → transitive unblocking value
  via `blocks` edges → age. Total and deterministic.
- **R1.5** Starting a target writes `approved` **and** performs the auto-claim the approve route
  already performs, then enqueues. A target claimed by a human is never taken. The label write and
  the claim are ONE atomic operation under `withClaimLock`, reusing the approve route's sequence
  rather than reimplementing it: that route already holds the lock across both, because the label is
  what locks the reservation (`approve/route.ts:387-393`). A failed claim must leave no `approved`
  label behind. The lock is keyed on `repoPath` and so serializes one machine only — cross-machine
  the guard is the assignee CAS, which on an **embedded** board reads a possibly-stale mirror, so the
  pass pulls before the CAS and fails closed when the pull does not land.
- **R1.6** Idempotent: listing is a view of the board, never a queue of events. Two overlapping
  passes must enqueue exactly one run (`enqueueExecuteEpicIfAbsent`).
- **R1.7** Every start writes a bead note recording the rule that matched and the rank, with actor
  `policy` — matching the armed-apply convention in `src/lib/gardener/apply.ts`.

### R2 — The policy (repo-agnostic)

- **R2.1** A policy is a pure predicate over a bead, stored per-project in the existing
  `settingsJson`. Machine-local by design: two machines on one repo may hold different policies, and
  the bd claim protocol resolves the race. The UI must never imply the policy is shared state.
- **R2.2** **anton ships no vocabulary.** At authoring time the editor is *generated* from a board
  read: every `ns:value` label is split into namespaces and values, and offered alongside the
  bd-native fields.
- **R2.3** Two criterion tiers, differing in expressiveness:
  - **bd-native** — `type`, `priority`, `status`, `assignee`, parentage, `blocks` edges, age.
    Guaranteed on every board and *ordered*, so these support `≤` / `≥`.
  - **discovered namespaces** — membership only, because a set has no inherent order. An operator may
    rank a namespace's values once (drag order), stored **with the policy**; ordering is never
    inferred.
- **R2.4** `jobValueScore` stops hardcoding `risk:high` / `blocking-PR`
  (`src/lib/jobs/budget.ts:297,299`). It takes **operator-nominated value labels** from settings,
  defaulting to none. A repo with no nominations ranks on native fields alone; anton's own project
  nominates its two and keeps today's behaviour exactly.
- **R2.5** Unsatisfiable criteria **fail closed**: a bead with no `severity:` label does not satisfy
  `severity ∈ {minor}`. A repo that has never seen the operator's conventions matches nothing on day
  one, which is the safe direction.
- **R2.6** Fail-closed must be legible. The editor carries a live match count, a `see them` list, and
  a per-bead `why not?` explaining which criterion excluded it.
- **R2.7** **Never a blank form.** First arm runs a calibration read over the project's approval
  history and proposes a policy that would have matched it. Under ~5 prior approvals it falls back to
  a conservative universal default (`type ∈ {bug, chore}`, `priority ≥ P2`, no unmet blockers). The
  operator accepts or edits.
- **R2.8** Because calibration reads *this repo's* history, the proposed policy is expressed in *this
  repo's* vocabulary — agnosticism for free.

### R3 — The `Up Next` lane

- **R3.1** A fifth lane positioned **between Backlog and Implementing**. Flow direction is
  load-bearing: a card must never move left when it advances. (Left of Backlog was considered and
  rejected for exactly this.)
- **R3.2** Named `Up Next`, **not** `Ready`. `bd ready` already means *unblocked*, not *selected*;
  two meanings of "ready" on one screen is the confusion `.beads/PRIME.md` opens by warning about.
- **R3.3** A card lives in exactly one lane: `Up Next` **takes** its cards out of Backlog rather than
  overlaying them, otherwise the same bead appears twice in shadow mode.
- **R3.4** `Up Next` is **not a stage**. The other four map to bead state; this is a machine-local
  projection over Backlog. UI copy must not imply it is shared.
- **R3.5** The lane renders all three autonomy levels without a different screen:
  `propose` → empty · `shadow` → ranked cards each with `[Release]` · `apply` → they start
  themselves and the lane is a live preview.
- **R3.6** A dashed **budget line** inside the lane marks where this project's quota share runs out;
  cards below it are ranked but waiting.
- **R3.7** **Provenance badges**, one grammar for three writers, each clickable to concrete evidence:
  `◈ policy` → the rule that matched · `◈ PM` → the proposal and its evidence · `◈ repaired` → the
  bead diff.
- **R3.8** **Drag to reorder writes `priority`** — the same channel product-master uses. No shadow
  ordering, no override concept, and the correction propagates as board state.
- **R3.9** Two veto strengths: `✕ not now` defers this target only; `Never` opens the policy editor
  with the admitting criterion pre-highlighted, so declining a bad pick *tightens the rule*.
- **R3.10** The decision log reuses the Health page's existing `applied-section`
  (`src/components/health/applied-section.tsx`); picker starts and repairs become new entry kinds
  beside gardener applies.

### R4 — Brakes

- **R4.1** Two distinct kinds, never conflated in the UI:
  - **hold** — self-clearing, unalarming. The system is respecting a limit, nothing is wrong.
  - **disarm** — freezes the policy; requires an explicit human re-arm.
- **R4.2** **WIP hold**: stop starting new work at *N* unmerged PRs in `in-review`; resume
  automatically when one merges. Derived from existing run/PR state. Default *N* configurable.
- **R4.3** **Score-regression disarm**: the persisted per-run review score series
  (`src/lib/jobs/review-score.ts`) crossing below an operator floor, using the regression detection
  already in `src/lib/jobs/review-alarm.ts`.
- **R4.4** **Consecutive-failure disarm**: *N* runs in a row ending parked/failed/abandoned.
- **R4.5** Breaker state is always visible in the lane header with its reason **and its clearing
  condition** — a held lane must say what would release it.
- **R4.6** Breakers are per-project. A disarm raises an escalation carrying its evidence.

### R5 — Auto-repair

- **R5.1** Extend the result contract to a **classified** block:
  `ANTON-RESULT: blocked — <class> — <prose>`, classes `ref-stale`, `dep-missing`,
  `acceptance-missing`, `oversized`, `env`, `other`. Update `RESULT_LINE_RE` and the base system
  prompt (`src/prompts/system-base.md`).
- **R5.2** The class must be an **exact** member of the closed enum — never a prefix, substring, or
  first-word match. A first token that is not an exact member is legacy prose, not an unknown class,
  and the line parses as `other` with the whole original text preserved as the reason. Without this
  rule a mid-rollout fleet emitting both formats would see `blocked — ref to the missing component`
  parsed as class `ref`, and anton would run a confident repair on a bead nobody classified.
- **R5.2a** Unparseable or unknown classes escalate exactly as today — fail closed, so an out-of-date
  agent prompt degrades to current behaviour rather than to guessing.
- **R5.3** Each class becomes a **detection kind** with its own autonomy level, reusing `autonomyFor`
  and `applyArmedProposals` unchanged.
- **R5.4** **Factual repairs** (no content invented, no session required):
  - `ref-stale` — the bead cites a path/symbol that moved. Verify against the worktree, follow
    `git log --follow`, rewrite the pointer.
  - `dep-missing` — draw the `blocks` edge, park this target, let the picker start the blocker.
- **R5.5** **Inventive repairs** (a Claude session drafts content):
  - `acceptance-missing` — draft Acceptance from Goal plus surrounding code.
  - `oversized` — return structured children (goal, acceptance, order); anton writes them, draws the
    `blocks` edges, converts the parent to a container.
- **R5.6** **One repair per bead per class**, fingerprinted like every other proposal. A bead that
  blocks the same way twice escalates. This is what prevents a repair→fail→repair quota burn.
- **R5.7** **Invented content is marked permanently** on the bead — a durable
  `◈ anton defined "done"` marker carrying the drafting evidence, not a transient toast.
- **R5.8** **A failed repair counts double** toward R4.4. A wrong diagnosis is worse than none.
- **R5.9** Lifting the `split` hard floor (`src/lib/gardener/autonomy.ts`) requires giving `split` a
  real mechanical plan shape first — it is floored today precisely because it has no target/verb
  pair. Evidence fence for an armed split: parent still open, unclaimed, childless, still oversized.
- **R5.10** A repaired bead re-enters `Up Next` normally. It never bypasses the queue or the brakes.

### R6 — Quota shares

- **R6.1** New per-project `quotaSharePct`, defaulting to an equal split across projects with
  autopilot armed. It scales that project's `weeklyTargetPct` in the policy `resolvePolicy`
  (`src/lib/jobs/service.ts`) already resolves.
- **R6.2** Migration: add `project_id` to `burn_samples` (`src/lib/db/schema.ts:117`) and index it.
- **R6.3** Attribution inherits that table's stated limitation — the runner only opens a burn window
  when a job runs **alone** and discards it if a sibling dispatches. Shares are therefore a **pacing
  target, not a ledger**. The UI renders `≈ 12%`, never `12%`.
- **R6.4** **Idle renormalization**: shares are renormalized each tick over only the projects that
  currently have eligible work. An idle repo's share is simply absent from the denominator — no
  explicit lending mechanism.
- **R6.5** A per-project **`reserve my share`** opt-out excludes a project from renormalization, for
  the repo touched irregularly.

### R7 — product-master cadence coupling

- **R7.1** Arming autopilot promotes product-master's judgment from *advisory* to *load-bearing*:
  stale priorities are now executed at 02:00 rather than read by a human whenever. Arming therefore
  offers to raise its cadence from weekly to daily, **stating why**, with a `keep weekly` opt-out.
- **R7.2** Add `approve` to the gardener move vocabulary (`src/lib/gardener/detections.ts`) so
  product-master can propose starting work, governed by the same `propose → shadow → apply` ladder.

---

## Data model changes

**`anton.db`**

- `burn_samples` — add `project_id` (+ index) for R6.2.
- `settingsJson` (no schema change) — new keys: policy predicate, namespace value orderings,
  nominated value labels, `quotaSharePct`, `reserveShare`, WIP limit, score floor, consecutive-failure
  threshold, per-repair-class autonomy levels.
- Breaker state: disarm reason + timestamp, per project.

**beads** — no schema change. New note/label conventions only: the `policy` actor on picker starts,
the repair provenance marker, and the `approve` move on proposals.

---

## Non-goals (YAGNI)

- **No Autopilot console page.** Policy lives in Settings, queue on the Board, log on Health.
- **No cross-repo ranked queue.** Rejected in D7; it needs priority normalization across boards.
- **No LLM in the picker.** D3.
- **No new arbitrary-command primitive.** The `step:shell` rejection in
  `src/lib/jobs/step-registry.ts` stands unchanged.
- **No shared/synced policy.** Machine-local; consensus machinery buys nothing here.
- **No changes to `execute-epic`.** The picker is strictly upstream of it.

---

## Risks

| Risk | Mitigation |
|---|---|
| **D6 overrides a stated principle.** `src/lib/rework.ts` is explicit that reopen-vs-follow-up "is never inferred… only a human reading the review can make it". Allowing `acceptance-missing` and `oversized` to reach `apply` deliberately crosses that line. | Accepted knowingly. Bounded by: per-bead-per-class fingerprint (R5.6), the permanent invented-content marker (R5.7), double-weight failure counting (R5.8), the `MAX_APPLIES_PER_PASS` cap, and `shadow` as the shipped default for both. |
| Autopilot buries the operator in PRs. | WIP hold (R4.2) is the primary brake and ships in step 2, with the arming step. |
| Mechanical picker faithfully executes stale priorities. | R7.1 — arming raises the PM cadence, because judgment becomes load-bearing. |
| Quota shares read as an exact ledger they cannot be. | R6.3 — `≈` everywhere; documented as a pacing target. |
| Policy fails closed and the operator thinks autopilot is broken. | R2.6 — live match count, `see them`, per-bead `why not?`. |
| Two machines pick the same target. | Existing bd claim protocol; `enqueueExecuteEpicIfAbsent` idempotence; deterministic ranking (D3). |

---

## Build order

Five steps, each shippable and useful alone.

1. **Shadow picker.** `board-picker` job + policy predicate + editor + `Up Next` lane, `shadow` only.
   Nothing auto-starts; the operator gets a ranked, justified queue with `[Release]`. Near-zero risk,
   immediately useful. Includes R2.4 (agnostic `jobValueScore`).
2. **Arm it.** `apply` level, WIP hold, both disarm breakers, provenance badges, veto affordances,
   Health decision-log entries.
3. **Classified results + factual repairs.** R5.1–R5.4.
4. **Inventive repairs.** R5.5, R5.7, R5.9 — including the `split` plan shape that lifts the floor.
5. **Quota shares.** R6 + the `burn_samples` migration.

R7 (PM cadence coupling + `approve` verb) rides with step 2.

---

## Recommended Agents

| Phase | Agent | Responsibility |
|-------|-------|---------------|
| 1–5 | `@nextjs` | All of it — job layer, policy, drizzle/SQLite, React lanes and editors |

### Agent Chain

`nextjs` (no chain)

Every step is TypeScript inside the Next.js app, matching how anton tags essentially all of its own
work (`agent:nextjs`). No other bundled agent in `src/prompts/agents/` applies.

---

## Open questions

- Default WIP limit, score floor, and consecutive-failure threshold — pick by observing anton's own
  board during step 1's shadow period rather than guessing now.
- Whether `Up Next` should surface cross-project in a single view once R6 lands, or stay per-project.
