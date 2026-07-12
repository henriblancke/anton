# anton

**A local, single-user app that turns ideas and code-scan findings into approved epics and executes them autonomously.** anton shapes work into epics, waits for your approval, then runs each epic in an isolated git worktree — driving `claude` to implement it, running your tests, and opening a pull request per unit of work. It watches the PR and auto-resolves review comments and CI failures. Epic-first, approval-gated, agent-driven.

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

The **job runner and cron scheduler start automatically** with the server (via `src/instrumentation.ts`), so approved epics execute and scheduled jobs fire without any extra process. Set `ANTON_RUNNER=off` to boot the UI without them.

### CLI

```
anton setup    check prereqs, run DB migrations, rebuild node-pty
anton doctor   check prereqs + anton.db (non-destructive)
anton dev      run the dev server (next dev)
anton start    build if needed, then run the server (next start)
anton --help   show help
```

## Using anton

Once the server is up at `http://localhost:3000`, a full turn of work looks like this:

1. **Add a project.** From the projects screen, add a local repo that has a `.beads/` directory (run `bd init` in it first if it doesn't). anton records the repo path and detects its default branch; beads and git in that repo are never modified by adding it.
2. **Shape an epic.** Click **Add work** to open an interactive `/shape` session in the browser terminal. You talk through the idea with `claude`; it writes an epic — Goal, Acceptance, and child tickets — into the repo's beads. The epic lands in **backlog**, unapproved.
3. **Review and approve.** Open the epic on the board and read its Goal, Acceptance, and tickets. When it's right, click **Approve**. This is the gate: **anton only ever executes approved epics.** Nothing runs against your code until you approve.
4. **Watch it run.** On approval the epic moves to **implementing** and anton enqueues a run per ticket. Each run gets its own git worktree, drives `claude` (base contract + your seed prompt + the ticket's agent prompt) to implement the ticket, runs your test command, commits, and opens a PR. A live terminal streams the session; the board shows progress. When every ticket is done the epic moves to **in-review** with its PR link.
5. **Let review-fix work the PR.** The **review-fix** job polls each open PR. When a reviewer requests changes or CI fails, it dispatches `claude` with the PR context (comments, failing checks) to resolve them, pushes, and re-requests review — repeating until the PR is clean. You review and merge; anton keeps the loop tidy in between.

You stay in control at two points — approving the epic and merging the PR. Everything between is autonomous.

### Project settings

Each project has its own settings (under **Settings** for that project). Nothing here is required — sensible defaults apply when a field is empty.

| Setting | What it controls |
|---------|------------------|
| **Model** | Which model the headless `claude` driver uses for runs (Opus / Sonnet / Haiku / Fable, or **Default** to use `claude`'s own configured model). |
| **Seed prompt** | Extra operator guidance layered onto the locked base contract for every run — conventions, things to avoid, where key files live. It customizes *how* epics are approached; it can't override the base contract. Empty = base + agent prompt only. |
| **Review-fix prompt** | Overrides the default review-fix reasoning prompt (`src/prompts/review-fix.md`). anton appends the concrete PR context beneath it. Empty = the shipped default. |
| **Test command** | The command anton runs in a worktree to verify a ticket before committing. |
| **Base branch** | The branch runs target and open their PRs against (defaults to the repo's detected default branch). |
| **Max concurrent runs** | How many worktrees run in parallel (1–6). |
| **Autonomous execution** | Whether approved epics run without further prompting. |

The three background jobs (**review-fix**, **nightly-stringer**, **orphan-grooming**) can each be toggled on/off per project under **Automation**.

### Default schedules

Default per-project schedules are seeded on project creation:

- **review-fix** — every 15 min (`*/15 * * * *`)
- **nightly-stringer** — daily at 03:00 (`0 3 * * *`)
- **orphan-grooming** — weekly, Mon 04:00 (`0 4 * * 1`)

Edit the cron or disable any of them in project settings.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTON_DB` | `./anton.db` | SQLite path for machine-local state |
| `ANTON_RUNNER` | on | set `off` to boot the UI without the job runner + scheduler |
| `ANTON_WORKTREES_ROOT` | sibling of the repo | where run worktrees are created |
| `ANTON_SESSIONS_ROOT` | `./.anton/sessions` | claude session logs |
| `ANTON_SCANS_ROOT` | `./.anton/scans` | stringer scan files |

## Troubleshooting

**`anton setup`/`doctor` reports a MISSING required tool.** anton can't run without `git`, `bd`, `claude`, and node ≥ 20. Install the flagged tool, make sure it's on your `PATH`, and re-run `anton doctor` until every required row shows `found`. `gh` and `stringer` are optional — without `gh` you lose PRs and review-fix; without `stringer` you lose the nightly scan.

**The live terminal / interactive `/shape` session doesn't work.** anton uses `node-pty`, whose prebuilt binaries don't always match your local node ABI. `anton setup` rebuilds it best-effort, but if the rebuild was skipped or failed, rebuild it manually:

```bash
cd node_modules/node-pty && npx node-gyp rebuild
```

Then restart the server. (A node upgrade can break the ABI again — re-run the rebuild after upgrading node.)

**The UI boots but nothing executes.** Approved epics run only when the job runner is on. If you started with `ANTON_RUNNER=off`, the UI comes up but the runner and scheduler don't — restart without that variable so runs execute and scheduled jobs fire. Conversely, set `ANTON_RUNNER=off` when you *want* the UI without any background execution (e.g. inspecting state).

**A run never opens a PR, or review-fix does nothing.** These need `gh` authenticated against the repo's remote. Check `gh auth status` and that the project's remote is reachable. review-fix also only acts once a PR exists and a reviewer has requested changes or a check has failed.

**`anton doctor` shows `anton.db not created`.** Run `anton setup` — it applies the Drizzle migrations that create/update `anton.db`. `anton.db` is disposable machine-local state; deleting it and re-running `anton setup` is a safe reset (your work lives in beads + git, not here).

## Stack

Next.js 16 (App Router, RSC) · React 19 · Tailwind 4 · shadcn/ui · Drizzle + better-sqlite3 · node-pty + @xterm/xterm · in-process durable job runner · bun (pm) / node (runtime).

## Contributing

Setup, quality gates, CI, and release process live in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
