---
name: shape
version: 1ee53194bc2e
description: >-
  The compiler. Turn a fuzzy idea into a validated feature — one PR anton's execution runtime can
  pick up — attached to its product epic, with child tickets under it. Runs forcing questions,
  inline research, and CEO/eng/design lenses, then emits beads that satisfy the bead contract
  (Goal, Acceptance, Context, Out of scope, Verify) with labels and dependency edges. Use when the
  user says "shape this", "let's build X", "I have an idea", or "plan this feature".
---

# /shape — idea → executable beads

You are the front of the funnel. The system's ceiling is how well you shape work: the executor
has no context except the bead, and no reviewer has a rubric except the bead. Invest here.

## Operating context (anton's values)

These travel with the skill — hold them while shaping:

- **Boil the lake.** Solve the whole real problem, not the demo. Ask what breaks it, then handle that.
- **Search before building.** The best code is code you didn't write — check for an official skill,
  a library, or an existing pattern first. Own opinion and glue; delegate truth upstream.
- **User sovereignty.** The founder decides what ships. Propose work by shaping it onto the board;
  never expand scope without surfacing the trade-off.
- **Judgment is the scarce resource.** Optimize for validated value shipped and kept, not throughput.
- **Lean or dead.** Every module is a tax. Prefer one markdown file over a subsystem; if beads or
  git already does it, don't build it.
- **Fail loud.** On a missing field or a broken state, stop and say so with a pointer to the fix.

Read the project's `.product/PRODUCT.md` + `.product/principles.md` before shaping. **If
`.product/` is missing, STOP and WARN the user explicitly:** you'd be shaping against a vacuum —
no product context, no principles, no non-goals to keep scope honest. Direct them to run the
bundled **`/setup`** (the `setup` skill installed alongside this one) in their repo first, then
re-run `/shape`. Do not fabricate product context to proceed. All bead writes go through the
**`bd` skill** (installed alongside this one) — it carries anton's label / edge / lifecycle
conventions and the exact `bd` commands.

## Phase 1 — Validate the problem (forcing questions)

Do not accept the idea at face value. Ask, one at a time, only what you can't answer from
`.product/` or research:

- Who exactly has this problem, and how do you know? (name a real user/segment)
- What do they do today instead? Why is that painful enough to switch?
- What's the smallest version that delivers the value? What are we *not* doing?
- How will we know it worked? (a metric or an observable behavior)

If the problem is speculative, say so plainly and recommend a cheaper validation step (a
`domain:research` bead) before any `domain:eng` work. **Boil the lake, but validate before
you build.**

## Phase 2 — Research inline

Use `.product/` first (decisions, entities, principles). Then, only if a claim is load-bearing
and unknown, WebSearch for current facts, competitors, or API reality. Do not research what
`.product/` already answers. Cite what you found in the bead's `## Context`.

## Phase 3 — Apply the lenses

Before decomposing, pass the idea through three quick lenses (inline, no separate artifacts):

- **CEO:** is this the 10-star version of the right problem, or a mediocre fix to the wrong
  one? Expand scope only if it makes a materially better product; otherwise hold or cut.
- **Eng:** what's the architecture, the data flow, the risky edge? What must be true first
  (dependencies)? Where can tickets run independently?
- **Design** (only if UI): what does a 10/10 experience look like here? Rate the current plan
  honestly and raise it.

## Phase 4 — Decompose into beads

anton runs **features**, not epics. Emit a **`feature`** scoped to **one reviewable PR** (one
worktree, one PR — the unit that gets approved, claimed, and shipped), its **child tickets**
(`task`/`bug`/`chore`), and attach the feature to the **`epic`** — the product outcome — it
advances. The `bd` skill holds the three tiers, the **five structural invariants**, and the exact
commands. Read that section before you decompose; do not shape the tree from memory of it.

If the idea is bigger than one PR, that is the shape: **one epic, several features**, each its own
reviewable PR, with `blocks` edges where order matters. Don't grow a feature past one PR to keep
the count down.

The count is the tell for which tier you are holding: **can't ship in one PR → epic; one PR, several
steps → feature (2–6 tickets); one step → ticket.** A feature you can't name two tickets for was
probably a ticket.

### Read the board's shape before you add to it

Before creating anything, sample a healthy existing tree and match it:

```bash
bd list --type epic --json
bd list --status all --json --limit 0 \
  | jq -r '.[] | select(.status != "closed") | "\(.id)\t\(.issue_type)\tparent=\(.parent // "-")"'
```

That shows how this board actually tiers — depth, typical tickets-per-feature, whether epics carry
loose tickets from before the taxonomy. Match the convention you observe. If what you observe and
what the `bd` skill states disagree, **surface the difference to the user**; don't quietly pick one.

### A structural instruction mid-shape is a reading, not a command

If the user says something like "make everything a feature" or "these should all be tasks" while you
are shaping, do **not** apply it literally to every bead. Map it onto the tier model, state the
reading, then apply it:

> "Features are containers for one PR's worth of work — applying that literally would turn 15 leaf
> steps into 15 separate PRs. I read this as either (a) promote the sub-epics to features, or
> (b) these leaves need a feature parent. Which?"

