---
name: bd
version: caadf1c57b87
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

### How big is a feature? (the two readings, settled)

One `feature` is **one worktree, one PR** — and it carries **2–6 tickets**. Those are not in
tension: a feature's tickets are the *steps executed inside its single run*, not separate PRs. The
run works through them in order and opens one PR at the end.

So the tiers answer three different questions, and the ticket count is how you tell which one you're
holding:

- can't be delivered in one PR → it's an **epic**, split it into features;
- one PR, several steps → it's a **feature**, 2–6 tickets under it;
- one step → it's a **ticket**, and it belongs under some feature.

A feature with **1** ticket is a shape question — you probably described the same work twice. A
feature with **0** is legal (see invariant 5) but is what "make everything a feature" produces in
bulk. Past **6**, the diff stops being reviewable in one sitting: that's two features.

### The nesting rule — five invariants

`epic → feature → task | bug | chore`. One parent per bead. These are checkable, and they are
checked — `anton board-check` prints every violation on the board, and the approve route refuses on
1–3 for the target it is approving. Severity is one question and only one: **can this bead ever
run?**

**Blocking — a dead bead. It will never run, and no amount of waiting changes that.**

1. **No ticket under a container epic.** A `task`/`bug`/`chore` whose parent is an epic that already
   has a `feature` child is unreachable: it isn't a run target (it has a parent), and no feature's
   run covers its parent's strays. Work that no feature holds — the security page, the ops step —
   is its own `feature`, or a parentless ticket; never a loose child of the epic.
   *(An epic with NO feature children still runs its own tickets — pre-tier boards are untouched.
   The epic becomes a container the moment a feature lands under it, and its strays die then.)*
2. **A feature hangs off an epic and nothing else.** Never a feature under a feature. Both are run
   targets, so a nested one ships the same work twice — two claims, two worktrees, two PRs.
3. **No parentless `chore`.** Only `task`/`bug` run standalone; a parentless chore is a dead bead.
   Give it a feature parent or re-type it.

**Advisory — it runs, but the shape costs later. Fix it; never let it block honest work.**

4. **Every feature has an epic.** A parentless feature runs fine and appears on no roadmap. A
   feature with no plausible epic is a **question for the user**, never a silent orphan (see the
   `shape` skill).
5. **A feature carries 2–6 tickets.** Zero is legal — `beads.groupsChildren` reads a childless
   feature as its own single ticket, which is right for a genuinely atomic PR — but fifteen of them
   at once means leaves got mistyped as features. **One** is the same work described at two levels.
   Over six means it's two features. The count is the RUN's: every working-layer descendant, since
   `feature → task → subtask` ships all of it in one worktree and one PR — not just direct children.

A genuine one-off that no epic would honestly hold is a **parentless `task`/`bug`** — a run of one.
Don't invent a single-feature epic to avoid it.

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
| `agent:`  | `nextjs`, `supabase`, `fastapi`, `pydantic`, `alembic`, … or `human`; or omitted | which specialist fits; `human` names the one specialist anton does not have — see below |
| `size:`   | `S`, `M`, `L`                                              | sanity check; `L` on a ticket is a smell — split it |
| `source:` | `stringer`, `gardener`, or omitted                         | provenance; scan beads also carry `stringer:<collector>:<hash>` for dedup, and gardener proposals `gardener:<class>:<hash>` (an open or declined fingerprint stops the patrol re-asking) |

