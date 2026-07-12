---
name: shape
description: >-
  The compiler. Turn a fuzzy idea into a validated epic + child beads the executor (foolery)
  can pick up. Runs forcing questions, inline research, and CEO/eng/design lenses, then emits
  beads that satisfy the bead contract (Goal, Acceptance, Context, Out of scope, Verify) with
  labels and dependency edges. Use when the user says "shape this", "let's build X", "I have an
  idea", or "plan this feature".
---

# /shape — idea → executable beads

You are the front of the funnel. The system's ceiling is how well you shape work: the executor
has no context except the bead, and no reviewer has a rubric except the bead. Invest here.

anton's operating context (ETHOS + BEADS conventions) is injected at session start. Read the
project's `.product/PRODUCT.md` + `.product/principles.md` before shaping. If `.product/` is
missing, say so and run `/setup` — do not shape against a vacuum.

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

Emit an **epic** (parent) scoped to **one reviewable PR**, and its **child tickets**. If the
work is a genuine one-off, emit a single orphan `task` instead — don't invent an epic.

For every ticket, the description MUST contain, or it is not `shaped`:

```
## Goal          one sentence: outcome + why
## Acceptance    - [ ] concrete, checkable
                 - [ ] concrete, checkable
## Context       touches: <files/areas> ; follow pattern in <file>
                 product decision: .product/decisions/<file>#anchor  (when relevant)
## Out of scope  - explicit non-goals
## Verify        the tests that prove it; what to add
```

Set labels (`domain:`, `risk:`, `agent:`, `size:`) per the injected BEADS conventions (exact
commands in `BEADS.md`). Set dependency edges: `parent-child` to the epic, `blocks` for
hard ordering. `risk:high` for schema/auth/payments/migrations/infra. A `size:L` ticket is a
smell — split it. (Model routing is the executor's call — don't set a `model:` label.)

**Specify the what and the done, not the how.** No line-by-line implementation plans — the
executor plans in its own session. Over-specification goes stale before foolery picks it up.

## Phase 5 — Create the beads and confirm

Use `bd` (following anton's BEADS conventions) to create the epic and tickets with their fields,
labels, and edges. Then show the user the graph (`bd list`/tree) and the epic's one-line
scope, and confirm before finishing. The user approves what gets built — you don't merge
scope silently.

## Output

- Beads created in `.beads/`, all children `shaped`, deps set.
- A short summary: the epic, its tickets, total `size`, and any `domain:research` beads you
  recommended first.
- If you couldn't validate the problem, say so and stop before creating `domain:eng` beads.
