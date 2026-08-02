# Spike: should founder approval become a bd human gate (anton-xx59)

**Date:** 2026-08-01 · **Consumers:** anton-4lad, anton-1k8i, anton-9anc, anton-ve2r ·
**Result:** ❌ DECLINE — keep the `approved` label

Raw evidence for [`.product/decisions/2026-08-01-approval-as-human-gate.md`](../../.product/decisions/2026-08-01-approval-as-human-gate.md).
The decision doc is the thing to read; this file exists so the transcripts do not have to be
re-derived. Every command below was run against **bd 1.1.2** on a throwaway board in
`/tmp/xx59-probe` plus a second clone wired to a `file:///tmp/xx59-remote` Dolt remote. anton's own
board was verified untouched.

## Harness

```sh
rm -rf /tmp/xx59-probe && mkdir -p /tmp/xx59-probe && cd /tmp/xx59-probe
git init -q && BD_NON_INTERACTIVE=1 bd init --prefix xx59 --non-interactive
E=$(bd create "container epic"                     -t epic              --json | jq -r .id)  # xx59-0t6
F1=$(bd create "feature A: approved, ungated"      -t feature --parent $E --json | jq -r .id) # xx59-0t6.1
F2=$(bd create "feature B: approved, human-gated"  -t feature --parent $E --json | jq -r .id) # xx59-0t6.2
F3=$(bd create "feature C: unapproved, human-gated" -t feature --parent $E --json | jq -r .id) # xx59-0t6.3
C1=$(bd create "child task of B"                   -t task    --parent $F2 --json | jq -r .id)
bd update $F1 --add-label approved
bd update $F2 --add-label approved
bd gate create --type=human --blocks $F2 --reason="founder approval"
bd gate create --type=human --blocks $F3 --reason="founder approval"
```

Note `-p` is **priority**, not parent — `bd create X -p $E` fails with
`invalid priority "xx59-rfl"`. The parent flag is `--parent`.

The second clone (used from §4 on) needs `BEADS_SKIP_IDENTITY_CHECK=1`; a fresh `bd init` +
`bd bootstrap` clone reports a `workspace identity mismatch` on every command otherwise.

```sh
mkdir -p /tmp/xx59-remote
cd /tmp/xx59-probe && bd dolt remote add origin file:///tmp/xx59-remote && bd dolt push
mkdir -p /tmp/xx59-c2 && cd /tmp/xx59-c2 && git init -q
BD_NON_INTERACTIVE=1 bd init --prefix xx59 --non-interactive
bd dolt remote add origin file:///tmp/xx59-remote
rm -rf .beads/embeddeddolt && BD_NON_INTERACTIVE=1 bd bootstrap --yes
```

## 1. A human gate does block a feature from `bd ready` — and the block is transitive

```sh
bd ready
```

```
○ xx59-0t6   ● P2 [epic] container epic
○ xx59-0t6.1 ● P2 feature A: approved, ungated ← container epic
Ready: 2 issues with no active blockers
```

`bd blocked` names the gate as the blocker, and the gated feature's **child** is blocked too:

```
[● P2] xx59-0t6.2.1: child task of B          Blocked by 1 open dependencies: [xx59-0t6.2]
[● P2] xx59-0t6.3: feature C ...              Blocked by 1 open dependencies: [xx59-gj2]
[● P2] xx59-0t6.2: feature B ...              Blocked by 1 open dependencies: [xx59-z7c]
```

After `bd gate resolve xx59-z7c`, `xx59-0t6.2.1` appears in `bd ready` while its parent is still
open — so the child's exclusion came transitively from the gate, not from the parent being open.
**A gate on a feature hides its whole subtree.** This is the one capability the label model
genuinely lacks (pztl trigger condition 3).

## 2. Gate ∧ label compose — neither subsumes the other

anton-9anc's claimable query, unchanged, against the gated board:

```sh
bd ready --type feature --label approved --unassigned --json
```

