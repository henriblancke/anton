---
name: setup
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

Check for `.beads/` **at the repo root** (from step 1). If it is absent, run `bd init --skip-agents`
from the repo root. The `--skip-agents` flag is required: a bare
`bd init` writes/updates `AGENTS.md` by default, which would edit the repo's agent instructions
before the consent gate in step 6 — pass `--skip-agents` so anton only touches `AGENTS.md` with
the user's say-so. Then confirm `bd ready --json` works. If `bd init` errors, **stop and say so** —
do not leave a half-initialized project. If `.beads/` already exists, skip.

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

List what was **created** vs **skipped** (idempotency), the detected stack and which agents apply,
and the next steps: run `/shape` to turn an idea into beads, then let anton's runtime execute the
board. Fail loud on any precondition or `bd init` error — don't report success over a broken state.
