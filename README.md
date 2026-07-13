<p align="center">
  <img src="./public/anton-avatar.svg" alt="anton" width="140" />
</p>

<h1 align="center">anton</h1>

<p align="center"><strong>Shape an idea into an epic, approve it, and let it ship itself.</strong></p>

## What is anton

anton is a local app that takes an idea — or a finding from scanning your code — and turns it into work that gets done while you watch. You describe what you want; anton **shapes** it into an epic with concrete tickets and sets it aside for your OK. Once you **approve**, it runs each ticket **autonomously**: it spins up an isolated git worktree, drives `claude` to write the code, runs your tests, and opens a **pull request**. Then it keeps working the PR for you — when a reviewer asks for changes or CI goes red, it **auto review-fixes** until the PR is clean.

The loop, in one line:

```
shape → approve → autonomous run → PR → auto review-fix
```

You stay in control at exactly two points — approving the epic and merging the PR. Everything in between runs on its own.

> **Local, not deployed.** anton runs as a Next.js server on your machine and drives your local `claude`, `git`, `gh`, `bd`, and `stringer`. It is not a hosted service — there's nothing to sign up for and nothing leaves your machine. See [`DESIGN.md`](./DESIGN.md) for the full architecture.

## Quick start

```bash
bun install                       # or: npm install
anton setup                       # check prereqs, migrate the DB, build native deps
anton start                       # build if needed, then start the server
open http://localhost:3000        # add a repo, shape an epic, approve, watch it run
```

New here? See [Install](#install) and [Run locally](#run-locally) for prerequisites and detail.

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

## Feature walkthrough

### The board

![The epics board — four stage columns derived live from beads](docs/images/board.png)

A project's home is a four-column board — **backlog → implementing → in-review → done** — with a live count on each column. Every stage is derived from beads at read time (an epic's tickets and its PR state decide where it sits), so the board is never a cache to reconcile: approve an epic in backlog and it moves right on its own as its runs land. In-review cards carry their PR number, and backlog cards expose the **Approve** gate directly.

### Epic detail

