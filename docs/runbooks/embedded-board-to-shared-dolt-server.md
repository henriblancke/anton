---
title: "Runbook: move an embedded beads board onto a shared Dolt server"
type: runbook
status: validated
date: 2026-08-18
ticket: anton-yvjd
---

# Runbook: embedded board → shared `dolt sql-server`

## Summary

A project's board is either **embedded** — a Dolt database under `.beads/embeddeddolt/<db>/`, one
copy per machine, reconciled over `refs/dolt/data` — or **served** by one `dolt sql-server` every
machine reads and writes directly (DESIGN.md §3a). This runbook moves an existing board from the
first to the second **with its Dolt commit history intact**, and it is **per project**: each project
is moved on its own, into its own database on the server.

The move has two halves:

| Half | Who does it | What |
|---|---|---|
| **Data** | you, by hand (this runbook) | stream the project's Dolt database directory into the server's data volume |
| **Config** | `anton server-mode` | write `.beads/metadata.json`, verify with `bd dolt test`, prove the board reads back whole, publish the connection as the team default |

They are deliberately separate. anton does not move your data, and the command refuses to finish if
the data has not arrived — see [Why not `bd dolt push`](#why-not-bd-dolt-push).

**Nothing here deletes the embedded copy.** It stays exactly where it is: it is the real history
backup, and the escape hatch if the server goes away.

---

## Preconditions

- A reachable `dolt sql-server` you run, and shell/ssh access to the host with permission to stop
  and start it and to write its data volume. **Provisioning that server is out of scope** — this
  runbook assumes it exists.
- A database **user reachable from your machines** (`'<user>'@'%'`, not the image's default
  `root@localhost`) with rights on this project's database. On the `dolthub/dolt-sql-server` image
  the root account is created host-scoped at first init; `-e DOLT_ROOT_HOST='%'` (and
  `DOLT_ROOT_PASSWORD`) is how it becomes reachable. Prefer a per-project account over root.
- `bd` ≥ 1.1.0 and anton on the machine you run the move from.
- The project is currently embedded: `.beads/embeddeddolt/<db>/` exists.
- **The server's Dolt version reads your storage format.** `dolt-sql-server` 2.3.0 serves a
  bd-written `DOLT`-format database directly — no migration step. Check `dolt version` on the server
  if it is older than the bd that wrote the database.

---

## The runbook

Throughout: `PROJECT` is the repo, `DB` the database name (bd's `dolt_database` — the directory name
under `.beads/embeddeddolt/`), `HOST`/`PORT`/`USER` the server, and `VOLUME` the server's data
volume (`/var/lib/dolt` inside the official image).

### Phase 0 — Freeze

1. **Stop anton** (`anton stop`) and any agent or shell that writes this board. Copying a database
   directory that is being written is how you get a half-committed board on the server.
   `bd dolt stop` is not the tool here: on bd ≥ 1.1 an embedded board has no server process to stop
   ("not supported in embedded mode"). What matters is that **no `bd` is running**.
2. **Take the backups.** Two, because they cover different failures:

   ```bash
   cd PROJECT
   bd export --all -o /tmp/DB-pre-switch.jsonl    # interchange snapshot: issues, no history
   cp -R .beads/embeddeddolt/DB /tmp/DB-dolt-backup   # the history — this is the real backup
   ```

   `anton server-mode` takes the JSONL export for you (into `.beads/backups/`, self-ignored) — the
   directory copy is yours to take. Keep both until the server board has been verified.

### Phase 1 — Copy the database onto the server

Stream the database directory into a **staging directory** in the server's volume, then swap it into
place while the server is down. Staging first means a partial transfer is never served.

```bash
cd PROJECT
COPYFILE_DISABLE=1 tar cf - -C .beads/embeddeddolt DB \
  | ssh SERVER_HOST 'docker run --rm -i -v VOLUME:/dest alpine \
      sh -c "mkdir -p /dest/.staging && tar xf - -C /dest/.staging"'
```

`COPYFILE_DISABLE=1` is **not optional on macOS**: BSD `tar` otherwise writes an AppleDouble `._*`
file beside every entry, and Dolt serves every directory under its data dir as a database — a `._DB`
lands in `SHOW DATABASES` as garbage. (`--exclude '._*'` does not help: those entries are generated
during archiving, not read from disk.)

Then, on the server host:

```bash
docker stop dolt                                   # quiesce before swapping
docker run --rm -v VOLUME:/dest alpine \
  sh -c 'mv /dest/.staging/DB /dest/DB && rmdir /dest/.staging'
docker start dolt                                  # Dolt picks up new databases at start
```

**Replacing an existing database rather than adding one?** Park the old copy under a **dot-directory**
(`mv /dest/DB /dest/.old-DB`) or delete it. A plain `DB.old` is served as a database named `DB.old`
and shows up in `SHOW DATABASES` — confusing at best.

Confirm the server sees it:

```bash
docker exec dolt dolt sql -q 'SHOW DATABASES;'      # read-only queries are safe while it runs
docker exec dolt sh -c 'cd /var/lib/dolt/DB && dolt log --oneline | head'
```

The `dolt log` output is the point of this whole approach: it is the project's real commit history
(`bd: create <id>`, `bd init`, the schema migrations), not a re-imported flat file.

### Phase 2 — Point the project at the server

From the project, on each machine:

```bash
export BEADS_DOLT_PASSWORD_<USER>='…'     # uppercased user, non-alphanumerics folded to _
anton server-mode PROJECT --host HOST --port PORT --user USER --database DB
```

That command is the whole config half. It:

1. reads the board's issue ids as it stands, and **backs it up** (`bd export --all` into
   `.beads/backups/`, skip with `--no-backup`);