(Model routing is the executor's concern — shaping does not set a `model:` label.)

### `agent:human` — work no agent can finish

One question decides it, and shaping can answer it from the bead alone:

> **Can an agent complete this end to end, or does it need a credential, an account, a purchase, a
> signature, or a taste call?**

Any of those five and the bead is `agent:human`: register the domain, sign the DPA, buy the plan,
pick the pricing tier, click through a third-party dashboard, judge which of two designs is better.
The point is honesty about who does the work, not a lower bar — a human bead is shaped to the same
contract and approved by the same gate as any other.

What changes is routing. Every other `agent:` value resolves to a specialist prompt file; `human`
resolves to none, so a human bead left unmarked would dispatch to the DEFAULT agent and flail at
work no agent can do. That is why the value exists and why the exclusion below is explicit: a
`agent:human` bead never enters the claimable set (§1 of `.beads/PRIME.md`), and inside a run it
becomes a human gate at its boundary rather than a step an agent improvises around — the run does
every ticket that does not depend on it, then parks on that gate. Resolving the gate is the whole
answer: anton closes the ticket and runs the rest.

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

A feature or ticket is not `shaped` until its **description** contains `## Goal`,
`## Acceptance Criteria` (checkable boxes), `## Context`, `## Out of scope`, `## Verify` — all five,
in that order, in the one field. Without these the executor has no spec.

**bd checks one of the five, not five.** `bd create --validate` and `bd lint` both look for the
rubric heading alone. The other four — Goal, Context, Out of scope, Verify — are enforced by
`/shape`, `/scan-triage`, and anton's own contract gate at approve time. Nothing bd says green
means the contract is complete.

An epic is read, not executed, so it carries less: a one-line outcome, Success Criteria its
features add up to, and its `area:` label.

## The bead formula — cook the skeleton, don't retype it

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

Then materialise with the ordinary `bd create` below: the cooked step's `description`, whole, and
nothing beside it. **The description is the only place the contract lives** — see the next section.

**Cook it; never pour it.** `bd mol pour` materialises a molecule whose ROOT is
`issue_type=molecule` — not one of the three tiers — so anton's board walks straight past it.

The `{{var}}` defaults are **prompts, not content**. Fill every one. A fabricated Acceptance box is
worse than an absent one: the self-review gate scores the diff against it, so a stub rubric scores
the run against the wrong thing.

## Create a shaped feature or ticket

**The description carries the whole contract — every section, in the formula's order.** Cook the
body, write it to a file, pass it as the description. Same shape at both tiers — `--type feature`
for the run target, `--type task` (or `bug`/`chore`) for its children:

```bash
bd cook anton-bead --mode=runtime \
  --var goal='Let users export the reports view to CSV so they can share numbers. Requested by 3 users.' \
  --var acceptance=$'- [ ] button on /reports exports current view as CSV\n- [ ] respects active filters' \
  --var context='touches: app/reports/*, lib/csv.ts; follow pattern in app/reports/pdf.ts' \
  --var out_of_scope='- no new columns; no server-side generation' \
  --var verify='unit test lib/csv.ts formatting; e2e: click export → file downloads' \
  | jq -r '.steps[] | select(.id == "ticket") | .description' > /tmp/bead.md

bd create "Add CSV export button" --type task --validate --body-file /tmp/bead.md
```

**Never `--acceptance` or `--context`.** They write bd's own side fields, which splits the contract
across two places the reader has to join — and `bd show --json`, the projection most consumers read,
returns only `description`. `--context` is the worse of the two: verified on bd 1.1.2, it *appends*
a trailing `## Context` to the description, landing it after `## Verify` and inverting the formula's
order for every downstream reader.

`--validate` gates the **rubric heading only** — `## Acceptance Criteria` on a task/bug/feature,
`## Success Criteria` on an epic. Verified on bd 1.1.2: a body of nothing but that heading is
accepted, and so is a cooked skeleton whose every var is still `TODO — …`. Put it on every
`bd create` — it costs nothing and it is what makes the heading spelling un-revertable — but never
read a green `--validate` as a filled contract. The other four sections, and a rubric still holding
the formula's prompt, are yours to fill here; `/shape`, `/scan-triage` and anton's contract gate
catch them later, at approve time, where the fix costs a round trip.

Then label and link (below). Run `bd lint <id>` too — it re-checks Acceptance Criteria (`task`,
`bug`, `feature`) / Success Criteria (`epic`) after the fact, which is what covers the `--graph`
path `--validate` does not reach. `/shape` and `/scan-triage` enforce the rest of the contract.

## Epic → feature → tickets — create the tree in ONE call

**Write the whole tree as a graph plan and create it with `bd create --graph`.** A tree built by N
sequential `bd create` + `bd link` calls fails halfway — a quoting error on ticket 9 of 21 leaves an
epic and eight beads on the board, and the retry renumbers around the orphans. One plan file is
reviewable *before* it is written, `--dry-run`-able, and atomic:

```bash
cat > /tmp/plan.json <<'EOF'
{
  "nodes": [
    {"key": "e", "title": "Reports are shareable outside the app", "type": "epic",
     "labels": ["area:reports"],
     "description": "## Goal\nReports leave the app in a format customers open.\n\n## Success Criteria\n- [ ] every report view exports"},

    {"key": "f", "title": "CSV export", "type": "feature", "parent_key": "e",
     "labels": ["domain:eng", "risk:low", "size:S"],
     "description": "## Goal\n…\n\n## Acceptance Criteria\n- [ ] …\n\n## Context\ntouches: …\n\n## Out of scope\n- …\n\n## Verify\n- …"},

    {"key": "t1", "title": "Add export button", "type": "task", "parent_key": "f",
     "labels": ["domain:eng"], "description": "## Goal\n…\n\n## Acceptance Criteria\n- [ ] …\n\n## Context\n…\n\n## Out of scope\n- …\n\n## Verify\n- …"},
    {"key": "t2", "title": "Wire the endpoint", "type": "task", "parent_key": "f",
     "description": "…"}
  ],
  "edges": [{"from_key": "t2", "to_key": "t1", "type": "blocks"}]
}
EOF

bd create --graph /tmp/plan.json --dry-run   # read the tree back BEFORE writing it
bd create --graph /tmp/plan.json             # prints key → real id for every node
bd lint                                      # the rubric check --validate can't do here (see below)
```

The plan schema, verified on bd 1.1.2 — **unknown fields are dropped with only a warning**, so read
the warnings:

- node: `key` (plan-local handle), `title`, `type`, `parent_key` (another node) or `parent_id` (an
  existing bead), `description`, `labels`, `priority`, `assignee`, `metadata`.
- edge: `from_key`/`from_id`, `to_key`/`to_id`, `type` (`blocks`, `related`, `discovered-from`).
- **A node has no acceptance field, and none is needed** — the description carries the rubric here
  exactly as it does on the single-create path above. Spell the heading **`## Acceptance Criteria`**;
  that is the one spelling both `bd lint` and anton's contract read, and bare `## Acceptance`
  satisfies anton while failing `bd lint`.

**`--validate` does not reach the `--graph` path** (verified on bd 1.1.2: a node whose description
carries only `## Acceptance` is created without complaint, `--validate` or not). That makes the two
checks in the block above non-optional here — `--dry-run` to read the tree back, and `bd lint`
afterwards, the only thing that catches a missing rubric on a graph-created bead.

Parentage rides `parent_key`; there is no `bd link` step, and no shell variable to lose.

### If you are creating beads one at a time anyway

```bash
FEAT_ID=$(bd create "CSV export" --type feature --validate --body-file body.md --silent)
bd create "Add export button" --type task --validate --body-file t1.md --parent "$FEAT_ID"
```

- `--silent` prints only the id — that is how you capture one. Don't parse the human output.
- **Never put a heredoc inside command substitution.** `ID=$(bd create … <<'EOF' … EOF)` is a real
  bash/zsh parser trap, and an apostrophe in the body is enough to detonate it. Write the body to a
  file and pass `--body-file`, or use `--graph`.
- `bd create --parent <id>` sets parentage at create time; `bd update <id> --parent <id>` reparents
  later (empty string detaches). `bd link … --type parent-child` is the old two-step form.

### A creation run that aborted halfway

Before retrying, **list what landed and clean it up** — otherwise the retry renumbers around the
orphans and you get an empty duplicate of the tree you meant to build:

```bash
bd list --status all --json --limit 0 | jq -r '.[] | select(.created_at > "<when you started>") | "\(.id) \(.issue_type) \(.title)"'
bd delete <orphan-id>          # or `bd close <id>` if it is real work you'll keep
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
bd create "Add export button" --type task --validate --body-file t1.md \
  --labels domain:eng,risk:low,agent:nextjs,size:S
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

## Verify the tiers — `bd children` cannot

`bd children <epic-id>` prints **titles**. Not types, not child counts. A board of fifteen features
with no tickets under them and a task hung off the epic renders there as a perfectly healthy tree,
which is exactly how that board gets shipped. Never treat it as a structural check.

Two commands that do check:

```bash
anton board-check                # every violation of the five invariants; non-zero exit = a dead bead
bd list --status all --json --limit 0 \
  | jq -r '.[] | select(.status != "closed") | "\(.id)\t\(.issue_type)\tparent=\(.parent // "-")"'
```

The second is the **type audit** — one line per bead carrying its tier and its parent. Print it and
read it before telling anyone the tree is right; `anton board-check` then judges the same board
mechanically. It runs in any repo anton is installed for — it reads the board through `bd`, not
through an anton checkout. If `anton` isn't on PATH at all, the jq line plus the five invariants is
the manual equivalent.

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
beads that are `open`, carry `approved`, have no assignee, and are **not labelled `agent:human`**.

**Human work is excluded, and it is not a bug that it sits there.** `agent:human` marks a bead no
agent can complete end to end — it needs a credential, an account, a purchase, a signature, or a
taste call. Every other `agent:` value resolves to a specialist prompt; `human` resolves to none, so
a human bead left in the set would dispatch to the DEFAULT agent and burn a run failing at work no
agent can do. It is approved, real, and waiting for a person — not backlog, not unshaped.

The exclusion belongs to this narrowing step, **not** to the pool query: bd's own `--exclude-label`
flag would move it into the argv and drift from the one flag set every worker and anton share.
Whatever holds the board already reads it for parentage, so the label costs nothing to check here.

Rank what survives — the order is total and deterministic, so two machines agree on what is next:

1. **priority**, P0 first (a bead with none sorts last);
2. then **unblocking value** — how many open beads it transitively unblocks via `blocks` edges, most
   first;
3. then **age**, oldest `created_at` first;
4. then **id**, which is what makes the order total.

### 2. Claim, then prove the claim held

On an **embedded** board a claim rides eventually-consistent Dolt sync, so *writing* a claim is not
*holding* one. Run the whole sequence, in order, for the top-ranked target:

```bash
bd dolt pull                                 # 1. embedded only: see a claim another machine already published
BEADS_ACTOR="$ACTOR" bd update <id> --claim  # 2. bd's atomic local CAS — refuses a bead someone else holds
bd dolt commit && bd dolt push               # 3. embedded only: publish; a claim nobody else can see is not a claim
sleep 2                                      # 4. embedded only: settle — let a near-simultaneous rival reach the remote
bd dolt pull                                 # 5. embedded only: re-read after the merge has picked a winner
bd show <id> --json                          # 6. assert assignee == "$ACTOR"
bd list --status all --json --limit 0        # 7. re-apply §1 to the target you now hold
```

**On a shared-server board, run steps 2, 6 and 7 only.** Read the mode before you start — `dolt_mode`
in `.beads/metadata.json`; absent or unreadable means embedded. When every worker writes the one
`dolt sql-server` there is nothing to reconcile: the claim is visible to everybody the moment bd
commits it, so the settle window buys nothing — and the sync steps don't merely waste time, they
fail. `bd dolt pull/push` executes ON the server, which cannot reach the git remote
(`Error 1105 (HY000): command denied to user`). anton's own runtime skips them for the same reason
(`runDoltSync`, `claimVerified` — DESIGN.md §3a).

Steps 6 and 7 are what make the claim trustworthy — winning the assignee proves the race, not that
the prize is still worth having. Four outcomes, and only the first licenses a run:

- **assignee is you, and §1 still holds** → you hold it; run it.
- **assignee is someone else** → you lost the race. Back off *without writing anything* and move to
  the next target. Losing is the protocol working, not an error.
- **assignee is you, but the target left the claimable set** — closed, `abandoned`, no longer
  `approved`, or now a container epic (a `feature` landed under it while you settled) → do not run
  it. Hand the claim back (`bd assign <id> ""`) and move on; a retry can only reach the same verdict.
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
- Don't build a tree with N sequential `bd create`/`bd link` calls when `bd create --graph` writes it
  in one, and never nest a heredoc inside `$( )`.
- Don't split the contract across bd's side fields — no `--acceptance`, no `--context`. The cooked
  description carries all five sections, and `--context` appends its own out-of-order copy.
- Don't call `bd children` a verification. It shows titles; the tiers are what you're checking.
