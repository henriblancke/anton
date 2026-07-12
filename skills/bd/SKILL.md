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

## Issue types

- `epic` — a coherent, shippable increment. Parent of tickets.
- `task` — a unit of work; a child of an epic, or an orphan.
- `bug` — a defect (often from `/scan-triage`); reproduced before a fix.
- `learning` — a captured correction/insight (usually prefer `.product/learnings.md`; a bead
  only when it needs a dependency edge).

## Labels

`/shape` and `/scan-triage` set these; anton's execution runtime reads them to route execution.

| Label     | Values                                                     | Meaning |
|-----------|------------------------------------------------------------|---------|
| `domain:` | `eng`, `marketing`, `bizdev`, `research`, `ops`            | cross-domain classification |
| `risk:`   | `low`, `high`                                              | `high` = security / schema / auth / payments / migrations / infra |
| `agent:`  | `nextjs`, `supabase`, `fastapi`, `pydantic`, `alembic`, … or omitted | which specialist fits |
| `size:`   | `S`, `M`, `L`                                              | sanity check; `L` on a ticket is a smell — split it |
| `source:` | `stringer`, or omitted                                     | provenance; scan beads also carry `stringer:<collector>:<hash>` for dedup |

(Model routing is the executor's concern — shaping does not set a `model:` label.)

## Dependency edges

beads gives four; use them deliberately:

- `parent-child` — epic → its tickets.
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

A ticket is not `shaped` until its description contains `## Goal`, `## Acceptance` (checkable
boxes), `## Context`, `## Out of scope`, `## Verify`. Without these the executor has no spec.
`/shape` and `/scan-triage` enforce it; `bd lint` checks the Acceptance/Success sections.

## Create a shaped ticket

Map the bead contract to native fields; put `Goal`, `Out of scope`, and `Verify` in the
description (markdown), Acceptance and Context in their own fields:

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

Then label and link (below). Run `bd lint <id>` — it enforces Acceptance (task) / Success
Criteria (epic); `/shape` and `/scan-triage` enforce the rest of the contract.

## Epic + children

```bash
bd create "CSV export" --type epic --acceptance $'- [ ] users can export every report view'
# → EPIC_ID
bd create "Add export button" --type task ...           # → T1
bd link "$T1" "$EPIC_ID" --type parent-child             # T1 is child of EPIC
```

## Labels

```bash
bd tag <id> domain:eng risk:low agent:nextjs size:S
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
bd list --json                          # existing beads (dedupe /scan-triage against these)
bd ready --json                         # what the executor would consider claimable
bd show <id>
```

## Not shaping's job (the execution runtime owns these)

Claiming, dispatching, worktrees, review/scoring, merges, park/unpark, and coordination are the
**executor's** responsibility. Shaping never claims, closes, or merges beads — it only creates
and links them.

## Cross-domain

Marketing/bizdev/research tasks are first-class beads (`domain:marketing`, etc.) with the same
contract. But their **entities** (a customer, competitor, content calendar) live in
`.product/entities/`, never as beads. Beads track work; markdown tracks knowledge.

## Don't

- Don't shell out to `bd` from anywhere except through these forms.
- Don't store business entities (customers, deals, content) as beads — those are markdown in
  `.product/entities/`.
- Don't invent statuses; use `bd statuses` to see valid ones.