| board state | result |
| --- | --- |
| before any resolve | `xx59-0t6.1` only (gated `0t6.2` excluded) |
| after `bd gate resolve xx59-z7c` | `xx59-0t6.1`, `xx59-0t6.2` |
| after `bd gate resolve xx59-gj2` (gate on the **unapproved** `0t6.3`) | `xx59-0t6.1`, `xx59-0t6.2` — `0t6.3` stays out |

`0t6.3` does appear in bare `bd ready` after its resolve. So the two dimensions AND cleanly: the
gate controls `bd ready` membership, the label controls the `--label approved` filter, and
resolving a gate never smuggles an unapproved bead into the claimable set. **anton-9anc ships
unchanged either way.**

## 3. `bd gate check` never touches a human gate

With two open human gates on the board:

```sh
bd gate check --dry-run           # Checked 0 gates: 0 resolved, 0 escalated, 0 errors
bd gate check --type=human --dry-run   # Checked 0 gates: 0 resolved, 0 escalated, 0 errors
```

anton-4lad's "human gates never auto-close" AC is satisfied by bd itself — the checker does not
enumerate them. It also means a human gate resolved from a CLI triggers **nothing**: no anton
instance learns about it from `bd gate check`.

## 4. Gate creation is not idempotent — double-approve makes a double-gate

Two `bd gate create --type=human --blocks $F1` calls produce two gates (`xx59-66k`, `xx59-us0`),
and resolving one is not enough:

```sh
bd gate resolve xx59-66k
bd ready --type feature --label approved --unassigned --json | jq -c '[.[]|.id]'
# ["xx59-0t6.2"]        <-- F1 still absent: the second gate still blocks
bd gate resolve xx59-us0
# ["xx59-0t6.2","xx59-0t6.1"]
```

Across clones the two creates **merge clean** (row inserts) and land as two open gates on one
feature — a silent double-gate that needs two resolves:

```sh
# A creates a gate on 0t6.2 and pushes; B creates its own without pulling; B pulls
Pull complete.
bd gate list      # ○ xx59-cjt  ○ xx59-dk4  ○ xx59-qu7  ○ xx59-cvm
bd ready --type feature --label approved --unassigned --json | jq -c '[.[]|.id]'   # []
```

`bd update --add-label approved` is idempotent by construction; `bd gate create` is not.

## 5. Dolt sync: a divergent gate resolve wedges the board; a divergent label add does not

Both clones write without pulling first, then the second pulls. Reproduced with the pre-state
asserted on both sides each time (`bd list --status all --type gate --json` → `open`).

| write | divergent outcome | reps |
| --- | --- | --- |
| `bd gate resolve <g>` (no `--reason`) | `Error: merge origin/main: merge conflicts in issues require operator resolution; merge aborted` | 2/2 |
| `bd gate resolve <g> --reason=…` (different reasons) | same wedge | 1/1 |
| `bd gate create --blocks <f>` | `Pull complete.` — two gates | 1/1 |
| `bd update <f> --add-label approved` (**same** label, both sides) | `Pull complete.` | 1/1 |
| `bd assign <f> alice` vs `bd assign <f> bob` | wedge | 1/1 |
| `bd assign <f> henri` on **both** sides (same value) | wedge | 1/1 |

```sh
# the wedge, verbatim
cd /tmp/xx59-probe && G=$(bd gate create --type=human --blocks xx59-0t6.3 --json | jq -r .id) && bd dolt push
# reclone c2 (it now has G open), then:
cd /tmp/xx59-probe && bd gate resolve $G && bd dolt push
cd /tmp/xx59-c2   && bd gate resolve $G          # no pull first
cd /tmp/xx59-c2   && bd dolt pull
# Error: merge origin/main: merge conflicts in issues require operator resolution; merge aborted and working set restored
```

**Pull-before-resolve is a sufficient mitigation** — B pulls, sees `closed`, resolves anyway, and
the next pull is clean:

