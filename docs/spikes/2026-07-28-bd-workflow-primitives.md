# Spike: which bd workflow primitives can anton actually rely on (anton-upfc)

**Date:** 2026-07-28 · **Consumers:** anton-6587, anton-uk95 · **Result:** ✅ SURFACE PINNED

Raw evidence for [`.product/decisions/2026-07-28-bd-workflow-primitives.md`](../../.product/decisions/2026-07-28-bd-workflow-primitives.md).
The decision doc is the thing to read; this file exists so the transcripts and the reusable
harnesses do not have to be re-derived.

## Versions under test

| | Binary | Version string |
| --- | --- | --- |
| Floor (what anton **requires**) | `~/.local/bin/bd.1.1.0.bak` | `bd version 1.1.0 (8e4e59d39: 8e4e59d39f34)` |
| Installed (what happens to be there) | `~/.local/bin/bd` | `bd version 1.1.2 (20e493e56: …)` |

Every finding below was reproduced on **both**. No result differed between them.

Convenience for re-running against the floor: `BD110=~/.local/bin/bd.1.1.0.bak`.

## 1. Command existence

```sh
for c in formula cook pour mol gate swarm; do
  bd $c --help >/dev/null 2>&1 && echo "$c yes" || echo "$c NO"
done
```

```
formula  yes      cook  yes      pour  NO
mol      yes      gate  yes      swarm yes
```

`bd pour` → `Error: unknown command "pour" for "bd"`. The verb exists only as `bd mol pour`.

Sub-surface, from `bd <cmd> --help`:

- **`bd mol`** — `bond burn current distill last-activity pour progress ready seed show squash stale wisp`
  (aliased `protomolecule`). Its own help prose lists a shorter, stale set — trust `Available Commands`.
- **`bd gate`** — `add-waiter check create discover list resolve`. Gate types: `human`, `timer`,
  `gh:run`, `gh:pr`, `bead` (bead gates use `<rig>:<bead-id>`).
- **`bd swarm`** — `create list status validate`.
- **`bd formula`** — `convert list show`. Search paths: `<beads-dir>/formulas/`,
  `<checkout-root>/.beads/formulas/`, `~/.beads/formulas/`, `$GT_ROOT/.beads/formulas/`.
  **No formulas ship with bd** (`bd formula list` → `No formulas found.`).

Placement in `bd --help`: `gate` and `swarm` sit in named sections ("Working With Issues",
"Dependencies & Structure"); `cook`, `formula` and `mol` appear only under the ungrouped "Additional
Commands" (`bd --help | sed -n '109,130p'`).

## 2. formula → cook → pour → gate, end to end

The probe formula. **Note the name key is `formula`, not `name`** — `{"name": …}` is accepted by
`bd formula list` but then fails `bd cook` with `formula validation failed: name is required`, and
`bd formula show <n> --json` reveals the empty `"formula": ""` that causes it.

```jsonc
// .beads/formulas/anton-probe.formula.json
{
  "formula": "anton-probe",
  "version": 1,
  "type": "workflow",
  "description": "Probe formula: does a gate step survive cook -> pour?",
  "variables": { "feature": { "default": "probe" } },
  "steps": [
    { "id": "impl",  "title": "implement {{feature}}" },
    { "id": "ci",    "title": "await CI for {{feature}}", "depends_on": ["impl"], "gate": { "type": "gh:run" } },
    { "id": "merge", "title": "merge {{feature}}", "depends_on": ["ci"] }
  ]
}
```

```sh
bd cook anton-probe                      # compile mode: {{feature}} left intact
bd cook anton-probe --var feature=auth   # runtime mode: substituted -> "implement auth"
bd mol pour anton-probe --var feature=auth
```

```
✓ Poured mol: created 5 issues        # 3 steps + root + the auto-created gate
  Root issue: gcwd-mol-u09
  Phase: liquid (persistent in .beads/)

🧪 Molecule: anton-probe               # bd mol show gcwd-mol-u09
   ├── Gate: gh:run
   ├── merge auth
   ├── await CI for auth
   └── implement auth
```

Blocking is wired correctly — `bd ready` showed **only** `implement auth`. Then:

```sh
bd close <impl-step>          # -> bd ready: "No ready work found (all issues have blocking dependencies)"
bd gate resolve <gate-id>     # -> ✓ Gate resolved
bd ready --gated
```

```
 Molecules ready for gate-resume dispatch (1):
 1. gcwd-mol-u09: anton-probe
    Gate closed: gcwd-mol-6jb (gh:run)
    Ready step: gcwd-mol-x7s - await CI for auth
 To dispatch a molecule:
   bd sling <agent> --mol <molecule-id>      <-- bd sling DOES NOT EXIST
```

The gate-resume discovery path works. The dispatch hint it prints does not (see §4).

