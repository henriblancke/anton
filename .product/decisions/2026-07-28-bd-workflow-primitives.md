# bd workflow primitives anton may rely on
Date: 2026-07-28
Status: accepted

Settles `anton-upfc` for the two features that adopt bd's workflow layer (`anton-6587`
molecule/pour, `anton-uk95` gate seam). Every claim below names the command that proves it and was
re-run on **both** bd 1.1.0 (anton's required floor) **and** bd 1.1.2 (what is installed today) —
all results were identical across the two unless noted. Raw transcripts:
[`docs/spikes/2026-07-28-bd-workflow-primitives.md`](../../docs/spikes/2026-07-28-bd-workflow-primitives.md).

## Decision

### 1. The version anton requires is bd >= 1.1.0, and that is the surface anton designs against

`MIN_BD_VERSION = "1.1.0"` in `src/lib/beads/config.mjs:102` and `src/lib/beads/bd-bin.ts:23`.
Findings are pinned to 1.1.0, not to the installed 1.1.2, so anton never builds on something a
conforming minimum install lacks.

```sh
bd version                        # bd version 1.1.2 (20e493e56: …)
~/.local/bin/bd.1.1.0.bak version # bd version 1.1.0 (8e4e59d39: …)  ← the floor, used for every re-check
grep -n MIN_BD_VERSION src/lib/beads/config.mjs src/lib/beads/bd-bin.ts
grep -n 'BD_VERSION:' .github/workflows/ci.yml   # BD_VERSION: "1.1.0"
```

CI agrees on the version, with one caveat worth stating precisely: the `integration` job installs bd
**1.1.0 exactly** and its version-assert step exits 1 on drift, but the entire job carries
`continue-on-error: true` (`.github/workflows/ci.yml:51`, report-only by design). Drift is therefore
**reported, not blocking** — do not read the 1.1.0 integration coverage as a merge-blocking
guarantee until that `continue-on-error` is flipped off. 1.1.0 is still the only version anton's
suites are ever exercised against, which is why the checks below were re-run on it rather than on
the 1.1.2 that happens to be on this machine.

**The version contradiction in the ticket is gone — it was a stale snapshot.** All three of its
premises are now false, verified:

| Ticket premise | Actual | Command |
| --- | --- | --- |
| `anton-x7la` is `in_progress` | **CLOSED** | `bd show anton-x7la` |
| `~/.local/bin/bd` is 1.0.4 | **1.1.2**, dated Jul 26 2026 | `bd version` · `ls -lT ~/.local/bin/bd` |
| `bd.1.1.0.bak` implies a rollback | **1.1.0, dated Jul 4 2026 — older than the installed binary** | `~/.local/bin/bd.1.1.0.bak version` · `ls -lT ~/.local/bin/bd.1.1.0.bak` |

The `.bak` predates the live binary, so it is a leftover from the upgrade, not a rollback of it. The
upgrade happened and stuck. `docs/runbooks/bd-1.0.4-to-1.1.0-migration.md` is `status: validated`.
**No 1.0.4 remains anywhere in the picture**, and nothing in this doc is inherited from 1.0.4
observation — it was all re-derived.

### 2. Primitive surface: five of the six exist as named; `pour` is not a top-level command

```sh
for c in formula cook pour mol gate swarm; do
  bd $c --help >/dev/null 2>&1 && echo "$c yes" || echo "$c NO"
done
```

| Primitive | Exists | How anton invokes it |
| --- | --- | --- |
| `formula` | yes | `bd formula list \| show \| convert` |
| `cook` | yes | `bd cook <formula> [--var k=v] [--persist]` |
| `pour` | **no — not top-level** | `bd mol pour <formula> --var k=v` |
| `mol` | yes | `bd mol pour \| wisp \| show \| bond \| ready \| progress \| squash \| burn \| distill \| seed \| current \| stale \| last-activity` |
| `gate` | yes | `bd gate create \| check \| list \| resolve \| discover \| add-waiter` |
| `swarm` | yes | `bd swarm create \| list \| status \| validate` |

`bd pour` errors with `unknown command "pour" for "bd"` on both versions. **Anything anton writes
must say `bd mol pour`.** `formula`, `cook` and `mol` appear only under the ungrouped "Additional
Commands" heading of `bd --help` (`bd --help | sed -n '109,130p'`), while `gate` and `swarm` get
first-class sections — a documentation asymmetry, not a capability one.

**The formula → cook → pour → gate path works end to end**, verified by pouring a probe formula with
a gated middle step (full transcript in the spike doc): `bd mol pour` created the DAG plus the gate
bead, only the first step was in `bd ready`, and closing step 1 + resolving the gate surfaced the
molecule in `bd ready --gated`. The formula's name key is **`formula`**, not `name` — `{"name": …}`
parses but then fails `bd cook` with `formula validation failed: name is required`.

### 3. Dependency types: `--type` is unvalidated, and only `blocks` and `conditional-blocks` block

The ticket asks whether `conditional-blocks` and `waits-for` are "settable via `bd dep add`".
**Settable is the wrong test, and its answer is misleading.** `--type` accepts *any* non-empty
string up to 50 characters — including a deliberate typo:

```sh
bd dep add <A> <B> --type=totally-bogus-type   # ✓ Added dependency … (totally-bogus-type)
bd dep add <A> <B> --type=""                   # Error: invalid dependency type "": must be non-empty…
```

So the real question is which types carry *blocking semantics*. Measured by adding one edge per type
between a fresh pair and reading `bd ready` / `bd blocked`:

| `--type` | Accepted | Blocks? |
| --- | --- | --- |
| `blocks` | yes | **BLOCKS** |
| `conditional-blocks` | yes | **BLOCKS** |
| `tracks`, `related`, `parent-child`, `discovered-from`, `until`, `caused-by`, `validates`, `relates-to`, `supersedes` | yes | no-op |
| `waits-for` | yes | no-op |
| `bogus-xyz` (control) | yes | no-op |

**This corrects the note on `anton-upfc`**, which recorded that `conditional-blocks` and `waits-for`
are "STILL NOT settable via `bd dep add`" because `--help` does not list them. `--help` indeed does
not list them (`bd dep add --help | grep -o 'blocks|.*)'` returns the unchanged ten-value list on
both versions), **but the command accepts both** — the earlier check read the help text without
running the command.

The note's *conclusion* nevertheless stands, for a different reason:

- **`conditional-blocks` is behaviourally identical to `blocks`.** It blocks while the upstream is
  open and releases the moment it closes — no conditional behaviour is observable. Verified by
  building a `blocks` pair and a `conditional-blocks` pair, closing both upstreams, and seeing both
  downstreams appear in `bd ready` together.
- **`waits-for` is indistinguishable from a typo.** It stores and round-trips, and does nothing.

Types round-trip verbatim through export (`bd export --output /tmp/x.jsonl` then
`grep -o '"type":"[a-z-]*"' /tmp/x.jsonl | sort | uniq -c`), which is what makes the free-text field
dangerous rather than merely useless: a mistyped `--type` silently yields a **non-blocking** edge
with no error at any point.

**Rule: anton writes `blocks` and nothing else for ordering.** `anton-6587`'s explicit-blocks fan-in
workaround **remains correct and needs no amendment** — there is no richer primitive to simplify it
onto.

### 4. Commands that are BROKEN at this version

| Command | Failure | anton uses instead |
| --- | --- | --- |
| `bd mol ready --gated` | `Error: unknown flag: --gated` — contradicts its own usage line (`Usage: bd mol ready --gated [flags]`) and both its examples | `bd ready --gated` — the only gate-scoped form. Bare `bd mol ready` runs, but lists **every** ready molecule step, so it is not a substitute on a populated board |
| `bd sql <query>` | `Error: 'bd sql' is not yet supported in embedded mode` — and anton runs embedded | `bd export` + parse the JSONL, or `bd list --json` |
| `bd sling <agent> --mol <id>` | `unknown command "sling" for "bd"` — yet `bd gate list` prints it as the suggested next step | nothing; ignore that hint |

Broken identically on 1.1.0 and 1.1.2. Note the failure mode of the first one: only the *documented*
invocation errors — the bare form runs, which is what makes it a tempting and wrong substitute for
the gate-scoped query.

### 5. `bd gate check` resolves GitHub gates against the **process cwd**, not the gate's repo — always spawn with `cwd` = project repo

`gh:run` / `gh:pr` gates shell out to the `gh` CLI (stated in `bd gate check --help`: "gh:run checks
`gh run view <id> --json status,conclusion`"). **`gh` resolves its repo from the current working
directory's git remote.** `bd -C <dir>` changes only where bd finds the *database* — it does not
change the process cwd — so the `gh` subprocess still resolves against **the caller's** repo.

Reproduce it (~30s; both repos are throwaway, only `--dry-run` is used, nothing is mutated):

```sh
# repoA = the WRONG repo the gate must not resolve against; repoB = the gate's real repo
mkdir -p /tmp/gatecwd/repoA /tmp/gatecwd/repoB
for r in repoA repoB; do git -C /tmp/gatecwd/$r init -q; done
git -C /tmp/gatecwd/repoA remote add origin git@github.com:henriblancke/anton.git
git -C /tmp/gatecwd/repoB remote add origin git@github.com:cli/cli.git

cd /tmp/gatecwd/repoB && BD_NON_INTERACTIVE=1 bd init --prefix gcwd --non-interactive
BEAD=$(bd create "step blocked by CI" --json | jq -r .id)
# 30324134252 is a SUCCESSFUL henriblancke/anton Actions run — it does not exist in cli/cli
bd gate create --type=gh:run --blocks "$BEAD" --await-id=30324134252

cd /tmp/gatecwd/repoB && bd gate check --type=gh:run --dry-run          # (A) correct cwd
cd /tmp/gatecwd/repoA && bd -C /tmp/gatecwd/repoB gate check --type=gh:run --dry-run   # (B) hazard
```

Same gate, same database, two different verdicts — decided purely by which directory the process
started in:

```
(A) cwd=repoB   ✗ <gate-id>: error checking - gh run view failed: HTTP 404: Not Found
                  (https://api.github.com/repos/cli/cli/actions/runs/30324134252)
(B) cwd=repoA   ✓ <gate-id>: would resolve - workflow 'ci' succeeded
```

(bd mints a random `<gate-id>` per run, so yours will differ; the ✗ / ✓ split is the result.)

**(B) is a false green**: a gate belonging to `cli/cli` reports **resolved** on the strength of a
green CI run in `henriblancke/anton`. Running the same experiment against a *failed* anton run
(`30381985639`) produces the mirror image — `would escalate - workflow 'ci' failed` — so the hazard
fabricates both verdicts, not just the optimistic one. Reproduced identically on 1.1.0 and 1.1.2.

`bd gate discover` reads from the same wrong repo: run from `repoA` it reports `Found 5 recent
workflow run(s) on branch 'main'` — those are **anton's** runs — where the correct cwd finds none.
What is demonstrated is that discovery's *candidate set* is drawn from the process cwd's repo; the
harness then printed `Would update 0 gate(s)`, because its only gate already had `--await-id`
pinned and nothing matched. So the cwd rule below applies to `discover` too, but an actually
mis-written gate was not observed here — proving that would need a gate left open for discovery to
fill.

Note that bd *knows* the right answer and does not use it — `bd config list | grep sync.remote`
returns `git+ssh://git@github.com/cli/cli.git` for the very database whose gate just resolved
against a different repo.

**Mitigation anton must adopt — and already satisfies:**

1. **Always spawn bd with `cwd` set to the project repo.** `src/lib/beads/bd.ts:225` already does
   (`spawn(bin, args, { cwd, … })`).
2. **Never pass `-C` to bd.** Verified today: `grep -rn '"-C"' src/` returns only `git` invocations
   (`src/lib/projects.ts`, `src/lib/beads/config.mjs`) — no bd call site uses it.

This is a **preserve-this invariant, not a change**. It is recorded because the trap is silent and
`-C` is the obvious convenience an unaware future edit would reach for — especially in a
multi-worktree runtime, where "point bd at that repo's DB" is a natural thing to want. Belt and
braces where a call site cannot control cwd: `GH_REPO=<owner>/<repo>` overrides gh's resolution and
was verified to work from the wrong cwd (it forced the correct `cli/cli` 404 from `repoA`).

## Why

**Two features were about to be designed against a version nobody had confirmed.** The ticket
carried three mutually inconsistent version claims and a `--help`-derived finding that turns out to
be wrong when the command is actually run. Pinning the surface costs one session; discovering it
inside a pipeline implementation costs a redesign.

**The `--help` text is not a reliable oracle for this bd.** Three independent instances found today:
`--type` accepts values its own list omits, `bd mol ready --gated` is contradicted by its own usage
line, and `bd gate list` advertises a command that does not exist. Every claim here therefore names
a command that was *executed*, not a help page that was read — which is also why the acceptance
criterion demands re-runnable proof.

**The gate cwd hazard is the highest-severity finding** because it fails silently and in the
direction of a false green. A gate that reports resolved off the wrong repo's CI lets a pipeline
advance past a check that never passed — precisely the "false green is worse than an honest stop"
failure anton's operating contract exists to prevent. It is cheap to hold the invariant now and
expensive to debug later.

**Verifying on the floor rather than the installed binary** is what the acceptance criterion asked
for, and it was achievable at no cost because the 1.1.0 binary was still on disk as `bd.1.1.0.bak`.
Had every check only been run on 1.1.2, anton could have adopted a 1.1.1+-only behaviour while
advertising a 1.1.0 floor.

## Rejected

- **Relying on `conditional-blocks` or `waits-for` for richer fan-in semantics.** The published
  beads docs describe them; this bd gives `conditional-blocks` exactly `blocks`'s behaviour and
  `waits-for` none at all. Designing against the docs would produce edges that silently do not block.
- **Treating `bd dep add --type` as a validated enum.** It is free text; a typo yields a
  non-blocking edge with no error. anton restricts itself to `blocks` rather than trusting bd to
  reject mistakes.
- **Using `bd -C` to target a worktree's database.** Convenient and correct for the DB, silently
  wrong for every `gh:*` gate. cwd-based spawning is the only form that keeps bd and its `gh`
  subprocess pointed at the same repo.
- **`bd sql` for board queries.** Unsupported in embedded mode, which is the mode anton runs.
- **Raising the floor to 1.1.2 to match the installed binary.** Nothing found here requires it —
  every finding reproduced identically on 1.1.0 — so the floor stays where the preflight already
  enforces it.

## Consequences for the tickets that consume this

- **`anton-6587`** (one molecule step per ticket, bonded at pour time) — its explicit-blocks fan-in
  workaround **remains correct; no AC amendment**. The pipeline fail-path does **not** simplify: the
  newer dependency types the beads docs advertise carry no usable semantics here. Use `bd mol pour`,
  never `bd pour`, and remember the formula name key is `formula`.
- **`anton-uk95`** (beads gate seam + wrong-repo regression test) — its AC **remains correct**: use
  `bd ready --gated`, since `bd mol ready --gated` is broken. The regression test it calls for should
  assert the invariant proven above — bd is spawned with `cwd` = project repo and no `-C` — because
  that is the property that makes `gh:*` gates trustworthy.
