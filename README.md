# anton

**A local, single-user app that turns ideas and code-scan findings into approved epics and executes them autonomously.** anton shapes work into epics, waits for your approval, then runs each epic in an isolated git worktree — driving `claude` to implement it, running your tests, and opening a pull request per unit of work. It watches the PR and auto-resolves review comments and CI failures. Epic-first, approval-gated, agent-driven.

anton is the successor to the `loom` Claude Code plugin: it keeps loom's shaping and specialist agents and its execution/durability model, and wraps them in a Next.js UI with multi-project support, a live terminal, and durable background jobs.

> **Local, not deployed.** anton runs as a Next.js server on your machine and drives your local `claude`, `git`, `gh`, `bd`, and `stringer`. It is not a hosted service. See [`DESIGN.md`](./DESIGN.md) for the full architecture.

## What it does

The core loop:

```
Add a repo  →  /shape an epic (interactive)  →  it lands in "backlog"
            →  you Approve the epic
            →  anton runs it: worktree → claude (+ agent prompt) → tests → commit → PR
            →  epic moves to "in-review" with a live terminal + PR link
            →  review-fix watches the PR: resolves review comments + CI failures, pushes, re-requests review
```

Plus two scheduled background jobs, per project:

- **nightly-stringer** — scans the repo for actionable signals (`stringer scan --delta`) and triages the few worth doing into well-formed beads.
- **orphan-grooming** — buckets loose tickets (no parent epic) under a grooming epic so they become approvable work.

**beads is the source of truth for work.** Epics, tickets, approval, stage, and the PR link all live in each repo's `.beads/` (queried via `bd`). anton's own SQLite (`anton.db`) holds only machine-local execution state: projects, runs, jobs, schedules, and sessions — it's disposable and git-ignored.

## Prerequisites

anton drives external CLIs. Install these and make sure they're on your `PATH`:

| Tool | Required | Used for |
|------|----------|----------|
| **node ≥ 20** (or **bun**) | ✅ | runtime / package manager |
| **git** | ✅ | worktrees, commits, push |
| **bd** ([beads](https://github.com/gastownhall/beads)) | ✅ | the work source of truth |
| **claude** ([Claude Code](https://claude.com/claude-code)) | ✅ | the executor (headless + interactive) |
| **gh** ([GitHub CLI](https://cli.github.com)) | ⬜ | PRs + review-fix |
| **stringer** | ⬜ | nightly scan → beads |

Run `anton doctor` at any time to check what's present.

## Install & run

```bash
bun install      # install dependencies
anton setup      # check prerequisites, run DB migrations, rebuild node-pty
anton start      # build if needed, then start the server on http://localhost:3000
```

`anton` is the shipped CLI (wired via package.json `bin`). During local development you can also use the scripts directly:

```bash
anton dev        # or: bun run dev   — Next.js dev server (hot reload)
anton start      # or: bun run build && bun run start
```

The **job runner and cron scheduler start automatically** with the server (via `src/instrumentation.ts`), so approved epics execute and scheduled jobs fire without any extra process. Set `ANTON_RUNNER=off` to boot the UI without them.

### CLI

```
anton setup    check prereqs, run DB migrations, rebuild node-pty
anton doctor   check prereqs + anton.db (non-destructive)
anton dev      run the dev server (next dev)
anton start    build if needed, then run the server (next start)
anton --help   show help
```

## Using it

1. **Add a project** — point anton at a local repo that has a `.beads/` directory (run `bd init` in it if not).
2. **Shape an epic** — "Add work" opens an interactive `/shape` session in the browser terminal; the result lands in **backlog**.
3. **Approve** — review the epic's Goal + Acceptance + tickets on the board and click **Approve**. anton only ever executes approved epics.
4. **Watch it run** — the epic moves to **implementing** with a live terminal, then to **in-review** with a PR link once all tickets are done.
5. **Let review-fix work the PR** — it polls the PR, and when a reviewer requests changes or CI fails, it dispatches `claude` to resolve, pushes, and re-requests review.

Per-project settings (model, execution seed prompt, review-fix prompt, test command, base branch) are editable in the **Settings** page.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTON_DB` | `./anton.db` | SQLite path for machine-local state |
| `ANTON_RUNNER` | on | set `off` to boot the UI without the job runner + scheduler |
| `ANTON_WORKTREES_ROOT` | sibling of the repo | where run worktrees are created |
| `ANTON_SESSIONS_ROOT` | `./.anton/sessions` | claude session logs |
| `ANTON_SCANS_ROOT` | `./.anton/scans` | stringer scan files |

Default per-project schedules are seeded on project creation: review-fix every 15 min, nightly-stringer at 03:00, orphan-grooming weekly (Mon 04:00). Edit or disable them in project settings.

## Development

```bash
bun run lint         # eslint
bun run typecheck    # tsc --noEmit
bun run test         # vitest (unit + integration; integration suites self-skip
                     # when bd/gh/stringer/claude aren't installed)
bun run build        # next build
```

- **Pre-commit** — a husky hook runs `lint-staged` (eslint --fix on staged `.ts`/`.tsx`) then `typecheck`. Installed automatically on `bun install`.
- **CI** — `.github/workflows/ci.yml` runs lint + typecheck + test + build on every push to `main` and every PR.
- **Release** — pushing a `v*` tag runs the same gates and cuts a GitHub Release (`.github/workflows/release.yml`).
- **Issue tracking** — this repo uses **bd (beads)**, not markdown TODOs. `bd ready` to find work, `bd show <id>` for detail.

## Stack

Next.js 16 (App Router, RSC) · React 19 · Tailwind 4 · shadcn/ui · Drizzle + better-sqlite3 · node-pty + @xterm/xterm · in-process durable job runner · bun (pm) / node (runtime).
