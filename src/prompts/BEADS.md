# BEADS — conventions

How loom writes to [beads](https://github.com/gastownhall/beads). beads holds all work state as
JSONL in `.beads/`, versioned by git. loom is the **producer** — it creates and links
contract-shaped beads; the executor (foolery) claims, dispatches, reviews, and closes them.
Everything below is convention. All `bd` calls go through the `bd` skill.

## Issue types

- `epic` — a coherent, shippable increment. Parent of tickets.
- `task` — a unit of work; a child of an epic, or an orphan.
- `bug` — a defect (often from `/scan-triage`); reproduced before a fix.
- `learning` — a captured correction/insight (usually prefer `.product/learnings.md`; a bead
  only when it needs a dependency edge).

## Labels

`/shape` and `/scan-triage` set these; foolery reads them to route execution.

| Label | Values | Meaning |
|-------|--------|---------|
| `domain:` | `eng`, `marketing`, `bizdev`, `research`, `ops` | cross-domain classification |
| `risk:` | `low`, `high` | `high` = security / schema / auth / payments / migrations / infra |
| `agent:` | `nextjs`, `supabase`, `fastapi`, `pydantic`, `alembic`, or omitted | which specialist fits |
| `size:` | `S`, `M`, `L` | sanity check; `L` on a ticket is a smell — split it |
| `source:` | `stringer`, or omitted | provenance; scan beads also carry `stringer:<collector>:<hash>` for dedup |

(Model routing is the executor's concern — loom does not set a `model:` label.)

## Dependency edges

beads gives four; use them deliberately:

- `parent-child` — epic → its tickets.
- `blocks` — hard ordering. A blocked ticket never appears in `bd ready`.
- `related` — soft context link; no ordering effect.
- `discovered-from` — provenance for work found mid-task.

## Lifecycle

```
loom produces:   stub  → shaped → (ready when deps clear)
foolery drives:  ready → in-progress → review → done   (and park/unpark on failure)
```

- `stub` — idea captured, not yet contract-complete. A `/shape` backlog item.
- `shaped` — has Goal + Acceptance + Context + Out-of-scope + Verify + labels.
- `ready` — shaped and unblocked; what `bd ready` returns. **loom's output ends here** — foolery
  takes it from `ready`.

## The bead contract

A ticket is not `shaped` until its description contains `## Goal`, `## Acceptance` (checkable
boxes), `## Context`, `## Out of scope`, `## Verify`. Without these the executor has no spec.
`/shape` and `/scan-triage` enforce it; `bd lint` checks the Acceptance/Success sections.

## Cross-domain

Marketing/bizdev/research tasks are first-class beads (`domain:marketing`, etc.) with the same
contract. But their **entities** (a customer, competitor, content calendar) live in
`.product/entities/`, never as beads. Beads track work; markdown tracks knowledge.
