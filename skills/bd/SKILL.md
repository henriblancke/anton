---
name: bd
description: >-
  Conventions for how anton writes to the beads board (bd). The single place bd usage is
  defined, so /shape and /scan-triage stay consistent and beads stays swappable. Shaping is the
  producer — it creates and links contract-shaped beads; anton's autonomous execution runtime
  claims, dispatches, reviews, and closes them. Reference this when creating or linking beads.
---

# bd — call conventions (producer side)

beads is the board. Shaping *writes* well-formed beads to it; it does not execute them. Keep all
`bd` usage to the forms below so behavior is consistent and beads stays swappable. Assume `bd` ≥ 1.0
and a `.beads/` in the project (`bd init` if absent). Prefer `--json` for machine reads.

This skill is the standalone home for anton's beads conventions — the label / edge / lifecycle
model below travels with it, so a `/shape` or `/scan-triage` run has the full contract from
anton's assets alone (no external plugin or session-start injection required).

## Issue types — the three tiers

Work nests in three tiers, linked with `parent-child`. The middle tier is the one anton runs.

| Tier | What it is | Who reads it |
|------|------------|--------------|
| `epic` | A **product outcome** that several features add up to. A container — never run or approved on its own. Carries exactly one `area:` label. | Non-technical stakeholders; the roadmap. |
| `feature` | One **shippable delivery unit — one worktree, one PR**. **This is what anton runs**, approves, claims, and ships. | The board. |
| `task` / `bug` / `chore` | The **working layer** — the steps of one feature, executed inside its run. | Engineering only; never leaves the board. |

Also `learning` — a captured correction/insight (usually prefer `.product/learnings.md`; a bead
only when it needs a dependency edge).

### `epic` has been redefined

`epic` used to mean "a coherent, shippable increment, scoped to one PR". **That meaning is now
`feature`.** An epic is the tier *above* it: the outcome a handful of features deliver together.
Approval and execution stay per feature — approving an epic would be one button launching N PRs,
which is not a gate.

### The nesting rule

`epic → feature → task | bug | chore`. One parent per bead.

- Every `feature` hangs off an `epic`. A feature with no plausible epic is a **question for the
  user**, never a silent orphan (see the `shape` skill).
- `task` / `bug` / `chore` hang off **a feature**, never off an epic. A ticket parented straight to
  an epic is a dead bead: it isn't a run target (it has a parent), and no feature's run covers it.
  Work that no feature holds — the security page, the ops step — is its own `feature`, or a
  parentless ticket; it is never a loose child of the epic.
- A genuine one-off that no epic would honestly hold is a **parentless `task`/`bug`** — a run of
  one. Don't invent a single-feature epic to avoid it, and never nest a feature under a feature.
  `chore` is not an option here: it only ever runs as a feature's child, so a parentless one is a
  dead bead.

### The run-target rule (what anton will actually run)

> A bead is a run target if it is a `feature`, **or** a parentless `task`/`bug`, **or** an `epic`
> with no `feature` children.

That last clause is the whole migration story: boards shaped before the tiers — epics with task
children — keep running byte-identically. An epic becomes a container the moment a feature lands
under it. **Never re-type an existing bead to "migrate" it.**

## Labels

`/shape` and `/scan-triage` set these; anton's execution runtime reads them to route execution.

| Label     | Values                                                     | Meaning |
|-----------|------------------------------------------------------------|---------|
| `domain:` | `eng`, `marketing`, `bizdev`, `research`, `ops`            | cross-domain classification |
| `area:`   | project-local product surfaces (`ingest`, `billing`, …); open vocabulary | **epic tier only**, exactly one; the roadmap's Area column and Linear project routing key on it. A different axis from `domain:` — which company function owns the work vs. which product surface it advances |
| `risk:`   | `low`, `high`                                              | `high` = security / schema / auth / payments / migrations / infra |
| `agent:`  | `nextjs`, `supabase`, `fastapi`, `pydantic`, `alembic`, … or omitted | which specialist fits |
| `size:`   | `S`, `M`, `L`                                              | sanity check; `L` on a ticket is a smell — split it |
| `source:` | `stringer`, or omitted                                     | provenance; scan beads also carry `stringer:<collector>:<hash>` for dedup |

