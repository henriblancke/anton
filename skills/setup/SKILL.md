---
name: setup
version: 857383b9871d
description: >-
  Scaffold a project so anton's skills have the `.product/` contract they read. Checks git + bd,
  runs `bd init` if `.beads/` is absent, detects the stack, generates `.product/` from anton's
  bundled templates (idempotent — skips anything already present), runs a ≤4-question PRODUCT
  interview, and proposes (never forces) an AGENTS.md pointer. Use when a repo has no `.product/`
  yet, or when `/shape` / `/scan-triage` tells you to run `/setup` first.
disable-model-invocation: true
---

# /setup — scaffold an anton project

anton's skills (`/shape`, `/scan-triage`) read a project-local `.product/` layer before they do
anything. This skill creates that layer — plus `.beads/` — in the current repo. It has **no
external dependency**: the shapes come from anton's own bundled templates, not a plugin. Run it
once per repo; it is **idempotent** — it skips anything already present, so re-running is safe.

## 1. Preconditions (fail loud)

- Confirm the cwd is a git repo (`git rev-parse --is-inside-work-tree`). If not, tell the user
  and offer `git init` — do **not** run it unasked.
- Capture the repo root with `git rev-parse --show-toplevel` and treat it as the anchor for
  **every** repo-local read and write below (`.beads/`, `.product/`, `AGENTS.md`/`CLAUDE.md`).
  When `/setup` is invoked from a subdirectory the cwd check still passes, so anchoring here is
  what keeps beads and `.product/` at the repository root instead of scaffolding them into
  whatever nested package directory you happen to be in.
- Confirm `bd` is installed (`bd version`). If missing, tell the user to install beads and stop
  here — nothing downstream works without it.

## 2. Initialize beads

Check for `.beads/` **at the repo root** (from step 1). This is the ONE reconciled `bd init` flag
set anton uses everywhere (it matches `configureBeadsForRepo` in `src/lib/beads/config.mjs`, exported
as `BD_INIT_FLAGS` — keep the two in sync). Cases:

- **`.beads/` absent** → run `bd init --non-interactive --skip-hooks --skip-agents --dolt-auto-commit on`
  from the repo root. The flags keep `bd init` safe for an agent-run scaffold and stop it from
  mutating the repo before the consent gate in step 6:
  - `--non-interactive` — a bare `bd init` can drop into interactive setup wizards and prompt for
    input, which would hang an agent-run `/setup`. This flag skips every prompt and uses sensible
    defaults (`maintainer` role). It's auto-detected under CI/non-TTY, but pass it explicitly so
    `/setup` is safe regardless of how it's invoked.
  - `--skip-hooks` — a bare `bd init` installs its own git hooks and overwrites `core.hooksPath`,
    which would silently disable an existing Husky / lefthook / custom-`hooksPath` setup. Skip them
    so `/setup` never clobbers the project's hook config uninvited (anton pushes Dolt explicitly on
    every write, so bd's hydration hooks are redundant here anyway).
  - `--skip-agents` — a bare `bd init` writes/updates `AGENTS.md` by default, which would edit the
    repo's agent instructions before the user has agreed (see step 6).
  - `--dolt-auto-commit on` — commit-after-each-write from the very first write, so nothing is left
    uncommitted in the Dolt working set.
- **`.beads/` present but no local Dolt DB** (a fresh clone — `.beads/config.yaml` is committed but
  the Dolt runtime under `.beads/dolt/` is gitignored and never travels with the clone) → run
  `bd bootstrap --non-interactive` from the repo root. Bootstrap hydrates the DB and wires the Dolt
  remote from origin's `refs/dolt/data` — the recommended path for a fresh clone or a new machine.
- **`.beads/` present with a local Dolt DB** → an already-initialized workspace; skip.

Then confirm `bd ready --json` works. If `bd init`/`bd bootstrap` errors, **stop and say so** — do
not leave a half-initialized project.

### 2b. Install anton's formulas

Copy both files from `${CLAUDE_SKILL_DIR}/templates/.beads/formulas/` to
`<repo-root>/.beads/formulas/`:

- `anton-bead.formula.json` — the bead SKELETON.
- `anton-run.formula.toml` — the run PIPELINE.

**No-clobber — if a file already exists, leave it alone and report it as skipped**: a project that
has tuned its own bead skeleton or pipeline keeps it.

The bead formula is the skeleton `/shape` and anton's Add-work UI pour every bead from (one step per
tier, the contract sections pre-stubbed), so the conformant shape is structural instead of a prompt
remembering five headings. The run formula is the pipeline anton walks for a run — implement, verify,
commit, self-review, open the PR — with each step naming its handler via a `step:<name>` label; edit
it and the project owns its own pipeline. anton validates it at run start, so a broken one parks the
run before any worktree is created rather than halfway through.

