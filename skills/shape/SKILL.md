---
name: shape
version: c4e8dfb2ec1e
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

**Audit the ordering. This step is not optional either, and it is the one no checker can do for
you** — a `blocks` edge pointing the wrong way is well-formed: `bd lint` passes, `bd dep cycles`
finds nothing, and `bd create --graph` exits 0. The edge is syntactically fine and semantically
backwards, and nothing mechanical can tell the difference between "t2 blocks t1" meant and "t1
blocks t2" meant — only you, holding the intended build order, can. For every feature, print the
tickets in the order the executor will actually dispatch them (the topological order over `blocks`
edges — **not** board order, not creation order):

```bash
# Prints every feature's actual executor dispatch order. It mirrors runTickets: nearest-card membership,
# arbitrary working-layer nesting, pipeline exclusion, and Kahn ordering with source-list ties. A
# ticket held by a blocker OUTSIDE this feature (work in another run) is excluded from the numbered
# order and listed separately, mirroring runReadiness's gated partition (execute-epic-board.ts) that
# partitionTickets (execute-epic-dispatch.ts) applies before dispatch — the executor never runs a held
# ticket in this pass, so numbering it alongside the rest would claim an order nobody will observe.
# Some supported bd builds reject --status all, so merge their open and closed reads before sorting.
node -e '
const { execFileSync } = require("node:child_process");
const list = (args = []) => JSON.parse(execFileSync("bd", ["list", ...args, "--json", "--limit", "0"], { encoding: "utf8" }));
let all;
try {
  all = list(["--status", "all"]);
} catch {
  const byId = new Map();
  for (const bead of [...list(), ...list(["--status", "closed"])]) if (!byId.has(bead.id)) byId.set(bead.id, bead);
  all = [...byId.values()];
}
const parentOf = (b) => b.parent ?? b.parent_id;
const pipeline = new Set(["molecule", "gate"]);
const ticketTypes = new Set(["task", "bug", "chore", "feature"]);
const byId = new Map(all.map((b) => [b.id, b]));
const cardIds = new Set(all.filter((b) =>
  b.issue_type === "feature" ||
  (b.issue_type === "epic" && !all.some((c) => c.issue_type === "feature" && parentOf(c) === b.id)),
).map((b) => b.id));
const cardOf = (b) => {
  const seen = new Set([b.id]); let parent = parentOf(b);
  while (parent && !seen.has(parent)) {
    if (cardIds.has(parent)) return parent;
    seen.add(parent); const ancestor = byId.get(parent);
    if (ancestor && pipeline.has(ancestor.issue_type)) return undefined;
    parent = ancestor && parentOf(ancestor);
  }
};
const runTickets = (featureId) => all.filter((b) =>
  !cardIds.has(b.id) && !pipeline.has(b.issue_type) && ticketTypes.has(b.issue_type) && cardOf(b) === featureId,
);
const blockersOf = new Map();
for (const bead of all) for (const edge of bead.dependencies ?? []) {
  if (edge.type !== "blocks") continue;
  const prereqs = blockersOf.get(edge.issue_id) ?? [];
  prereqs.push(edge.depends_on_id);
  blockersOf.set(edge.issue_id, prereqs);
}
// Tickets gated by a blocker outside this feature's own set, propagated to anything inside the
// feature that depends on one of them — same shape as computeEpicGraph's blocked-children rollup
// (epic-graph.ts), simplified to "closed" for done (this audit runs on freshly shaped work, so a
// merged-but-not-closed distinction does not arise).
const heldIds = (feature, tickets) => {
  const ids = new Set(tickets.map((t) => t.id));
  const isHeld = (blockerId) => {
    if (ids.has(blockerId)) return false; // inside this feature — ordering, not a gate
    const blocker = byId.get(blockerId);
    return !blocker || blocker.status !== "closed"; // unknown or open blocker reads as held (fail-safe)
  };
  // Same short-circuit as unitHeld in runReadiness (epic-graph.ts): a `blocks` edge on the
  // feature itself gates every ticket underneath, not just the ones naming the blocker directly.
  if ((blockersOf.get(feature.id) ?? []).some(isHeld)) return ids;
  const heldByExternal = (id) => (blockersOf.get(id) ?? []).some(isHeld);
  const held = new Set(tickets.filter((t) => heldByExternal(t.id)).map((t) => t.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tickets) {
      if (held.has(t.id)) continue;
      if ((blockersOf.get(t.id) ?? []).some((id) => ids.has(id) && held.has(id))) { held.add(t.id); grew = true; }
    }
  }
  return held;
};
const orderTickets = (tickets) => {
  const ids = new Set(tickets.map((t) => t.id));
  const adj = new Map(tickets.map((t) => [t.id, []]));
  for (const bead of all) for (const edge of bead.dependencies ?? []) {
    if (edge.type === "blocks" && ids.has(edge.issue_id) && ids.has(edge.depends_on_id))
      adj.get(edge.depends_on_id).push(edge.issue_id); // blocker → dependent
  }
  const indegree = new Map(tickets.map((t) => [t.id, 0]));
  for (const dependents of adj.values()) for (const id of dependents) indegree.set(id, indegree.get(id) + 1);
  const queue = tickets.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    for (const dependent of adj.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  return order.length === tickets.length ? order.map((id) => tickets.find((t) => t.id === id)) : tickets;
};
for (const feature of all.filter((b) => b.issue_type === "feature")) {
  console.log(`feature ${feature.id}:`);
  const tickets = runTickets(feature.id);
  const held = heldIds(feature, tickets);
  const dispatchable = tickets.filter((t) => !held.has(t.id));
  for (const [index, ticket] of orderTickets(dispatchable).entries())
    console.log(`  ${index + 1}. ${ticket.id}\t${ticket.title}`);
  for (const ticket of tickets.filter((t) => held.has(t.id)))
    console.log(`  held (external blocker, not dispatched this pass): ${ticket.id}\t${ticket.title}`);
}
'
```

Then assert out loud, naming the tickets: "feature `<id>` dispatches `t1` → `t2` → `t3`; that
matches the intended build order because `t2` uses the schema `t1` builds, and `t3`'s endpoint
needs `t2`'s wiring." If you cannot name the reason each step precedes the next, you have not
audited it — you have read the list back.

**The one spelling of the edge that cannot be misread:** `bd dep add <blocked> <blocker>` — the
**LATER** ticket (the one that depends) is the first argument, the **EARLIER** ticket (the one it
depends on) is the second. Worked example: a ticket that uses a schema depends on the ticket that
builds the schema, so `bd dep add <uses-schema-ticket> <builds-schema-ticket>` — never the reverse.
Read `--graph`'s `blocks` edges the same way: `{"from_key": "t2", "to_key": "t1", "type": "blocks"}`
means `t2` depends on `t1`, so `t1` runs first.

**bd will not catch a reversed edge for you.** Verified on bd 1.1.2: a backwards `blocks` edge
creates with exit 0, `bd lint` reports it clean, and `bd dep cycles` finds nothing — the wrong
ticket simply surfaces in `bd ready` first, silently. The printed dispatch order above is the
**only** evidence you get. If it doesn't match the build order you intended, fix the edge
(`bd dep remove` the wrong one, `bd dep add` the right direction) before you confirm — never
explain the mismatch away as acceptable, because there is no mechanical check downstream that will
catch it later.

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
