---
title: "Runbook: bd 1.0.4 → 1.1.0 migration for anton's remote-backed beads"
type: runbook
status: validated
date: 2026-07-20
ticket: anton-4xgw
epic: anton-x7la
---

# Runbook: bd 1.0.4 → 1.1.0 migration (remote-backed / `refs/dolt/data`)

## Summary

bd 1.1.0 applies **21 pending schema migrations** (Dolt schema `v32 → v53`) on first
open. One of them reshapes the `dependencies` table primary key. anton's beads is
**remote-backed** — every clone syncs its Dolt data over the git remote as
`refs/dolt/data` (`bd dolt push`/`pull`; see `configureBeadsDoltSync` in
`src/lib/beads/config.mjs` and `createDoltSync` in `src/lib/beads/bd.ts`).

If **two clones migrate independently**, each rewrites the schema in its own Dolt
history. Those histories then **cannot be merged** — `bd dolt pull` fails permanently
and the break is silent. 1.1.0 guards against this: a bare `bd migrate` on a
remote-backed DB **refuses** unless the operator sets `BD_ALLOW_REMOTE_MIGRATE=1`,
naming themselves the single designated migrator.

**The rule: exactly one clone migrates and pushes; every other clone re-clones (`bd
bootstrap`) to adopt the migrated schema. Never migrate a second clone.**