One pipeline need not fit every ticket: a project can add more formulas beside it (say
`anton-run-risk-high.formula.toml`) and map a bead label to one in **Settings → Pipeline variants**,
so a `risk:high` target walks the heavier pipeline while everything else walks the default. The
first mapping in that list whose label the run target carries wins, and every variant is held to the
same floor. Nothing to do here — mention it only if the project asks for per-risk process.

Both belong under `.beads/` because git tracks that directory — only the JSONL exports and the Dolt
runtime are ignored — so the project's bead shape and pipeline reach every clone and teammate.
Confirm with `bd formula list` (it should list `anton-bead` and `anton-run`).

### 2c. Board mode — embedded (default) or shared server

Step 2 leaves the board **embedded**: a Dolt database under `.beads/` on this machine, shared with
teammates by `bd dolt push/pull` over `refs/dolt/data` on the git remote. That is the default, it
works offline, and **it needs nothing from you here** — skip the rest of this section unless the
project asks for the alternative.

**Server mode** points the project at one `dolt sql-server` that every machine reads and writes
directly, so a team sees one board in real time with no push/pull lag. Offer it only when the
project actually has that problem — teammates blocked on sync lag — because it trades offline
tolerance for it: there is no local copy, so while the server is unreachable the board is
unavailable. Both modes are described in DESIGN.md §3a, including the failure behaviour of each.

**Never switch a project to server mode unasked.** It needs infrastructure the team runs (a
reachable `dolt sql-server`, a database for this project, and a database user for it). Confirm those
exist before touching config; if they don't, say so and stop — leaving the project embedded is the
correct outcome, not a half-configured server.

Configuring it is **one command per project**, run in the repo:

```bash
export BEADS_DOLT_PASSWORD_<USER>='…'     # uppercased user, non-alphanumerics folded to _
anton server-mode . --host <host> --port <port> --user <user> --database <this project's database>
```

It writes `.beads/metadata.json`, verifies the connection with `bd dolt test`, **reads the board
back from the server** and compares the issue count with what the project had before, then publishes
the connection into `.beads/config.yaml` (`bd dolt set … --update-config`) as the team-wide default
so the next clone inherits the target. **Any failure after the write reverts `metadata.json`
byte-for-byte** and exits non-zero — a project is never left pointed at a server it cannot read.
Report the failure and stop; do not hand-edit around it.

What it writes, for reference — this file is **committed**, so it must never hold a password:

```json
{
  "dolt_mode": "server",
  "dolt_server_host": "dolt.example.dev",
  "dolt_server_port": 3306,
  "dolt_server_user": "beads",
  "dolt_database": "<this project's database>"
}
```

`dolt_mode` cannot come from bd: `bd config set dolt.mode server` reports success while writing a
nested block into a file of flat dotted keys, from bd's lowest-priority source — it has no effect
(anton-4gd2), which is why the command writes the file directly. Keep `dolt_server_port` even if bd
warns it is deprecated — without it bd dials port 0 against a remote host.

**The password lives in the environment, scoped to the database user** —
`BEADS_DOLT_PASSWORD_<USER>`, uppercased with non-alphanumeric runs folded to `_` (a user `beads`
wants `BEADS_DOLT_PASSWORD_BEADS`). A bare `BEADS_DOLT_PASSWORD` still works as the fallback for
every project — the one-shared-account setup — but a per-user variable is what lets each project
have its own account. Add `BEADS_DOLT_SERVER_TLS=true` when the server sets
`require_secure_transport`.

Set **nothing else** `BEADS_DOLT_*` in a shell anton runs from. Env is bd's highest-priority config
source, so a stray `BEADS_DOLT_SERVER_DATABASE` in an `.envrc` points *every* project's bd at that
database. anton strips those identity vars per spawn (`src/lib/beads/bd-env.ts`), but a `bd` you run
by hand has no such protection — and note that the per-user password variable is anton's mapping, so
a hand-run `bd` reads only the plain `BEADS_DOLT_PASSWORD`.

**Moving an EXISTING board onto a server is a two-part job** and the command above is only the
second part. The board's history is a Dolt database directory that has to reach the server's data
volume first: follow **`docs/runbooks/embedded-board-to-shared-dolt-server.md`**, which a human runs
(back up with `bd export --all` first — the command also takes its own export into
`.beads/backups/`). Do **not** substitute `bd export` → `bd import`: that moves issues and drops the
Dolt commit history. Do not reach for `bd dolt remote add` + `bd dolt push` either — in server mode
the push executes ON the server, and the `dolt-sql-server` image has no ssh client and no keys, so a
git remote is unreachable from there. `anton server-mode` refuses (and reverts) when the copy has
not happened, so run it *after* the runbook's data phase, and keep the embedded copy until the
server board is verified.

