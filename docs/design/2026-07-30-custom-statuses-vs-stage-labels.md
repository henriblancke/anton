# Decision: custom bd statuses vs `stage:*` labels (anton-pztl)

**Date:** 2026-07-30 · **Ticket:** anton-pztl · **Result:** ❌ KEEP LABELS — do not move the stage
model onto bd custom statuses.

Every claim below was reproduced hands-on against **bd 1.1.2 (installed)**, and the load-bearing
ones against **bd 1.1.0 (anton's floor, `~/.local/bin/bd.1.1.0.bak`)** — no finding differed
between them. Harness: a throwaway workspace in `/tmp/pztl-probe` plus a second clone wired to a
`file:///tmp/pztl-remote` Dolt remote, so real divergent-write merges could be exercised (not
reasoned about). See the appendix for the exact commands.

## The call

**Keep `stage:implementing` / `stage:in-review` labels + `deriveStage()` as the stage model.**
Custom statuses lose on every axis the ticket asked about:

| Axis | Custom statuses | `stage:*` labels (today) |
| --- | --- | --- |
| `bd ready` single authority | **Broken promise** — even `active`-category custom statuses are excluded from `bd ready` (1.1.0 and 1.1.2) | Already reimplemented in `epic-graph.ts`/`board.ts`; nothing lost |
| Dolt sync merge | **Divergent status writes hard-wedge sync** — `merge aborted`, operator resolution required | Divergent label writes merge clean (set-union) |
| Gates / `hooked` | One-dimensional: a bead has exactly one status | Multi-dimensional: stage + `approved` + `abandoned` + PR ref coexist |
| Migration cost | 31 files / 165 refs touch stage machinery; per-project config seeding; historical bead rewrite | Zero |

**Trigger condition for revisiting** (all three, not any one):

1. Upstream bd makes `active`-category custom statuses actually appear in `bd ready` (today the
   documented contract in `bd statuses --help` does not hold).
2. Dolt-side status merges stop wedging sync — either bd auto-resolves `issues`-table cell
   conflicts (e.g. last-write-wins on `status`) or anton serializes every status write through a
   single machine (the run-lease already does this for *runs*, but claim routes, review-fix sweeps
   and human `bd update` do not go through it).
3. The board needs a stage that bd's readiness must natively exclude (e.g. a future stage that
   should hide work from `bd ready --claim` agents) — the only capability labels genuinely lack.

If bd fixes (1) and (2) upstream, re-run the appendix harness before switching; the harness is the
acceptance test.

## Evidence

### 1. `bd ready` does not honor visibility categories — the core pitch is dead on arrival

The pitch was "statuses could restore `bd ready` as the single authority" for readiness. The
documented contract (`bd statuses --help`):

```
active  — appears in 'bd ready' and default 'bd list'
wip     — excluded from 'bd ready', visible in default 'bd list'
done    — excluded from 'bd ready' and default 'bd list'
frozen  — excluded from 'bd ready' and default 'bd list'
```

Observed, with `status.custom = "in_review:wip,qa:active,on_hold:frozen"` and a bead in each of
`qa` (active), `in_review` (wip), `open` (control):

```
$ bd ready                 # also: bd ready --explain, bd list --ready
○ pztl-50c ● P2 bead-C control open      <-- ONLY the built-in `open` bead
```

The `qa` bead — category **active** — is excluded. Readiness is effectively `status == open`.
Reproduced identically on the 1.1.0 floor binary against the same board. So even after a full
migration, anton would still have to reimplement readiness exactly as `epic-graph.ts` and
`board.ts` do today; the single-authority payoff does not exist. (`bd list --status=qa` does
filter correctly; only the ready path ignores the category.)

### 2. Dolt sync: status cells hard-conflict; labels merge clean

Two clones of the same board via a `file://` Dolt remote, writing without pulling first — exactly
the anton topology (multiple worktrees/machines + a human, one shared `refs/dolt/data`).