(Model routing is the executor's concern — shaping does not set a `model:` label.)

## Dependency edges

beads gives four; use them deliberately:

- `parent-child` — the tier link: epic → feature → ticket.
- `blocks` — hard ordering. A blocked ticket never appears in `bd ready`.
- `related` — soft context link; no ordering effect.
- `discovered-from` — provenance for work found mid-task.

## Lifecycle

```
shaping produces:   stub  → shaped → (ready when deps clear)
execution drives:   ready → in-progress → review → done   (and park/unpark on failure)
```

- `stub` — idea captured, not yet contract-complete. A `/shape` backlog item.
- `shaped` — has Goal + Acceptance + Context + Out-of-scope + Verify + labels.
- `ready` — shaped and unblocked; what `bd ready` returns. **Shaping's output ends here** —
  execution takes it from `ready`.

## The bead contract

A feature or ticket is not `shaped` until its description contains `## Goal`, `## Acceptance`
(checkable boxes), `## Context`, `## Out of scope`, `## Verify`. Without these the executor has no
spec. `/shape` and `/scan-triage` enforce it; `bd lint` checks the Acceptance/Success sections.

An epic is read, not executed, so it carries less: a one-line outcome, Success Criteria its
features add up to, and its `area:` label.

## The bead formula — pour the skeleton, don't retype it

The contract's shape is **structural**, not something you re-derive from these headings each time.
The project ships it as a beads formula at `.beads/formulas/anton-bead.formula.json` (installed by
`anton setup` / `anton init`; a project-local copy always wins, and because it lives in `.beads/` it
travels to every clone). It has one step per tier — `epic`, `feature`, `ticket` — with the contract
sections pre-stubbed:

```bash
bd formula show anton-bead                      # what it templates
bd cook anton-bead --mode=runtime \
  --var goal='…' --var acceptance='- [ ] …' \
  --var context='touches: …' --var out_of_scope='- …' --var verify='…'
# → JSON; take .steps[] | select(.id=="ticket") | .description as the bead description
```

Then materialise with the ordinary `bd create` below (`--description` from the cooked step,
`--acceptance` mirroring the same text into bd's own field).

**Cook it; never pour it.** `bd mol pour` materialises a molecule whose ROOT is
`issue_type=molecule` — not one of the three tiers — so anton's board walks straight past it.

The `{{var}}` defaults are **prompts, not content**. Fill every one. A fabricated Acceptance box is
worse than an absent one: the self-review gate scores the diff against it, so a stub rubric scores
the run against the wrong thing.

## Create a shaped feature or ticket

Map the bead contract to native fields; put `Goal`, `Out of scope`, and `Verify` in the
description (markdown), Acceptance and Context in their own fields. Same shape at both tiers —
`--type feature` for the run target, `--type task` (or `bug`/`chore`) for its children:

```bash
bd create "Add CSV export button" \
  --type task \
  --acceptance $'- [ ] button on /reports exports current view as CSV\n- [ ] respects active filters' \
  --context "touches: app/reports/*, lib/csv.ts; follow pattern in app/reports/pdf.ts" \
  --body-file - <<'EOF'
## Goal
Let users export the reports view to CSV so they can share numbers. Requested by 3 users.

## Out of scope
- no new columns; no server-side generation

## Verify
- unit test lib/csv.ts formatting; e2e: click export → file downloads
EOF
```

Then label and link (below). Run `bd lint <id>` — it enforces Acceptance Criteria (`task`, `bug`,
`feature`) / Success Criteria (`epic`); `/shape` and `/scan-triage` enforce the rest of the
contract.

## Epic → feature → tickets

Create the parent first, then link each child to it — the child is `bd link`'s first argument:

```bash
# The outcome. Several features add up to it; it is never run itself.
bd create "Reports are shareable outside the app" --type epic \
  --acceptance $'- [ ] every report view leaves the app in a format a customer can open'
# → EPIC_ID
bd tag "$EPIC_ID" area:reports                           # exactly one area: on an epic

# The run target: one worktree, one PR.
bd create "CSV export" --type feature --acceptance ...   # → FEAT_ID
bd link "$FEAT_ID" "$EPIC_ID" --type parent-child        # feature is child of epic

# The working layer, executed inside the feature's run.
bd create "Add export button" --type task ...            # → T1
bd link "$T1" "$FEAT_ID" --type parent-child             # T1 is child of the feature
```

Find the epic a feature belongs to before creating a new one:

```bash
bd list --type epic --json                 # open epics; add --all to include closed
bd list --label area:reports --json        # everything already on that surface
bd children <epic-id>                      # the full tree under an epic
```

## Labels

`bd tag` takes **one** label per call, so set the set at create time and use `bd update` to patch:

```bash
bd create ... --labels domain:eng,risk:low,agent:nextjs,size:S
bd update <id> --add-label risk:high --add-label agent:supabase   # repeatable
bd tag <epic-id> area:reports           # one label; epic tier only, exactly one value
# /scan-triage also tags: source:stringer  stringer:<collector>:<hash>  (dedup fingerprint)
```

## Dependency edges

```bash
bd dep add <blocked> <blocker>          # hard ordering (blocked depends on blocker)
bd link <a> <b> --type related          # soft context link
bd link <new> <origin> --type discovered-from   # provenance for work found mid-flight
```

## Read the board (dedupe / inspect)

```bash
bd list --json --limit 0                # existing beads (dedupe /scan-triage against these)
bd list --status all --json --limit 0   # + closed: parentage and edges, the board read pickup needs
bd show <id>
```

`bd ready` is deliberately absent from that list — what a worker may take is the claimable set
below, never the raw ready list.

## The pickup protocol — how any worker takes work

The board is the work queue. A second anton, a headless job, or a plain Claude Code session in
another clone must pull the same set, in the same order, and must never both believe they hold the
same target. anton implements this in `src/lib/beads/bd.ts` (`beads.claimableTargets`,
`beads.claimVerified`) and `src/lib/beads/child-assign.ts`; the CLI form below is the same protocol
for a worker with no anton runtime.

### 1. The claimable set — never bare `bd ready`

**No worker runs bare `bd ready`.** It answers "what is unblocked", not "what may I take": it
includes unapproved work (which anton refuses to run), targets another machine already holds,
container epics (whose features each run on their own), and the child tickets of a feature already
in flight. Acting on it means claiming work that will be rejected, or stealing work in progress.

The canonical pool query:

```bash
bd ready --label approved --unassigned --json --limit 0
```

- `--label approved` — the human gate; unapproved work is not claimable at all.
- `--unassigned` — a claim already held is not up for grabs.
- `--limit 0` — unlimited; `bd ready` truncates at 50 by default and silently drops work.
- No `--type`: bd's `-t/--type` takes ONE type (verified on 1.1.2) and the set spans three shapes.

Then narrow the pool to **run targets** (the run-target rule above) against one full board read
(`bd list --status all --json --limit 0`, which carries parentage and `blocks` edges), keeping only
beads that are `open`, carry `approved`, and have no assignee. Rank what survives — the order is
total and deterministic, so two machines agree on what is next:

1. **priority**, P0 first (a bead with none sorts last);
2. then **unblocking value** — how many open beads it transitively unblocks via `blocks` edges, most
   first;
3. then **age**, oldest `created_at` first;
4. then **id**, which is what makes the order total.

### 2. Claim, then prove the claim held

Claims ride eventually-consistent Dolt sync, so *writing* a claim is not *holding* one. Run the
whole sequence, in order, for the top-ranked target:

```bash
bd dolt pull                                 # 1. see a claim another machine already published
BEADS_ACTOR="$ACTOR" bd update <id> --claim  # 2. bd's atomic local CAS — refuses a bead someone else holds
bd dolt commit && bd dolt push               # 3. publish; a claim nobody else can see is not a claim
sleep 2                                      # 4. settle — let a near-simultaneous rival reach the remote
bd dolt pull                                 # 5. re-read after the merge has picked a winner
bd show <id> --json                          # 6. assert assignee == "$ACTOR"
```

Step 6 is the only one that makes the claim trustworthy. Three outcomes, and only the first licenses
a run:

- **assignee is you** → you hold it; run it.
- **assignee is someone else** → you lost the race. Back off *without writing anything* and move to
  the next target. Losing is the protocol working, not an error.
- **could not prove it either way** (any step failed) → fail closed: do not run the target. Retrying
  is safe — `--claim` is idempotent for the same actor.

### 3. Claiming a feature reserves its children

`bd ready --unassigned` filters on each **ticket's** own assignee, so a running feature keeps serving
its children to every other worker until they are reserved. After winning a feature, reserve each
open, non-abandoned child for the same actor:

```bash
bd assign <child-id> "$ACTOR"     # reservation, NOT a claim
```

`bd assign`, never `bd update --claim`: assignment leaves the child `open` (still backlog) while the
run's own per-ticket claim stays the one thing that marks a ticket in flight. Leave alone — and
report — any child a different actor already holds. When the run releases, parks, or abandons, hand
back only the children still assigned to you:

```bash
bd assign <child-id> ""
```

## Not shaping's job (the execution runtime owns these)

Claiming, dispatching, worktrees, review/scoring, merges, park/unpark, and coordination are the
**executor's** responsibility. Shaping never claims, closes, or merges beads — it only creates
and links them. The pickup protocol above is documented here because it is the one definition of
what "claimable" means; producing work never executes it.

## Cross-domain

Marketing/bizdev/research tasks are first-class beads (`domain:marketing`, etc.) with the same
contract. But their **entities** (a customer, competitor, content calendar) live in
`.product/entities/`, never as beads. Beads track work; markdown tracks knowledge.

## Don't

- Don't shell out to `bd` from anywhere except through these forms.
- Don't store business entities (customers, deals, content) as beads — those are markdown in
  `.product/entities/`.
- Don't invent statuses; use `bd statuses` to see valid ones.
- Don't scope an `epic` to one PR — that's a `feature` now. And don't re-type beads already on the
  board to fit the tiers; the run-target rule keeps them running as they are.
- Don't leave a `feature` parentless to avoid picking an epic, and don't mint a one-feature epic to
  avoid asking. Ask the user.