This runbook was **dry-run validated end-to-end** on a throwaway two-clone setup (see
[Validation evidence](#validation-evidence)): after migrating clone A and
re-bootstrapping clone B, bidirectional `bd dolt push`/`pull` was clean with **no
history divergence**.

---

## Preconditions

- You have both binaries available and know which is which:
  - old: `bd version` → `1.0.4`
  - new: the 1.1.0 binary you are upgrading to.
- You can enumerate **every** clone of this backlog (every machine/worktree with a
  `.beads/` for the `anton` database). Adoption must reach all of them, or the
  un-adopted clone's next `bd dolt pull` breaks.
- The shared remote is reachable: `git@github.com:henriblancke/anton.git`
  (`sync.remote` in `.beads/config.yaml`), carrying beads data on `refs/dolt/data`.
- Repo beads identity for this project: database/prefix **`anton`** → destroy-token
  (if ever needed) is **`DESTROY-anton`**.

---

## The runbook

### Phase 0 — Freeze and designate (all clones)

1. **Pick ONE migrator machine.** Only it runs `bd migrate`. Announce it so nobody
   else upgrades-and-migrates in parallel.
2. **Freeze beads writes** on every clone for the duration (pause anton runs / agents
   that call `bd`). A write on an un-migrated clone after the migrator pushes is a
   fork risk.

### Phase 1 — Drain every clone on the OLD (1.0.4) binary

Get all un-synced work onto the remote **before** the schema changes, while every
clone still speaks the old schema.

On **each** clone, with the **1.0.4** binary:

```bash
bd export --all -o .beads/backup/pre-1.1.0-$(hostname).jsonl   # off-machine safety net
bd dolt commit                                                  # flush any pending writes
bd dolt push                                                    # publish to refs/dolt/data
```

Then on the migrator, pull everyone's work in:

```bash
bd dolt pull      # migrator now holds the union of all clones' work
```

Do not proceed until every clone reports `Push complete.` and the migrator's
`bd dolt pull` is clean. Anything not pushed here is **not** in the migrated database.

### Phase 2 — Migrate on the designated migrator only

On the **migrator**, switch to the **1.1.0** binary, then:

```bash
bd export --all -o .beads/backup/pre-1.1.0-migrator.jsonl      # final backup before schema change

# A bare `bd migrate` REFUSES on a remote-backed DB (this is the guard). Authorize it:
BD_ALLOW_REMOTE_MIGRATE=1 bd migrate                            # applies v32 → v53 (21 migrations)
bd dolt push                                                    # publish the migrated schema + data
```

Expected output (validated):

```
Warning: applying 21 pending schema migration(s) to a remote-backed database
(BD_ALLOW_REMOTE_MIGRATE=1); only one clone should migrate, then `bd dolt push`
Updating Dolt schema version: 1.0.4 → 1.1.0
✓ Version updated
```

Sanity check on the migrator: `bd list` still shows all issues, `bd dep list <id>`
still shows dependencies (the PK reshape preserves rows).

**Do NOT run `BD_ALLOW_REMOTE_MIGRATE=1 bd migrate` anywhere else.** That is the exact
action that forks the schema.

### Phase 3 — Every other clone ADOPTS via re-clone (never migrates)

On **each non-migrator clone**, with the **1.1.0** binary. Bootstrap re-clones the
migrated database from the remote — it does **not** migrate in place.

`bd bootstrap` is non-destructive and **refuses to overwrite an existing local Dolt
DB** (`Error 1007: can't create database <name>; database exists`). Re-cloning
therefore means removing the local Dolt runtime first — after a safety export, because
**re-cloning discards any local Dolt state that was never pushed** (Phase 1 is what
makes that safe):

```bash
bd export --all -o .beads/backup/pre-adopt-$(hostname).jsonl   # safety: unpushed local work is lost on re-clone
rm -rf .beads/embeddeddolt .beads/dolt                          # drop the local Dolt runtime (gitignored, per-machine)
bd bootstrap --non-interactive                                  # re-clone the migrated DB from the remote
```

> **Gotcha (validated):** run `rm -rf` and `bd bootstrap` **back-to-back**. *Any* bd
> command in between (`bd list`, `bd migrate --inspect`, …) re-creates
> `.beads/embeddeddolt` and bootstrap will fail again with `database exists`. If that
> happens, just `rm -rf .beads/embeddeddolt` again and immediately re-run bootstrap.

Verify adoption: `bd list` shows the full backlog and cross-clone sync is clean:

```bash
bd dolt pull     # clean
# create a throwaway issue, bd dolt push, pull it on the migrator — both directions clean
```

### Phase 4 — Unfreeze

Once **every** clone has adopted and a round-trip push/pull is clean in both
directions, unfreeze writes and resume anton runs. Delete the throwaway verification
issues.

---

## Exit-code handling for anton preflight

1.1.0's `bd init` returns **distinct exit codes** for the refusals that matter to a
remote-backed setup. anton's preflight (the `bd 1.1.0 required` adoption ticket,
anton-qwsq) must branch on these rather than scraping stderr text. Verified against the
1.1.0 binary; canonical definitions in `bd help init-safety`.

| Exit | Meaning | anton preflight response |
|------|---------|--------------------------|
| **10** | `bd init` selected **local** history (`--reinit-local` / `--from-jsonl`) but the remote already has Dolt history, and `--discard-remote` was **not** passed. | **Do not force.** This is the "someone else owns the remote history" signal. The correct adopt path is `bd bootstrap`, not `init`. Surface loud; never auto-pass `--discard-remote`. |
| **11** | Existing **local** data present and the operator **declined** the destroy confirmation. | Treat as operator abort. Stop; do not retry with `--yes`/token to override a human's "no". |
| **12** | `--discard-remote` passed but **no valid `--destroy-token`** in non-interactive mode. | A destructive history-replace was requested without the safety token. In automation the token is `DESTROY-<prefix>` (here `DESTROY-anton`); anton should **not** synthesize it to get past the guard — a `12` means "a human must confirm this is intentional." |

**The migrate guard is separate from these init codes.** A bare `bd migrate` on a
remote-backed DB does not use 10/11/12 — it prints the `v32 → v53` refusal and the
two-branch instructions (migrate-with-`BD_ALLOW_REMOTE_MIGRATE=1` vs `bd bootstrap`),
and does not apply migrations. anton preflight should detect the pending-migration
state (e.g. `bd migrate --inspect --json`, or the version gap between binary and DB)
and route to **this runbook**, never auto-set `BD_ALLOW_REMOTE_MIGRATE=1` on more than
the one designated migrator.

Practical preflight shape for anton (adoption ticket):

- Refuse to run against a DB whose schema is behind the binary unless it is the
  designated migrator; otherwise instruct `bd bootstrap`.
- Never pass `--discard-remote` / `--destroy-token` programmatically — an exit `10`,
  `11`, or `12` is a **stop-and-ask**, not a retry-with-more-force.

---

## Validation evidence

Dry-run on a throwaway two-clone setup against a bare git remote
(`/tmp/bd-migtest/remote.git`), old binary `bd 1.0.4`, new binary `bd 1.1.0`. Steps and
observed results:

1. **Clone A (1.0.4):** `bd init`, created two issues **with a `blocks` dependency edge**
   (so migration 0050's `dependencies` PK reshape touches real rows), wired the Dolt
   remote (`bd dolt remote add origin …`), `bd dolt push`. `refs/dolt/data` landed on
   the remote.
2. **Clone B (1.0.4):** `git clone` + `bd bootstrap` → saw clone A's two issues and the
   dependency. Both clones now on schema `v32`, sharing data.
3. **Guard, clone A (1.1.0):** bare `bd migrate` **refused** with the `v32 → v53`
   remote-backed message — no migration applied. ✅
4. **Migrate, clone A (1.1.0):** `BD_ALLOW_REMOTE_MIGRATE=1 bd migrate` → `1.0.4 →
   1.1.0`, all rows + the dependency preserved; `bd dolt push` published. ✅
5. **Adopt, clone B (1.1.0):** first `bd bootstrap` failed with `database exists`;
   after `bd export --all` (safety) + `rm -rf .beads/embeddeddolt` + `bd bootstrap`, it
   re-cloned the migrated DB. ✅
6. **Cross-clone sync (post-migration):** clone B created an issue (with a dep on a
   clone-A issue) → `bd dolt push`; clone A `bd dolt pull` → **clean**, saw B's issue.
   Reverse direction (A writes → push, B pulls) → **clean**. **No history divergence,
   no merge conflict, in either direction.** ✅
7. **Exit codes (1.1.0):** `bd init --reinit-local` (remote has Dolt, no
   `--discard-remote`) → **10**; `bd init --reinit-local --discard-remote` without token
   (non-interactive) → **12**. ✅

Known cosmetic quirk: right after a fresh `bd bootstrap`, `bd migrate --inspect` may
print a blank `Schema Version:` with a "mismatch" warning. This is a display artifact of
the not-yet-populated remote-tracking ref — actual reads/writes/pulls all succeed, which
is the real proof of a consistent schema. Do not treat this warning alone as a failed
migration; the clean bidirectional sync in step 6 is the authoritative check.

---

## Rollback / recovery

- The migration only moves **forward**. Rollback = restore from the Phase 1/2
  `bd export --all` JSONL backups into a fresh 1.0.4 database, then re-establish the
  remote. Keep the pre-migration backups until every clone has adopted and run clean
  for a full day.
- If a clone was accidentally migrated independently and its history has forked from the
  remote (`bd dolt pull` fails to merge), **do not** try to merge it. Export its unique
  work (`bd export --all`), discard its local Dolt state, `bd bootstrap` to adopt the
  canonical migrated DB from the remote, then re-import only the genuinely-missing
  issues. See `bd help init-safety` and the `pk-fork-refused` recovery note in bd's
  docs.
- **Fail loud:** if any clone's post-adoption `bd dolt pull` is not clean, stop the
  rollout, keep everyone frozen, and escalate — a silent fork is worse than a paused
  backlog.