**Status divergence** — clone1 `bd update X -s open` (pushed), clone2 `bd update X -s in_review`,
then `bd dolt pull` on clone2:

```
Error: merge origin/main: merge conflicts in issues require operator resolution; merge aborted and working set restored
```

The pull aborts **entirely** — not just for that bead. The clone can no longer sync anything until
an operator resolves; in anton this is a sync-engine beat failing forever and a permanently stale
board. This hazard already exists today for the built-in statuses anton writes (`--claim` →
`in_progress`, `bd close` → `closed`), but those are written once per ticket under the run-lease.
Moving stage onto statuses multiplies the concurrent-write surface: every
implementing→in-review transition, every review-fix sweep (which runs on whichever machine holds
the sweep), every human correction becomes a potential board-wide sync wedge.

**Label divergence** — same shape: clone1 `--remove-label review:done --add-label review:a`
(pushed), clone2 `--remove-label review:done --add-label review:b`, pull:

```
Pull complete.
{"id":"pztl-7fy","labels":["review:a","review:b"]}
```

Labels are rows, so Dolt merges them as a set: sync **never wedges**. The cost is a soft anomaly —
the dimension ends up double-valued. That is a real (pre-existing) weakness of the label model:
anton's `labelValue()` picks first-match, so a racing stage write can read either value until the
next transition rewrites the prefix. But "briefly ambiguous stage on one bead" degrades a view;
"merge aborted" halts sync for the whole project. The label model's failure mode is strictly
cheaper.

Also verified: `status.custom` config lives **in the Dolt DB** (not `.beads/config.yaml`), so it
does sync to fresh clones via `bd bootstrap` — config skew between machines is *not* a risk, and
a bead holding a custom status is readable on a clone regardless. Status values are validated on
write (`bd update -s bogus` → error listing built-ins + pointer to `status.custom`).

### 3. Gates and `hooked`: statuses are one-dimensional, anton's state is not

- `hooked` is a **built-in** status (`[wip]`, "Attached to an agent's hook"), excluded from
  `bd ready` like the rest of the wip category.