2. writes `dolt_mode`/host/port/user/database into `.beads/metadata.json`, preserving every other
   key in that file;
3. runs **`bd dolt test`**;
4. **reads the board back from the server** and confirms every pre-switch issue id is present in
   the server's copy — by identity, not cardinality, because a stale or divergent copy of the same
   project can hold as many issues (or more) while missing the ones written here since it diverged;
5. publishes the connection into `.beads/config.yaml` (`bd dolt set … --update-config`) as the
   team-wide default, so the next clone inherits the target.

**Any failure in 3–5 reverts `.beads/metadata.json` byte-for-byte** and exits non-zero — the project
keeps working exactly as it did. The two failures you are most likely to see:

- *"the server accepted the connection but this project cannot read its board … PROJECT IDENTITY
  MISMATCH"* — the database on the server belongs to a different project (`project_id` in
  `metadata.json` vs. the database's). You pointed at the wrong database, or Phase 1 has not
  happened. **`bd dolt test` passes in this state** — connecting is not the same as being able to
  read, which is why the command checks both.
- *"the server's … database is missing N of this board's M issues (…)"* — the server is reachable
  and is this project's, but the copy did not land, landed in another database, or is a stale copy
  from an earlier attempt. The named ids are the ones to look for. Re-run Phase 1. `--force` accepts
  the gap deliberately; it is for starting a fresh board, not for finishing this runbook.

Also worth knowing: the password variable is **per user** (`BEADS_DOLT_PASSWORD_BEADS` for user
`beads`) and that mapping is anton's, applied when anton spawns bd. A `bd` you run **by hand** reads
only the plain `BEADS_DOLT_PASSWORD` — set that too if you drive bd directly. Add
`BEADS_DOLT_SERVER_TLS=true` when the server sets `require_secure_transport` (and make sure it is
**not** set for a server without TLS — a stray one fails with "TLS requested but server does not
support TLS").

### Phase 3 — Verify, then let go

1. **The same board, from a second machine.** On another clone — one with no local Dolt DB at all —
   run the same `anton server-mode …` command and confirm it reports the same issue count. That is
   the whole point of the move: the second machine hydrates nothing and syncs nothing. (On that
   machine the arrived-whole check compares the server against a board with nothing local in it, so
   it passes trivially — the count it prints is the assertion worth reading.)
2. **Spot-check content**, not just cardinality: `bd list --status all | tail`, one `bd show <id>`
   with dependencies and labels.
3. **Drop the stale `refs/dolt/data` remotes.** They came over from embedded mode and are now inert
   at best: `bd dolt push/pull` in server mode executes ON the server, which has no git credentials
   and no ssh client, so it fails with `command denied to user`. anton skips every sync pass for a
   server-mode board, so this is tidiness, not a fix — `bd dolt remote list` then
   `bd dolt remote remove origin`.
4. **Only then** consider removing `.beads/embeddeddolt/DB` on each machine. There is no hurry:
   it is gitignored, and it is what you fall back to if the server goes away (set `dolt_mode` back
   to `embedded` and keep working).

---

## Why not `bd dolt push`

The obvious path — `bd dolt remote add` on the server-mode board, then `bd dolt push` — **cannot
work**, and this is not a configuration problem. In server mode the pull/push executes **on the
server**, and the `dolt-sql-server` image ships **no ssh client and no keys**, so a `git+ssh://`
remote is unreachable from there by construction. Confirmed on the image: `ssh` is absent.

Nor is `bd export` → `bd import` an acceptable substitute: it moves *issues*, not *history*. The
board's Dolt commits — who changed what, when — do not survive a JSONL round trip. Copying the
database directory is what preserves them.

---

## Validation evidence

Validated twice.

**In production (2026-08-17)** — two boards moved onto one shared `dolt-sql-server` 2.3.0: `anton`
(637 issues) and `planar` (418). Storage format `DOLT` was read directly by 2.3.0 with no migration
step. `bd dolt remote add` + `bd dolt push` was tried first and confirmed impossible (`ssh` absent
from the image); the stale `origin` remotes carried over from embedded mode were removed.

**End-to-end against this runbook (2026-08-18, anton-yvjd)** — a throwaway embedded board (2 issues)
copied by the Phase 1 command into a local `dolthub/dolt-sql-server:2.3.0` volume, then:

- `anton server-mode … --database <the empty second database>` → **refused and reverted**
  (`PROJECT IDENTITY MISMATCH`), with `bd dolt test` passing in that same state;
- `anton server-mode … --database <the copied database>` → configured, `2 issues` read back from the
  server;
- a **second workspace** carrying only `.beads/config.yaml` + `.beads/metadata.json` and **no local
  Dolt DB** read the full board (`bd list --status all` → 2 issues) and ran `anton server-mode`
  clean;
- `dolt log --oneline` on the server copy showed the original per-write commits (`bd: create …`,
  `bd init`, the schema migrations) — **history preserved**.
