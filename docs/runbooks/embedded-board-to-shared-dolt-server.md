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

From the project, on each machine — starting with the one Phase 1 was copied from, whose board still
matches the server's. A second machine carrying its own embedded copy is checked against the server
the same way, so anything either side wrote after the copy is reported rather than silently dropped
(see step 5 and the failure list below).

```bash
export BEADS_DOLT_PASSWORD_<USER>='…'     # uppercased user, non-alphanumerics folded to _
anton server-mode PROJECT --host HOST --port PORT --user USER --database DB
```

That command is the whole config half. It:

1. reads the board's issue ids as it stands, and **backs it up** (`bd export --all` into
   `.beads/backups/`, skip with `--no-backup`);
2. re-reads those ids immediately before the switch and **refuses if the board moved** — the export
   above takes minutes on a big board, and an issue written in that window would be missing from
   the server without the check in 5 ever seeing it (skipped under `--force`, which accepts the
   server's board unverified anyway);
3. writes `dolt_mode`/host/port/user/database into `.beads/metadata.json`, preserving every other
   key in that file;
4. runs **`bd dolt test`**;
5. **reads the board back from the server** and confirms it is this board, whole and current — every
   pre-switch issue id present, and every issue saying there *exactly* what it says here (an id only
   the *server* holds is reported, not refused — see the warning below). By
   identity and content, not cardinality: a stale or divergent copy of the same project can hold as
   many issues (or more) while missing the ones written here since it diverged, and a snapshot
   copied a week ago holds every id while its titles, statuses and labels predate the board being
   moved. A difference is refused in **both** directions — a newer `updated_at` on the server orders
   the two writes without merging them, so it is no proof that row carries this board's edits;
6. publishes the connection into `.beads/config.yaml` (`bd dolt set … --update-config`) as the
   team-wide default, so the next clone inherits the target.

**Any failure in 4–6 reverts `.beads/metadata.json` byte-for-byte** and exits non-zero — the project
keeps working exactly as it did (1–3 fail before anything is written at all). The failures you are
most likely to see:

- *"the server accepted the connection but this project cannot read its board … PROJECT IDENTITY
  MISMATCH"* — the database on the server belongs to a different project (`project_id` in
  `metadata.json` vs. the database's). You pointed at the wrong database, or Phase 1 has not
  happened. **`bd dolt test` passes in this state** — connecting is not the same as being able to
  read, which is why the command checks both.
- *"the server's … database is missing N of this board's M issues (…)"* — the server is reachable
  and is this project's, but the copy did not land, landed in another database, or is a stale copy
  from an earlier attempt. The named ids are the ones to look for. Re-run Phase 1. `--force` accepts
  the gap deliberately; it is for starting a fresh board, not for finishing this runbook.
- *"the server's … database holds all of this board's ids but N issues say something different there
  (…)"* — step 5, the other half of it. The two copies were edited apart, so switching would strand
  every one of those differences in the database being left behind. The message says which way round
  it is. *The copy on the server predates this board* — a snapshot taken before those beads were
  last written (an earlier Phase 1 attempt, or a stale export): re-run Phase 1 with a **current**
  copy. *Written last on the server* — someone kept writing one of the two boards after the copy;
  a later timestamp orders those writes, it does **not** merge them, so the server's row can be
  newer and still be missing a bead you closed here. Reconcile the two boards (compare a `bd list
  --json` from each); `--force` is right only when this machine's board is a leftover copy nobody
  has written since it was copied. If it names *every* issue on the board, the boards did not really
  diverge — nothing edits a whole board at once — it is the two sides printing the same rows
  differently; compare those listings before forcing.
- *"the board being moved changed while the switch was being prepared — N issues appeared,
  disappeared or were edited"* — step 2. Something is still writing this board (anton, an agent, a
  shell), so neither the backup nor the arrived-whole check covers what it wrote. The comparison is
  per-issue **content**, not just the id set, so a bead someone merely closed or relabelled trips it
  too — that update would otherwise be stranded in the embedded database the move is leaving behind.
  Phase 1 step 1 is the fix: `anton stop`, close the writers, re-run.