One expected wart in server mode: `anton init` no longer wires a `refs/dolt/data` remote for a
server-mode board, but one wired earlier (or by a bare `bd init`) stays in place and is simply inert
— anton skips every sync pass for a server-mode board, and the pickup protocol it teaches sessions
(`.beads/PRIME.md` §2) drops the pull/publish/settle steps on a shared server. A `bd dolt push/pull`
run by hand still executes *on the server*, which has no git credentials, and fails with `command
denied to user`. That is noise, not data risk (anton-0tul); `bd dolt remote remove origin` tidies it.
The profile also pins `backup.enabled false` for the same reason — bd's auto-backup registers its
remote on the server as this project's account, which is not privileged for it, so every write would
otherwise end in `Warning: auto-backup failed: register backup remote`.

## 3. Detect the stack

Inspect the repo and infer what applies. This drives the PRODUCT `## Stack` line and which agents
you suggest — it is **not** written to `config.yaml` (see step 4):

- `package.json` with `next` → **Next.js** (agent `nextjs`).
- `drizzle-orm` / `drizzle-kit` in `package.json`, or a `drizzle.config.*`, or a `pg` / `postgres`
  dep → **Postgres via Drizzle** (note it on the `## Stack` line; there's no Drizzle-specific
  agent — the `nextjs` agent covers the app layer). `@supabase/*` or a `supabase/` dir → offer
  the `supabase` agent instead.
- `pyproject.toml` with `fastapi` → **`fastapi`** (+ `pydantic`, and `alembic` if `alembic/` or
  `alembic.ini` is present). Python agents are **opt-in** — propose, don't assume.
- `Dockerfile` → offer `docker`; `*.tf` → offer `terraform`; `Chart.yaml` / `helm/` / `k8s/` →
  offer `kubernetes`. Infra agents are **opt-in** — propose, let the user confirm.

anton reads the active-agents list from its own settings, not from the repo, so you don't record
the agent set anywhere here — just report the detected stack and note which agents apply.

## 4. Generate `.product/`

Copy the shapes from the **`${CLAUDE_SKILL_DIR}/templates/.product/`** directory bundled alongside
this skill into the repo's `.product/` **at the repo root** (from step 1), not `./.product/`
relative to the cwd. `${CLAUDE_SKILL_DIR}` is the directory holding this
`SKILL.md`, so it resolves to the templates whether `/setup` is installed globally
(`~/.claude/skills/setup/`) or per-project — **not** the current working directory. **Idempotent —
skip any file that already exists; never overwrite.** Create:

- **`PRODUCT.md`** — from the template, then fill it from the interview in step 5. Set the
  `## Stack` section from the detection in step 3.
- **`config.yaml`** — copy the template **verbatim**. anton reads exactly one field from it,
  `stringer.max_beads_per_scan`; everything else (merge policy, agents, hard-floor test/lint/
  typecheck commands) anton reads from its own settings DB, **not** this file. Do **not** add
  `stack:` or `agents:` keys — they would be ignored.
- **`principles.md`** — from the template (implement only Acceptance / park drive-bys; `size:L`
  is a smell; every bead states its `## Verify`). If the stack is Supabase, keep the template's
  RLS / `security_invoker` / `app_metadata` seeds; otherwise drop the Supabase-specific block.
- **`learnings.md`** — from the template (the `YYYY-MM-DD [tag]` header, `## New` / `## Compacted`).
- **`decisions/`** and **`entities/`** — create the dirs with their one-paragraph READMEs from
  the templates.

## 5. PRODUCT interview (≤4 questions)

Ask **at most four** questions, one at a time, to fill `PRODUCT.md`. Skip any the repo already
answers. Cover:

- What is it, and what real problem does it solve?
- Who is it for (the specific person/segment)?
- Why does it win — the wedge vs. what they do today?
- What are we deliberately **not** doing (product-level non-goals)?

Fill the file from the answers. Leave a `<!-- TODO -->` where the user defers. **Don't invent
facts** — a thin, honest PRODUCT.md beats a padded one.

## 6. Wire the project (propose, don't force)

**Offer** to add a short pointer to the repo's `AGENTS.md` / `CLAUDE.md`:

> This repo uses anton — work is tracked in `.beads/`; project rules live in
> `.product/principles.md`, product context in `.product/PRODUCT.md`.

Only add it if the user agrees. Never rewrite their existing agent instructions.

## 7. Report

List what was **created** vs **skipped** (idempotency), the board mode (**embedded** unless the
project explicitly moved to a shared server in step 2c), the detected stack and which agents apply,
and the next steps: run `/shape` to turn an idea into beads, then let anton's runtime execute the
board. Fail loud on any precondition or `bd init` error — don't report success over a broken state.
