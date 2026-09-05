# Epic tier + Linear sync — approved UX

**Status:** approved 2026-07-26. Visual reference: [`2026-07-26-tier-and-linear-ux.html`](./2026-07-26-tier-and-linear-ux.html)
(open it in a browser — it is a working mock with two live interactions).

This file is the text-readable companion to the mock. If you are an agent implementing a bead that
references this design, **read this file first**, then open the HTML for exact layout, spacing, and
colour. The HTML is built entirely from anton's existing Atelier tokens (`src/app/globals.css`) —
it introduces no new palette except three `area:` hues, which are an open question (below).

---

## Part 1 — The tier model

Three tiers, nested with `bd link --type parent-child`:

| Tier | What it is | Who reads it |
| --- | --- | --- |
| `epic` | A product outcome spanning several features. Carries exactly one `area:` label. | Non-technical stakeholders. Syncs to Linear as a top-level issue, indistinguishable from a synced `feature` — push carries neither hierarchy nor tier (hazard 3). |
| `feature` | One shippable delivery unit — one worktree, one PR. **This is what anton runs.** | The board. Approved, claimed, run-leased, shipped. |
| `task` / `bug` / `chore` | The working layer, executed as part of their feature's run. | Engineering only. Never leaves the board. |

Verified against bd 1.0.4: parent-child nesting is arbitrary-depth and type-agnostic, `bd children`
renders the full tree, and `bd list --json` carries `parent` inline on any type at any depth. anton
shells only generic bd verbs (no `bd epic` / `bd swarm`), so nothing in bd privileges the `epic`
type. **The two-tier assumption is entirely anton's own.**

### The runnable rule (migration-free)

> A bead is a run target if it is a `feature`, **or** a parentless `task`/`bug`, **or** an `epic`
> with no `feature` children.

The third clause is the whole transition story: existing boards (epics with task children, no
features) keep running byte-identically. An epic becomes a container the moment a feature lands
under it. No re-typing, no flag day.

### Decisions

- **Approval stays per feature.** Approving an epic does nothing. Approval is a per-PR gate, and one
  button that launches six PRs is not a gate. Bulk-approve may come later, clearly labelled.
- **Board default is stage columns**, with the epic as a coloured badge on each feature card.
  Clicking a badge filters the board to that epic.
- **Group-by-epic swimlanes ship in v1** as an opt-in, non-destructive regrouping of the same cards
  (segmented control: `Stage | Epic`).
- **A legacy epic with no feature children** renders with a hollow `◇` badge reading "No epic —
  legacy run target". Visibly unmigrated, not scolded.
- **Roadmap is a table, not a second board** — it is read, not operated. Columns: Epic, Area,
  Features, Shipped, Linear. An epic with no `area:` shows "not synced — needs area:" rather than
  failing silently at push time.
- **Feature detail** gains one breadcrumb hop: `[epic badge] / Feature title · id`. Everything else
  (approve, claim, run-lease, PR pointer, notes) is unchanged.

### Known code consequences

- `beads.isEpic` (`src/lib/beads/bd.ts:719`) is overloaded — it answers both "is this runnable" and
  "is this a card/grouping parent". Split into the widened `isRunTarget` and a new `isContainer`.
- `getBoard` (`src/lib/board.ts:52-53`, `:107-110`) keys children by epic id. Keying off run targets
  instead **also fixes a live bug**: today a task whose parent is a non-epic disappears from the
  board entirely.
- `epicOf` (`src/lib/epic-graph.ts:65-70`) is one hop. Generalise to walk up to the nearest
  run-target ancestor.
- Internal naming (`execute-epic`, `epicBeadId`, `runs.epic_bead_id`, `/epics/[epicId]`) keeps
  working and is **deliberately not renamed** — a rename costs a DB migration and route churn for
  zero behaviour change. Track it as separate follow-up debt.

### Resolved: the designator prefix and the badge colour

Settled in [`.product/decisions/2026-07-26-engine-designator-prefix.md`](../../.product/decisions/2026-07-26-engine-designator-prefix.md)
(anton-9pkk.2). In short: `area:` stays its own prefix — it is a different axis from `domain:`
(product surface vs. company function), and `domain:` is too saturated by the shaping default to
carry it. The colour clash is resolved by dropping the per-area hue: every epic badge uses the one
iris `--type-epic` token and the value is carried by text, because iris is the only hue in the
palette no `agent:` token uses. Read the decision before building the badge.

---

## Part 2 — Linear sync

Settings › Automation. The panel is a **thin skin over `bd linear sync` flags** and shows the
command as you build it, so it never becomes a lossy abstraction over the CLI.

### Controls

| Control | Options | Default |
| --- | --- | --- |
| Enable | on/off | off |
| When it runs | After each beads push · On a schedule (both may be on) | both, cron `0 */4 * * *` |
| Direction | Push to Linear · Pull from Linear · Both | Push |
| **Which tiers sync** | multi-select: `epic` `feature` `task` `bug` `chore` | `epic` + `feature` |
| Also include | Open only · Open and closed | Open and closed |
| Team | Linear team id | — |
| Project routing | table mapping each `area:` label → Linear project | — |
| Extra arguments | free text, passed through verbatim | — |
| Preview | dry-run counts, not a spinner. Needs a credential — bd's dry run calls the live API, and reports one line per bead, so anton derives the counts | — |

