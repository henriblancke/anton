# Beads Workflow Context — anton

> This file **replaces** `bd prime`'s default output for this repo (`.beads/PRIME.md`, honoured on
> bd 1.1.0 and 1.1.2). It replaces it in *every* mode, including `--memories-only` — so persistent
> memories are injected by a second call, `bd prime --export --memories-only`. For bd's stock
> reference: `bd prime --export`.

The board is this project's work queue, shared across machines. Everything below is the protocol a
worker must follow to take work from it — no anton runtime required.

## 1. The claimable set — never bare `bd ready`

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
- No `--type`: bd's `-t/--type` takes ONE type, and the claimable set spans three shapes.

Narrow that pool to **run targets** against one full board read
(`bd list --status all --json --limit 0`, which carries parentage and `blocks` edges):

> A bead is a run target if it is a `feature`, **or** a parentless `task`/`bug`, **or** an `epic`
> with no `feature` children.

Keep only run targets that are `open`, carry `approved`, and have no assignee. Then rank — the order
is total and deterministic, so two machines agree on what is next:

1. **priority**, P0 first (a bead with none sorts last);
2. then **unblocking value** — how many open beads it transitively unblocks via `blocks` edges, most
   first;
3. then **age**, oldest `created_at` first;
4. then **id**, which is what makes the order total.

## 2. Claim, then prove the claim held

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

## 3. Claiming a feature reserves its children

`bd ready --unassigned` filters on each **ticket's** own assignee, so a running feature keeps serving
its children to every other worker until they are reserved. After winning a feature, reserve each
open, non-abandoned child for the same actor:

```bash
bd assign <child-id> "$ACTOR"     # reservation, NOT a claim
bd assign <child-id> ""           # hand back, on release / park / abandon
```

`bd assign`, never `bd update --claim`: assignment leaves the child `open` (still backlog) while the
run's own per-ticket claim stays the one thing that marks a ticket in flight. Leave alone — and
report — any child a different actor already holds; hand back only children still assigned to you.

## 4. Executing what you claimed

- One target = one worktree = one PR. Children run inside their feature's run, in `blocks` order.
- `bd show <id>` first: Goal / Context / Acceptance / Out of scope / Verify are the spec. A bead
  missing them is not ready to run — say so rather than guessing.
- Close only what you delivered: `bd close <id1> <id2> …` (batch; `--reason` when it needs one).
- Record durable, non-obvious findings with `bd remember "<insight>"`. Search with
  `bd memories <keyword>`; update in place with `bd remember --key <key> "…"`.

## Core rules

- Use `bd` for ALL task tracking. Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- Use `bd remember` for persistent knowledge. Do NOT create MEMORY.md files.
- Never `bd edit` — it opens `$EDITOR` and blocks agents. Use `bd update <id> --title/--description/
  --notes/--design`.
- Priorities are `0-4` / `P0-P4` (0 = critical), never "high"/"medium"/"low".
- Issues live in a local Dolt DB; sync rides `refs/dolt/data` on the git remote; `.beads/issues.jsonl`
  is a passive export — never the source of truth, never committed.
- Board conventions (tiers, labels, edges, the bead contract) live in `skills/bd/SKILL.md`.

## Session close protocol

Before saying "done": close the finished beads, file follow-up work as new beads, run the quality
gates for anything you changed (`bun run test`, `bun run lint`, `bun run typecheck`), then
`git pull --rebase && git push`. Work is not complete until the push succeeds.

**Inside anton's autonomous executor this is different**: anton owns the commit, the push, the PR,
and the bead lifecycle. Implement the ticket, leave the checks green, and let anton close it — do
not commit, push, or move bead state yourself.