- *"… metadata.json is not valid JSON …"* — `.beads/metadata.json` exists and cannot be parsed. The
  switch writes that file by *merging* into it, so an unreadable one would be replaced outright,
  losing `project_id`, `backend` and everything else bd keeps there. The command refuses and writes
  nothing — **`--force` does not override this one**. Restore the file (from `.beads/backups/`, or
  git) and re-run.
- *"could not read the board being moved: …"* — step 1 failed, so step 5 has nothing to check the
  server's copy against. The command stops **before** backing up or writing anything. Fix the read
  (a stopped embedded server, a missing password variable) and re-run; `--force` switches anyway and
  accepts the server's board unverified. A genuinely **empty** board reads this way too — bd prints
  an empty listing that cannot be told apart from no listing at all — and `--force` is the right
  answer for it: there is nothing to lose track of.

**A warning rather than a failure — *"… holds N issues this board does not"*.** Step 5 checks that
everything on *this* board reached the server; ids only the **server** has are the other direction,
and they strand nothing, so they do not stop the switch. They are still worth a look, because two
different things wear that shape and nothing bd prints tells them apart: issues created on the
server after Phase 1 copied it (normal — you are joining a board that moved on without this
machine), or issues **deleted here** after that copy, which the server still carries and the switch
has just brought back. `bd show <id>` the named ids: keep them, or delete them again on the now-
shared board.

**A warning rather than a failure — *"… still holds a local embedded Dolt database"*.**
`.beads/metadata.json` is **tracked**, so once the flip is committed and pushed every other clone
switches to the server on its next `git pull` — before anyone has looked at that machine's board.
From then on `anton server-mode` *on that clone* reads the server on both sides of every check: it
passes, and it proves nothing about the embedded database still sitting in that clone's `.beads/`,
so the command says so instead of reporting a verification it did not make. Usually that database is
the leftover Phase 3 step 4 says to keep and there is nothing to do. If it might hold writes that
never reached the server — the clone was in use while Phase 1 ran — check it before deleting it: put
`dolt_mode` back to `"embedded"` in `.beads/metadata.json` (`git stash` the pulled change), run
`bd list --status all --json`, compare it with the server's listing, then re-run the command. Landing
the `metadata.json` commit only after every clone has been checked avoids the question entirely.

Also worth knowing: the password variable is **per user** (`BEADS_DOLT_PASSWORD_BEADS` for user
`beads`) and that mapping is anton's, applied when anton spawns bd. A `bd` you run **by hand** reads
only the plain `BEADS_DOLT_PASSWORD` — set that too if you drive bd directly. If another project
already uses an account of the same name on a *different* server, scope this one's password by
server as well — `BEADS_DOLT_PASSWORD_<HOST>_<PORT>_<USER>` (e.g.
`BEADS_DOLT_PASSWORD_DOLT_EXAMPLE_DEV_3306_BEADS`) — which anton prefers over the per-user variable;
without it both projects resolve to the same secret and one of them cannot authenticate. The name is
derived, not escaped: every run of non-alphanumerics folds to a single `_`, so two hosts that differ
only in *which* punctuation they use (`db-a.example.com` and `db.a-example.com`) fold to one
variable. If you own such a pair, name their accounts differently — the per-user variable then keeps
the two secrets apart.

Transport is per project too: pass **`--tls`** when the server sets `require_secure_transport`, and
`--no-tls` when it does not. Either writes `dolt_server_tls` into this project's `metadata.json`,
which is what lets one anton drive a TLS server and a plaintext one — the ambient
`BEADS_DOLT_SERVER_TLS` is a single value for every project, and the wrong one fails with "TLS
requested but server does not support TLS" (or its inverse). A project that declares neither
inherits that variable, as before.

### Phase 3 — Verify, then let go

1. **The same board, from a second machine.** On another clone — one with no local Dolt DB at all —
   run the same `anton server-mode …` command and confirm it reports the same issue count. That is
   the whole point of the move: the second machine hydrates nothing and syncs nothing. (On that
   machine the arrived-whole check compares the server against a board with nothing local in it, so
   it passes trivially — the count it prints is the assertion worth reading. On a clone that *does*
   still carry `.beads/embeddeddolt`, the command warns that it compared nothing local; see the
   warning note above.)
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