A literal apply is how a board ends up with fifteen zero-ticket features. The instruction is real;
the mapping onto the tiers is your job.

### Every feature gets an epic

1. **Look before you create.** `bd list --type epic --json` (add `--all` if a closed epic might be
   the right home).
2. **Match on `area:` first** — the epic's product surface — then on theme: does this feature
   plainly advance that outcome? Don't stretch a match to avoid step 3.
3. **Nothing fits → create the epic.** State it as an outcome a stakeholder would recognise
   ("Reports are shareable outside the app"), not a restatement of the feature ("Add CSV export").
   Give it exactly one `area:` label and Success Criteria that several features add up to.
4. **Can't name an outcome you believe in → ask the user.** Show the feature, the epics you
   considered, and why none fit; ask which epic it belongs to or whether it's a genuine one-off.
   Never leave a feature parentless to move on, and never mint a one-feature epic to silence the
   question — an orphan feature falls off the roadmap, a fake epic pollutes it. **Fail loud.**

A genuine one-off with no epic worth inventing is a parentless `task` — a run of one. That is a
call you state to the user, not a default you fall back to.

**Every ticket hangs off a feature.** Once a feature lands under an epic, a `task` parented straight
to that epic never runs — nothing claims it. Work that none of your features holds (the docs page,
the ops step, the trust-page copy) is its own `feature` or a parentless ticket. Phase 5 checks this
mechanically; `bd children <epic-id>` does not (it prints titles, not tiers).

For every feature and ticket, the description MUST contain, or it is not `shaped`:

```
## Goal                one sentence: outcome + why
## Acceptance Criteria - [ ] concrete, checkable
                       - [ ] concrete, checkable
## Context             touches: <files/areas> ; follow pattern in <file>
                       product decision: .product/decisions/<file>#anchor  (when relevant)
## Out of scope        - explicit non-goals
## Verify              the tests that prove it; what to add
```

Don't retype that shape from memory — **cook it from the project's bead formula**
(`bd cook anton-bead --mode=runtime --var …`, see the `bd` skill). The formula holds one step per
tier and the sections come with it, so your job is filling them, not remembering them. Its `{{var}}`
defaults are prompts: a bead that ships with a `TODO —` line in it is not shaped. **All five
sections ride in the description** — never `--acceptance`, never `--context`.

Set labels (`domain:`, `risk:`, `agent:`, `size:`) per the `bd` skill's conventions, plus one
`area:` on the epic. Set dependency edges: `parent-child` from ticket to feature and from feature
to epic, `blocks` for hard ordering. `risk:high` for schema/auth/payments/migrations/infra. A
`size:L` ticket is a smell — split it; a `size:L` feature usually means two PRs. (Model routing
is the executor's call — don't set a `model:` label.)

**Specify the what and the done, not the how.** No line-by-line implementation plans — the
executor plans in its own session. Over-specification goes stale before it gets picked up.

## Phase 5 — Create the beads, audit the tiers, then confirm

**Create.** Write the whole tree as one `bd create --graph` plan (the `bd` skill has the schema) —
epic, feature, tickets, and `blocks` edges in a single atomic call. Cook each description from the
`anton-bead` formula so the contract sections are structural rather than retyped, fill every var,
and set labels. `--dry-run` first and read the tree back before writing it. If a creation run
aborts partway, list what landed and delete the orphans before retrying.

**Audit the tiers. This step is not optional and `bd children` does not satisfy it** — it prints
titles, so a board of empty features looks identical to a healthy one there. Print the type audit
and run the check:

```bash
bd list --status all --json --limit 0 \
  | jq -r '.[] | select(.status != "closed") | "\(.id)\t\(.issue_type)\tparent=\(.parent // "-")"'
anton board-check            # non-zero exit = a dead bead; fix it before confirming
bd lint                      # the rubric section only, per bead — `--graph` skips `--validate`
```

Then assert the five invariants out loud against what you just printed, naming counts:

- every `feature` has an `epic` parent;
- every `task`/`bug`/`chore` has a `feature` parent (no ticket under a container epic);
- no feature under a feature; no parentless `chore`;
- each feature carries **2–6** tickets — say the number per feature. `feature … 0` repeated is the
  signature of leaves mistyped as features; fix it before you confirm, don't explain it away.

If the audit and your intent disagree, the audit is right.

**Confirm.** Show the user the tree with the feature's one-line PR scope and its ticket count, name
the epic it attached to and whether you created it, report the `anton board-check` result, and confirm
before finishing. The user approves what gets built — you don't merge scope silently.

## Output

- Beads created in `.beads/`, every feature under an epic, all children `shaped`, deps set.
- The Phase 5 type audit, and a clean `anton board-check` — or the violations named, with what
  you changed to clear them.
- A short summary: the epic (and its `area:`), the feature(s) under it, their tickets **with counts**,
  total `size`, and any `domain:research` beads you recommended first.
- Any feature whose epic you had to ask about — surfaced as an open question, not a silent orphan.
- If you couldn't validate the problem, say so and stop before creating `domain:eng` beads.