`bd swarm validate <epic>` also works — it renders "Ready Fronts (waves of parallel work)" with an
estimated worker-session count.

## 3. Dependency type semantics

Harness — one fresh pair per type, then read `bd ready` / `bd blocked`:

```sh
for t in blocks tracks related parent-child discovered-from until caused-by validates \
         relates-to supersedes conditional-blocks waits-for bogus-xyz; do
  A=$(bd create "MTX-$t"    --json | jq -r .id)
  B=$(bd create "MTXdep-$t" --json | jq -r .id)
  bd dep add "$A" "$B" --type="$t"
  echo "$t|$A" >> /tmp/matrix.txt
done
bd ready; bd blocked   # a "from" bead in `blocked` => that type blocks
```

```
TYPE                 ACCEPTED  BLOCKING
blocks               yes       BLOCKS
conditional-blocks   yes       BLOCKS
waits-for            yes       no-op
tracks               yes       no-op
related              yes       no-op
parent-child         yes       no-op
discovered-from      yes       no-op
until                yes       no-op
caused-by            yes       no-op
validates            yes       no-op
relates-to           yes       no-op
supersedes           yes       no-op
bogus-xyz            yes       no-op        <-- control
```

**`--type` is unvalidated free text.** Only length and non-emptiness are enforced:

```
bd dep add A B --type=totally-bogus-type
  ✓ Added dependency: … (totally-bogus-type)
bd dep add A B --type=""
  Error: invalid dependency type "": must be non-empty and at most 50 characters
```

Meanwhile the advertised list never changes across versions:

```sh
bd dep add --help | grep -o 'blocks|.*)'
# blocks|tracks|related|parent-child|discovered-from|until|caused-by|validates|relates-to|supersedes)
```

`bd link` advertises an even shorter list (`blocks|tracks|related|parent-child|discovered-from`).

### Is `conditional-blocks` actually conditional? No.

```sh
# one `blocks` pair, one `conditional-blocks` pair; both upstreams open
bd ready | grep REL-from     # -> (none ready): both downstreams blocked
bd close <upstream-blocks>; bd close <upstream-conditional>
bd ready | grep REL-from
```

```
○ gcwd-csh ● P2 REL-from-conditional-blocks
○ gcwd-4v4 ● P2 REL-from-blocks
```

Both release together on plain closure. No conditional behaviour is observable — it is an alias for
`blocks` with a different stored string.

Types round-trip verbatim, so a typo persists silently as a non-blocking edge:

```sh
bd export --output /tmp/x.jsonl
grep -o '"type":"[a-z-]*"' /tmp/x.jsonl | sort | uniq -c | sort -rn
#  8 "type":"blocks"      4 "type":"conditional-blocks"   2 "type":"waits-for"
#  1 "type":"totally-bogus-type"   1 "type":"bogus-xyz"   …
```

## 4. Broken commands

```sh
bd mol ready --gated   # Error: unknown flag: --gated
bd mol ready           # WORKS — output identical to `bd ready --gated` *in this one-molecule board*
bd ready --gated       # WORKS
```

`bd mol ready --help` prints `Usage: bd mol ready --gated [flags]` and two `--gated` examples, while
its `Flags:` block lists only `-h`. Only the *documented* invocation is broken; the bare form works.