```sh
cd /tmp/xx59-c2 && bd dolt pull        # Pull complete.  -> status closed
bd gate resolve $H                     # re-resolve an already-closed gate
bd dolt pull                           # Pull complete.
```

Two honest notes: an early unverified run of the reasonless case merged clean and could not be
reproduced once the pre-state was asserted (3/3 wedge after that); and **today's approve already
holds one wedge-capable write** — the `bd assign` in its CAS — so gates would add a second, not
introduce the class.

## 6. anton's board cannot read gates — and misreads resolved ones as open blockers

A gate bead is **invisible** to every default listing, including anton's exact whole-board call
(`bd.ts:824` → `bd list --json --limit 0 --status all`):

```sh
bd ready --json                 | jq '[.[]|select(.issue_type=="gate")]|length'   # 0
bd list --json                  | jq '[.[]|select(.issue_type=="gate")]|length'   # 0
bd list --status all --json     | jq '[.[]|select(.issue_type=="gate")]|length'   # 0
bd list --status all --type gate --json | jq length                               # 4  <-- only here
```

But the `blocks` **edge** to the gate is present on the gated feature:

```sh
bd list --json --limit 0 --status all | jq -c '.[]|select(.id=="xx59-0t6.2")|.dependencies'
# [... {"depends_on_id":"xx59-tpk","type":"blocks"}, {"depends_on_id":"xx59-zm9","type":"blocks"}, … ]
```

Fed to anton's own rollup (`computeEpicGraph` + `epicStandaloneBlockers`, run under vitest over the
board's real JSON):

```json
"nodes":      [{"id":"xx59-0t6.3","blockedBy":[],"ready":true}, …]
"standalone": {"xx59-0t6.3": ["xx59-tnm","xx59-726","xx59-11u","xx59-ywq","xx59-gj2","xx59-wg6"]}
```

`xx59-0t6.3`'s six gates are **all closed** — `bd ready` lists it as ready. anton reports it
blocked by all six. Two bugs compose: `computeEpicGraph` drops gate edges (a gate id has no unit
ancestor, so `runTargetOf` returns undefined), and `epicStandaloneBlockers` recovers exactly those
dropped edges and fails safe on an unknown blocker (`epic-graph.ts:251` — `if (!blocker || … !==
"done") open.add(e.to)`). Since the gate bead is never in the list, resolved and open are
indistinguishable.

Consequence today, with no migration at all: **creating a human gate on a feature permanently 409s
its approve route** (`approve/route.ts` → `Epic is blocked by xx59-tnm, …`), forever, including
after `bd gate resolve`. That is anton-ve2r's territory and a hard prerequisite for any adopt.

Also visible: resolved gates accumulate `blocks` edges on the bead permanently —

```
bd show xx59-0t6.2
DEPENDS ON
  → ✓ xx59-tpk: Gate: human      → ✓ xx59-zm9: Gate: human      → ✓ xx59-z7c: Gate: human
  → ○ xx59-dk4: Gate: human      → ○ xx59-fi5: Gate: human
```

## 7. Gate-only approval fails **open**

A freshly shaped feature nobody gated:

```sh
N=$(bd create "feature D: freshly shaped, nobody gated it" -t feature --parent xx59-0t6 --json | jq -r .id)
bd ready --type feature --unassigned --json          | jq -r '[.[]|.id]|join(" ")'   # xx59-0t6.4
bd ready --type feature --label approved --unassigned --json | jq -r '[.[]|.id]|join(" ")'   # (empty)
```

Under a gate-only model the bead is claimable the moment it exists; under the label model it is
not. A missing gate reads as approved; a missing label reads as unapproved.

## Cleanup

```sh
rm -rf /tmp/xx59-probe /tmp/xx59-c2 /tmp/xx59-remote /tmp/xx59-board.json /tmp/xx59-rollup.json
```

anton's own board was verified untouched: every probe ran in `/tmp` throwaway workspaces with their
own `xx59` prefix.