The tier chips are the headline control — they drive `--type`. Toggling them rewrites the previewed
command and the dry-run counts live (see the mock).

### Decisions

- **Push-triggered syncs are debounced to one per 5 minutes.** A single run writes to a bead dozens
  of times and each write nudges a push; undebounced this is a Linear API call per bead write. The
  schedule is the backstop for a failed push-triggered sync.
- **Per-area routing runs one pass per area.** bd holds a single `linear.project_id`, so anton sets
  it, pushes that area's ids, and restores it. Unmapped areas are skipped and reported, never
  guessed. Build it behind a pure `planLinearPushes(beads) → [{projectId, issueIds}]` so it swaps to
  an upstream bd label→project mapping later.
- **Credentials come from the environment** (`LINEAR_API_KEY`, or the OAuth pair), never stored in
  `anton.db` — same posture as `gh`. The panel reports what it found and stops there.
- **Dry-run before the first push.** Every setting is reversible except a bad first push, which
  creates issues in someone else's Linear.
- **The push is flat, and the tier does not survive it** (settled 2026-09-05, hazard 3). bd sends no
  parent, and `--type` only *selects* which beads are pushed — the payload is title, description,
  priority, state and project id, nothing else — so a pushed epic and a pushed feature are
  indistinguishable in Linear. Grouping lives in the Linear project the `area:` routing sets; that
  is the only structure the sync can express. **Tier is a documented loss**, accepted for the same
  reason the parent breadcrumb was rejected: the only channels left are title and description, and
  anton does not mutate bead content for a cosmetic gain in a downstream tracker.

### Hazards that must be handled

> **Answered 2026-09-05** by [`docs/spikes/2026-09-05-bd-linear-push-shape.md`](../spikes/2026-09-05-bd-linear-push-shape.md)
> (anton-ey0w.1): hazard 3 is settled — push never sends a parent *or* the tier, so the epic→sub-issue
> shape is not available and epics and features are indistinguishable in Linear; hazard 2 is
> **re-scoped, not closed** — bead labels never reach Linear, but every push still costs one read per
> linked bead, plus a write for the ~5-in-8 of the default *Open and closed* population that carries a
> structured `acceptance_criteria`/`notes` field; hazard 1 is confirmed and `--update-refs=false`
> cannot prevent it (the flag is declared but never read).

1. **`external_ref` collision.** `bd linear sync --push` defaults to `--update-refs true`, writing
   the Linear ref into `external_ref`. A board still carrying legacy `gh-<n>` PR pointers there
   (honoured as a fallback by `beads.getPrRef`, `bd.ts:547-552`) **loses them**. The sync job must
   refuse to push while `planPrRefMigration(list)` is non-empty.
2. **Run-lease label churn.** The run-lease is a label rewritten every 5 minutes on the run target
   (`RUN_LEASE_REFRESH_MS`, `execute-epic.ts:72`) — which is now a synced `feature`. **Settled
   2026-09-05: push never sends labels**, so the lease stays on labels and nothing moves to metadata.
   What remains is cost, not leakage. bd fetches every linked issue before it can decide to skip, so
   **each push is one read per Linear-linked bead no matter what** — that floor is what the debounce
   caps. On top of it, bd's unchanged-issue skip (`PushFieldsEqual`) misses and writes: once per bead
   after its create (the remote still carries bd's idempotency marker, which the first update
   strips), and then *permanently* for any bead carrying a structured
   `acceptance_criteria`/`design`/`notes` field, because the comparison re-runs the description
   builder on a copy that still has them and appends those sections twice. anton's contract keeps the
   rubric in the description and forbids `--acceptance` — but that only covers `acceptance_criteria`,
   and **anton fills `notes` itself** via `bd note`, so new run targets keep joining the writing set.
   Measured on the population this panel's own default pushes (`--state all`, so open *and* closed):
   **123 of 196 epics+features write on every push** on 2026-09-05. Budget N reads + ~0.6N writes per
   cycle, and do **not** assume it decays — a closed bead never leaves a `--state all` population.
   Setting **Also include** to *Open only* is the lever that moves it (N=39, 12 writes). The
   "a lease-only change syncs nothing" guarantee still has to be enforced at anton's seam (do not
   fire the push): bd's skip is not a guarantee we can lean on. And `status` transitions are genuine
   content changes that *do* cross.
3. **Sub-issue nesting.** **Settled 2026-09-05 (anton-60oi): there is no nesting.** Push sends no
   parent — hierarchy is pull-only — so the epic→sub-issue shape is dropped. The push is a flat list
   of top-level issues that carry no tier marker either: `--type` selects the beads to push, it does
   not travel in the payload, so nothing in Linear separates an epic from a feature. Grouping is the
   Linear project the per-area routing already sets. Three alternatives were rejected — routing
   epics to projects and features to issues (it consumes the project axis per-area routing owns),
   writing a parent breadcrumb into the pushed description, and prefixing the tier onto the pushed
   title (both make anton mutate bead content for a cosmetic gain in a downstream tracker). Note that
   `--dry-run` could never have answered this: it reaches the live API before printing, and prints
   one bare title per bead.

---

## Sequencing

The two parts are separate epics. The tier work **blocks** the sync work — they meet only at the
`area:` label, and `--type epic,feature` is meaningless until `feature` beads exist.