The two are not substitutes, though: bare `bd mol ready` lists **every** ready molecule step, while
`bd ready --gated` is scoped to gate-resumable molecules. They coincided here only because the test
board held a single molecule, in gate-resume state — on a populated board they diverge. `anton-uk95`
wants the gated scope, so it must use `bd ready --gated` (PR #90 review).

```sh
bd sql "SELECT 1"      # Error: 'bd sql' is not yet supported in embedded mode
bd sling --help        # Error: unknown command "sling" for "bd"  (yet `bd gate list` suggests it)
```

anton runs embedded, so `bd sql` is unavailable in practice — use `bd export` / `bd list --json`.

## 5. The `bd gate check` process-cwd hazard

`bd gate check --help` states the mechanism outright: gh gates shell out to
`gh run view <id> --json status,conclusion` and `gh pr view <id> --json state,title`.

Ground truth — `gh` resolves the repo from the **process cwd**, and `bd -C` does not change process cwd:

```sh
cd /tmp/gatecwd/repoA && gh run view 30381985639 --json databaseId,status,conclusion
# {"conclusion":"failure","databaseId":30381985639,"status":"completed"}
cd /tmp/gatecwd/repoB && gh run view 30381985639 --json databaseId,status,conclusion
# failed to get run: HTTP 404: Not Found (https://api.github.com/repos/cli/cli/actions/runs/30381985639)
```

### Full harness

Throwaway repos; `--dry-run` only, so nothing is mutated. The two anton run IDs are real and stable:
`30324134252` = **success**, `30381985639` = **failure**. Neither exists in `cli/cli`.

```sh
rm -rf /tmp/gatecwd && mkdir -p /tmp/gatecwd/repoA /tmp/gatecwd/repoB
for r in repoA repoB; do git -C /tmp/gatecwd/$r init -q; done
git -C /tmp/gatecwd/repoA remote add origin git@github.com:henriblancke/anton.git
git -C /tmp/gatecwd/repoB remote add origin git@github.com:cli/cli.git

cd /tmp/gatecwd/repoB && BD_NON_INTERACTIVE=1 bd init --prefix gcwd --non-interactive
G1=$(bd create "step blocked by green CI" --json | jq -r .id)
G2=$(bd create "step blocked by red CI"   --json | jq -r .id)
bd gate create --type=gh:run --blocks "$G1" --await-id=30324134252
bd gate create --type=gh:run --blocks "$G2" --await-id=30381985639

cd /tmp/gatecwd/repoB && bd gate check --type=gh:run --dry-run                        # correct
cd /tmp/gatecwd/repoA && bd -C /tmp/gatecwd/repoB gate check --type=gh:run --dry-run  # hazard
```

### Result — same gate, same DB, verdict decided by cwd

```
### A) cwd=repoB (correct)
✗ gcwd-v7d: error checking - gh run view failed: HTTP 404 (…/repos/cli/cli/actions/runs/30324134252)
✗ gcwd-2tl: error checking - gh run view failed: HTTP 404 (…/repos/cli/cli/actions/runs/30381985639)
Checked 2 gates: 0 resolved, 0 escalated, 2 errors

### B) cwd=repoA, -C repoB  (HAZARD)
✓ gcwd-v7d: would resolve  - workflow 'ci' succeeded      <-- FALSE GREEN
⚠ gcwd-2tl: would escalate - workflow 'ci' failed         <-- FALSE RED
Checked 2 gates: 1 resolved, 1 escalated, 0 errors
```

The hazard fabricates **both** verdicts. Running from a third unrelated cwd whose remote is
`henriblancke/anton` (the anton worktree itself) gives byte-identical results to (B) — it is the
remote of the cwd that decides, nothing about `-C`.

Reproduced identically on the 1.1.0 floor: from the anton worktree with `-C /tmp/bd110` (a repo
whose remote is `cli/cli`), `✓ v110-nag: would resolve - workflow 'ci' succeeded`.

### `bd gate discover` shares the defect

```
cwd=repoB (correct):  No recent workflow runs found on GitHub
cwd=repoA (hazard):   Found 5 recent workflow run(s) on branch 'main'
                      Would update 0 gate(s)…
```

It offers **anton's** runs as match candidates for a `cli/cli` gate.

### bd knows the right answer and ignores it

```sh
cd /tmp/gatecwd/repoB && bd config list | grep -i remote
# sync.remote = git+ssh://git@github.com/cli/cli.git
```

The very database whose gate just resolved against `henriblancke/anton` records `cli/cli` as its
remote. The information is present; `gate check` does not consult it.

### Mitigations

1. **Spawn bd with `cwd` = the project repo; never pass `-C` to bd.** anton already complies —
   `src/lib/beads/bd.ts:225` is `spawn(bin, args, { cwd, … })`, and `grep -rn '"-C"' src/` returns
   only `git` call sites.
2. **`GH_REPO=<owner>/<repo>`** overrides gh's resolution and works from the wrong cwd — verified:
   `GH_REPO=cli/cli bd -C /tmp/gatecwd/repoB gate check …` run from `repoA` produced the correct
   `cli/cli` 404 instead of the false green. Useful only where a call site cannot control cwd.

## 6. Version contradiction (resolved)

| Ticket premise | Actual | Command |
| --- | --- | --- |
| `anton-x7la` in_progress | CLOSED | `bd show anton-x7la` |
| installed bd is 1.0.4 | 1.1.2, Jul 26 2026 | `bd version`; `ls -lT ~/.local/bin/bd` |
| `.bak` implies rollback | 1.1.0, Jul 4 2026 — **older** than installed | `~/.local/bin/bd.1.1.0.bak version`; `ls -lT` |

The `.bak` predates the live binary, so it is upgrade residue, not a rollback. `MIN_BD_VERSION =
"1.1.0"` in both `src/lib/beads/config.mjs:102` and `src/lib/beads/bd-bin.ts:23` (kept in sync by
hand). `docs/runbooks/bd-1.0.4-to-1.1.0-migration.md` is `status: validated`. No 1.0.4 is involved
anywhere, and no finding here was inherited from 1.0.4 observation.

## Cleanup

```sh
rm -rf /tmp/gatecwd /tmp/bd110 /tmp/matrix.txt /tmp/x.jsonl
```

The probes ran entirely in `/tmp` throwaway workspaces. anton's own board was verified untouched:
`bd list --json | grep -cE 'MTX-|dep-probe|REL-from|anton-probe'` → `0`.
