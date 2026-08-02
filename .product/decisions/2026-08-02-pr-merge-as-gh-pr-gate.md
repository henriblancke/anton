# The PR-merge wait is a `gh:pr` gate; the review-event poll stays

Date: 2026-08-02
Status: accepted
Ticket: anton-k0kj · settles the "can a gate express REVIEW events?" question anton-4lad
carried into the review-fix migration

## Decision

**A run's merge wait is a `gh:pr` gate.** When execute-epic opens a target's PR it arms
`bd gate create --type=gh:pr --blocks <target> --await-id <pr>` (step 5). gate-check's per-slot
`bd gate check` settles every merge wait in the project in one call, and a target whose gate has
closed is handed to review-fix, which finalizes it exactly as before.

**The review-event poll survives, by design.** A `gh:pr` gate can express merge-terminal states and
nothing else, so requested changes / new review comments / red CI keep the 15-minute review-fix
sweep as their trigger. This is the one poll gates cannot replace, and it is documented as such in
`review-fix.ts` and `schedules.ts` rather than left to look like an oversight.

**A gh:pr gate is never a prerequisite.** It awaits the blocked bead's OWN pull request, so every
blocker computation skips it (`epic-graph.ts`). Anything else makes an in-review target read as
blocked by itself.

## The measurements

Re-run on **bd 1.1.2** (installed) and **bd 1.1.0** (`MIN_BD_VERSION`, `~/.local/bin/bd.1.1.0.bak`)
against real `henriblancke/anton` PRs — identical on both. Reproduce:

```sh
mkdir -p /tmp/prgate && cd /tmp/prgate && git init -q .
git remote add origin git@github.com:henriblancke/anton.git   # gh resolves the repo from CWD
BD_NON_INTERACTIVE=1 bd init --prefix prg --non-interactive
for n in 97 19 98 999999; do                                  # merged · closed-unmerged · open · absent
  ID=$(bd create "wait on PR $n" --json | jq -r 'if type=="array" then .[0].id else .id end')
  bd gate create --type=gh:pr --blocks "$ID" --await-id="$n"
done
bd gate check --type=gh:pr --json
bd gate list --all --json | jq -r '.[]|[.await_id,.status]|@tsv'
```

| PR state | `bd gate check` verdict | gate afterwards | counted as |
| --- | --- | --- | --- |
| **MERGED** (#97) | `✓ resolved - … was merged` | **closed** | `resolved` |
| **CLOSED, not merged** (#19) | `⚠ ESCALATE - … was closed without merging` | **open, unchanged, unlabelled** | `escalated` |
| **OPEN** (#98) | `○ pending - … is still open` | open | — |
| **absent** (#999999) | `⚠ ESCALATE - pull request not found` | open | `escalated` |

Four properties follow, and the design rests on each:

1. **Only a merge satisfies a `gh:pr` gate.** Closed-unmerged never resolves — so the recovery path
   is preserved *by bd's own semantics*, not by an anton guard that could be edited away. The PR ref
   stays on the bead, review-fix still leaves the epic alone, and execute-epic still re-opens the PR.
2. **An unreadable PR advances nothing.** A PR that cannot be read escalates and leaves the gate
   open; the wait simply continues. `errors` stays 0 for it, so gate-check's `errors > 0` throw is
   about bd/gh failing outright, not about an unresolvable PR.
3. **`escalated` does not close a gate.** bd changes no state and writes no label, so anton's own
   expiry pass (`expiredGates` + `GATE_EXPIRED_LABEL`) remains the only thing that ever surfaces a
   dead merge wait — which is why the gate is armed with a timeout (`168h`).
4. **A timeout on a `gh:pr` gate is inert to bd.** `bd gate check --type=timer` reports
   `No open gates of type 'timer' found` for a gh:pr gate carrying `--timeout=1s`, and `--type=all`
   still judges it by PR state. The timeout is anton's deadline for surfacing a stall, never a
   second way for the gate to resolve — an unmerged PR can NOT age into a false green.

Three further behaviours, measured the same way:

- **A gate cannot block an `epic`.** `bd gate create --type=gh:pr --blocks <epic>` fails with
  `adding blocking dependency: epics can only block other epics, not tasks` (and plain
  `bd dep add <epic> <gate> --type blocks` fails identically) — bd enforces a type tier on `blocks`
  edges, and a gate bead is not an epic. Worse, the failed create still leaves the gate bead behind,
  blocking nothing, where `bd gate check` would evaluate it forever. So execute-epic refuses the case
  up front: a legacy `epic` run target arms no gate and keeps learning about its merge from the
  review-fix sweep. Every run target the tier split produces — `feature`, and a parentless
  `task`/`bug` — takes the gate normally, and its `blocks` edge lands on the target as expected.

- **`bd ready --gated` is molecule-only.** With the merged gate closed and its bead back in plain
  `bd ready`, `bd ready --gated` still returns `{"count":0,"molecules":[]}` on both versions. An
  ad-hoc gate on a plain bead is invisible to it, so gate-check's merge dispatch is derived from the
  BOARD (a closed `gh:pr` gate blocking an open `stage:in-review` target), not from that call.
- **Gate beads carry `await_type`/`await_id` through `bd list --status all --type gate`**, which is
  how `loadAllIssues` makes them classifiable — and why execute-epic now reads the board through
  `loadAllIssues` instead of a bare `bd list` (which omits gates while carrying their `blocks`
  edges, so a fail-safe would read the target's own merge gate as an unknown open blocker forever).

## Why

**A merge is a state, not an event to be polled for.** The old shape re-read every open PR every 15
minutes to notice something that happens once; the gate makes it one `bd gate check` per slot for
the whole project, and nothing at all in between.

**The closed-unmerged distinction is the whole risk of this migration**, and it survives because bd
draws the same line anton does: merged resolves, closed escalates-but-stays-open. A gate model that
closed on any terminal PR state would have destroyed the recovery path — that is what the table
above was run to rule out, before any wiring.

**Review events genuinely have no gate flavour.** `bd gate create --type` accepts exactly
`human|timer|gh:run|gh:pr`, and `gh:pr`'s entire GitHub read is `gh pr view <id> --json state,title`
(bd's own help, and the verdict vocabulary above confirms it: resolved / escalate / pending, never
anything review-shaped). So the answer the ticket demanded is: **only merge-terminal states** — and
the residual review-event poll is a design decision, recorded here, not an unfinished migration.

## Rejected

- **Closing the merge gate on any terminal PR state.** Would finalize a PR someone closed without
  merging: the epic would go done, its tickets would close, and the branch would be deleted with the
  work unmerged. The ticket named this as the trap; bd does not have the failure, and anton must not
  add it.
- **Letting the merge gate count as a blocker.** It blocks the bead that owns the PR, so the approve
  route would 409 and execute-epic would poison — including on the closed-unmerged recovery run,
  where the gate stays open forever. `gh:pr` gates are skipped in blocker computation for that
  reason; `human` and `timer` gates still block, because those ARE prerequisites.
- **Deleting the review-fix poll entirely.** It is also the review-comment/CI trigger; removing it
  would silently drop half the job's purpose to satisfy the word "poll".
- **A `bd ready --gated`-driven merge dispatch.** Measured molecule-only — it would never fire.
- **Making review events into gates via `gh:run`.** A `gh:run` gate answers "did this workflow run
  finish green?", not "did a human request changes". It could replace the CI half of the sweep only
  by pinning a run id per PR push, which is a bigger, separate design; the review half would still
  need the poll, so the poll would not go away.