![An epic's contract and its live dependency graph](docs/images/epic.png)

Opening an epic shows its full contract — Goal, Acceptance, and child tickets with size labels — beside a live **dependency graph** of the ticket DAG (`blocks` / `part of` edges, laid out left→right). This is the review-and-approve gate from step 3 of the loop: you read exactly what anton will build before anything runs, then **Run epic** launches it (or **Open worktree** to inspect the isolated checkout).

### Tickets

![The filterable tickets list across all epics](docs/images/tickets.png)

The tickets view is the flat, cross-epic index — every epic and ticket in the project with its id, parent epic, agent, risk, and size, filterable by any of those plus title, status, and type. It's the granular counterpart to the board: where the board tracks epics through stages, this is where you scan, filter, and drill into individual work items.

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

## Install

The quickest path is the **one-line installer**. It downloads a small (~15 MB) prebuilt, per-platform bundle — the built app plus its native modules — and drops the `anton` launcher on your `PATH`. No toolchain, no build step:

```bash
curl -fsSL https://raw.githubusercontent.com/henriblancke/anton/main/scripts/install.sh | bash
```

Then:

```bash
anton setup      # prereqs, create the local DB, install skills & agents
anton start      # start the server in the background → http://localhost:3000
```

anton **isn't a single compiled binary** — it's a Next.js server with native addons (`node-pty`, `better-sqlite3`), so a release can't fold into one universal executable. Instead each release ships a **prebuilt bundle per platform** (macOS arm64/x64, Linux x64); the installer fetches the one matching your machine, installs it under `~/.local/share/anton`, and keeps your data in `~/.local/state/anton` (so it survives updates). Manage it with `anton stop` / `status` / `update` / `uninstall` — see [Run locally](#run-locally).

### From source (contributors)

Working on anton itself? Clone and run from the checkout instead of the installer:

```bash
git clone https://github.com/henriblancke/anton && cd anton
bun install
bun link          # symlinks `anton` into ~/.bun/bin so it resolves from anywhere (npm: `npm link`)
anton setup && anton dev
```

`bun install` alone does **not** put `anton` on your `PATH` — a package manager only links a package's `bin` when it's installed as a dependency or globally, never for the repo's own root. `bun link` fixes that and keeps `anton` pointed at your working tree (edits are picked up on the next run; undo with `bun unlink`). Or skip linking and run the launcher directly: `node bin/anton.mjs <command>`. A source checkout has no `RELEASE_VERSION` marker, so `anton start` runs in the **foreground** (the daemon/`stop`/`update` commands are for installed bundles).

> **npm (once publishing is enabled).** A global `npm i -g anton` will also work as a source-style install (builds locally on your machine); anton isn't published yet, so use the installer or a clone for now.

## Run locally

```bash
anton setup      # check prerequisites, run DB migrations, rebuild node-pty
anton start      # build if needed, then start the server on http://localhost:3000
```

The server listens on **port 3000** by default. Run it elsewhere with `--port` (alias `-p`) or the `PORT` env var — an explicit flag wins:

```bash
anton start --port 4000       # or: anton start -p 4000  /  PORT=4000 anton start
anton dev --port 4000         # same override for the dev server
```

The **job runner and cron scheduler start automatically** with the server (via `src/instrumentation.ts`), so approved epics execute and scheduled jobs fire without any extra process. Set `ANTON_RUNNER=off` to boot the UI without them.

**Installed bundle vs. source checkout.** From an installed bundle, `anton start` runs the server as a **background daemon** (logs under `~/.local/state/anton/logs`) and returns once it's up; use `anton stop` / `anton status` to manage it, `anton update` to pull the latest release, and `anton uninstall` to remove it (your data in `~/.local/state/anton` is kept unless you pass `--purge`). From a source checkout there's no bundle to daemonize, so `anton start` runs in the **foreground** (add `--foreground` to force that in a bundle too).

### CLI

```
anton setup     check prereqs, migrate DB, install agents & skills   [--agents <a,b,c>|all]
anton doctor    check prereqs + anton.db (non-destructive)
anton dev       run the dev server (next dev)                         [--port <n>]
anton start     run the server — bundle: background, source: foreground  [--port <n>] [--foreground]
anton stop      stop the background server                            (installed bundle)
anton status    show version, install/state paths, and running state
anton update    download & install the latest release                (installed bundle)
anton uninstall remove the installed runtime + launcher               [--purge]
anton --help    show help
```

### Agents & skills

Run in a real terminal, `anton setup` is **interactive**: after the prereq, migration, and native-build steps it provisions the agents and skills that `claude` uses, installing them into your **global `~/.claude/`** so they're discoverable from every repo `claude` runs in.

- **Bundled agents — you choose.** anton ships specialist agent prompts (`alembic`, `docker`, `fastapi`, `kubernetes`, `nextjs`, `pydantic`, `supabase`, `terraform`). Setup lists them with a one-line description each and prompts for the ones that match your stack (enter numbers, `a` for all, or Enter for none). They land in `~/.claude/agents/<tag>.md`.
- **Required skills — always installed.** The machinery anton itself needs — the `shape`, `bd`, `scan-triage`, and `review-fix` skills — is installed automatically into `~/.claude/skills/<name>/SKILL.md` and can't be deselected.
- **Your own files are respected.** Any agent or skill already present at the destination — a prior anton install *or* your own file — is left **byte-for-byte untouched** and reported as *already present*. Re-running `anton setup` is idempotent: no duplicate installs, no clobbering.
- **Non-interactive / CI.** When stdin isn't a TTY, setup skips the picker and installs just the required skills. Select agents non-interactively with `anton setup --agents nextjs,fastapi` (or `--agents all`); `--no-agents` installs skills only.

**How an agent tag resolves at run time.** When a ticket carries an `agent:<tag>` label, anton loads the prompt for `<tag>` and appends it to the run's system prompt, resolving in order: the target project's `.claude/agents/<tag>.md`, then your global `~/.claude/agents/<tag>.md`, then anton's bundled prompt. The first match wins — your customization takes precedence, and anton's bundled copy is always the fallback, so a run works even before setup installs anything.

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
| **Review-fix prompt** | Overrides the default review-fix reasoning prompt (`skills/review-fix/SKILL.md`). anton appends the concrete PR context beneath it. Empty = the shipped default. |
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
| `ANTON_CLAUDE_BIN` | `claude` (on `PATH`) | override the `claude` executable anton drives |
| `ANTON_GH_BIN` | `gh` (on `PATH`) | override the GitHub CLI executable |
| `ANTON_STRINGER_BIN` | `stringer` (on `PATH`) | override the `stringer` executable |

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