- A gate does **not** set `hooked`: `bd gate create --type=human --blocks X` leaves X `open` and
  unready via blocker semantics (confirmed; matches the anton-upfc spike's gate findings).
  `hooked` belongs to the mol/agent-hook machinery, not gates.

The structural problem: a bead has exactly **one** status. anton's board state is a product of
independent dimensions — stage × `approved` × `abandoned` × `deferred` × PR ref — and bd itself
holds `blocked`/`deferred`/`hooked`/`pinned` in the same single slot. A gated-while-in-review bead,
or a future `hooked` executor bead that is also `stage:in-review`, forces a precedence fight over
one field. bd's own answer for multi-dimensional operational state is **`set-state` labels**
(`patrol:active`, `mode:degraded`, `health:failing`) — i.e. bd itself uses anton's label pattern,
not statuses, for exactly this shape of problem.

### 4. `bd set-state` (the NOTES asked explicitly): validates the label model, not a switch target

`bd set-state <id> stage=implementing --reason "…"` does atomically what `bd.ts`'s prefix-diff
patch does by hand — removes the dimension's old label, adds the new one — **plus** creates a
closed child bead of `issue_type: event` as an audit trail (`pztl-7fy.1 · State change: review →
fixing`). `bd state <id> <dim>` reads **the label**, not the event log — so even bd treats the
label as the queryable truth and events as history. Event inserts are new uniquely-id'd rows, so
they merge clean under Dolt.

Two adoption blockers found:

1. **Event beads leak into anton's board read.** `bd list --status all --json` — the exact
   whole-board call in `issues.ts`, `execute-epic.ts`, `review-fix.ts`, `abandon.ts` — returns
   them (`{"id":"pztl-7fy.1","issue_type":"event","status":"closed"}`). `issueTypeOf()` maps the
   unknown `event` type to its `epic` fallback, and as child beads they'd flow into
   `runTickets`-adjacent machinery. Adopting set-state requires filtering `issue_type === "event"`
   at the list seam first.
2. It emits one extra bead per transition — cheap per run, but unbounded board growth with
   compaction disabled (`compaction_enabled = false` on anton's board today).

**Verdict on set-state:** not now. If an audit trail for stage transitions ever becomes a product
requirement, route the existing label writes through `bd set-state stage=…` (reads are already
compatible — it produces the very `stage:<value>` labels `deriveStage` consumes) after adding the
event-type filter. That is an incremental, reversible step — unlike a status migration.

### 5. Migration cost (had the call gone the other way)

- **Code:** 31 files / 165 references touch `deriveStage` / `LABELS.stage` / literal stage labels
  (14 non-test files / 62 refs): `ticket-view.ts`, `bd.ts` (patch machinery, abandon path),
  `execute-epic.ts` (~8 lifecycle sites), `review-fix.ts` (sweep selection + finalization),
  `pr-link.ts`, claim/approve/pr routes, plus 17 test files.
- **Semantics that don't map:** `deriveStage` is a *derivation* with precedence (`closed` → done;
  `in-review` label **or PR ref** → in-review; `in_progress` **or** label → implementing). A
  status is a stored fact; the PR-ref disjunct and the label-as-resume-marker semantics
  (`execute-epic.ts` step 2/step 8) would need explicit transition writes at every site that today
  gets stage for free from other state.
- **Data:** every existing board needs a one-time rewrite (label → status) plus
  `status.custom` seeding per project DB; partial rollout means every reader handles both models.
- **Interop:** custom statuses render with generic icons and are absent from the status legend of
  plain `bd list`; every non-anton consumer of the board (humans running `bd`, loom, foolery)
  must learn the vocabulary. Labels are already the shared convention (`bd set-state` itself
  emits them).

None of this is prohibitive on its own; it is pure cost attached to the negative payoff
established in §1–§3.

## Appendix: reproduction harness

```sh
# workspace + custom statuses
rm -rf /tmp/pztl-probe && mkdir -p /tmp/pztl-probe && cd /tmp/pztl-probe
git init -q && BD_NON_INTERACTIVE=1 bd init --prefix pztl --non-interactive
bd config set status.custom "in_review:wip,qa:active,on_hold:frozen"
A=$(bd create "bead-A custom wip" --json | jq -r .id)
B=$(bd create "bead-B custom active" --json | jq -r .id)
C=$(bd create "bead-C control open" --json | jq -r .id)
bd update $A -s in_review && bd update $B -s qa
bd ready            # <-- only $C; $B (active) missing. Same on bd 1.1.0.

# set-state
bd set-state $B review=fixing --reason "probe"   # -> event $B.1 + label review:fixing
bd state $B review                               # -> fixing (reads the LABEL)
bd list --status all --json | jq -c '.[]|{id,issue_type}'   # event bead present

# gates do not set hooked
G=$(bd create "gated bead" --json | jq -r .id)
bd gate create --type=human --blocks $G          # $G stays status=open

# two-clone divergent merge via file:// remote
mkdir -p /tmp/pztl-remote
bd dolt remote add origin file:///tmp/pztl-remote && bd dolt push
mkdir -p /tmp/pztl-clone2 && cd /tmp/pztl-clone2 && git init -q
BD_NON_INTERACTIVE=1 bd init --prefix pztl --non-interactive
bd dolt remote add origin file:///tmp/pztl-remote
rm -rf .beads/embeddeddolt && BD_NON_INTERACTIVE=1 bd bootstrap --yes   # clone; brings status.custom too
# status divergence: clone1 `bd update X -s open` + push; clone2 `bd update X -s in_review` + pull
#   -> Error: merge conflicts in issues require operator resolution; merge aborted
# label divergence: clone1 remove review:done/add review:a + push; clone2 add review:b + pull
#   -> Pull complete; labels = [review:a, review:b] (set-union)

# cleanup
rm -rf /tmp/pztl-probe /tmp/pztl-clone2 /tmp/pztl-remote
```
