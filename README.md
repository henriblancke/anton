<p align="center">
  <img src="./public/anton-avatar.svg" alt="anton" width="140" />
</p>

<h1 align="center">anton</h1>

<p align="center"><strong>Shape an idea into an epic, approve it, and let it ship itself.</strong></p>

## Get started

Install with the **one-line installer**. It fetches a small (~15 MB) prebuilt bundle for your platform and drops the `anton` launcher on your `PATH` — no toolchain, no build step:

```bash
curl -fsSL https://raw.githubusercontent.com/henriblancke/anton/main/scripts/install.sh | bash
```

Then set it up and start the server:

```bash
anton setup                    # check prereqs, migrate the DB, install skills & agents
anton start                    # start the server → http://localhost:3000
open http://localhost:3000     # add a repo, shape an epic, approve, watch it run
```

anton drives your local `claude`, `git`, `gh`, and `bd` — install those first ([Prerequisites](#prerequisites)). For how the bundle works and how to manage it see [Install](#install); to hack on anton itself, run it [from source](#from-source-contributors).

## What is anton

anton is a local app that takes an idea — or a finding from scanning your code — and turns it into work that gets done while you watch. You describe what you want; anton **shapes** it into an epic with concrete tickets and sets it aside for your OK. Once you **approve**, it runs each ticket **autonomously**: it spins up an isolated git worktree, drives `claude` to write the code, runs your tests, and opens a **pull request**. Then it keeps working the PR for you — when a reviewer asks for changes or CI goes red, it **auto review-fixes** until the PR is clean.

The loop, in one line:

```
shape → approve → autonomous run → PR → auto review-fix
```

You stay in control at exactly two points — approving the epic and merging the PR. Everything in between runs on its own.

> **Local, not deployed.** anton runs as a Next.js server on your machine and drives your local `claude`, `git`, `gh`, `bd`, and `stringer`. It is not a hosted service — there's nothing to sign up for and nothing leaves your machine. See [`DESIGN.md`](./DESIGN.md) for the full architecture.

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

**beads is the source of truth for work.** Epics, tickets, approval, stage, and the PR link all live in each repo's `.beads/` (queried via `bd`). Beads state syncs between machines via Dolt — `refs/dolt/data` on the git remote, configured by `anton setup` — so a fresh clone hydrates its board with `bd dolt pull`, not from files in the clone. The `.beads/*.jsonl` files are passive local exports for viewers: git-ignored, regenerated, and never the source of truth. anton's own SQLite (`anton.db`) holds only machine-local execution state: projects, runs, jobs, schedules, and sessions — it's disposable and git-ignored.

## Feature walkthrough

### The board

![The epics board — four stage columns derived live from beads](docs/images/board.png)

A project's home is a four-column board — **backlog → implementing → in-review → done** — with a live count on each column and a **live-synced** pill that shows the board is following beads in real time. Every stage is derived from beads at read time (an epic's tickets and its PR state decide where it sits), so the board is never a cache to reconcile: approve an epic in backlog and it moves right on its own as its runs land. In-review cards carry their PR number, and backlog cards expose the controls directly — **Approve** to start automation, or **Claim** to reserve an epic for yourself without approving it yet (**Release** to drop the claim). Loose bugs and tasks with no parent epic surface in their own **Standalone** lane so they're just as approvable as epics.

### Epic detail

![An epic's contract and its live dependency graph](docs/images/epic.png)

Opening an epic shows its full contract — Goal, Acceptance, and child tickets with size labels — beside a live **dependency graph** of the ticket DAG (`blocks` / `part of` edges, laid out left→right). This is the review-and-approve gate from step 3 of the loop: you read exactly what anton will build before anything runs, then **Run epic** launches it (or **Open worktree** to inspect the isolated checkout).

### Tickets

![The filterable tickets list across all epics](docs/images/tickets.png)

The tickets view is the flat, cross-epic index — every epic and ticket in the project with its id, parent epic, agent, risk, and size, filterable by any of those plus title, status, and type. It's the granular counterpart to the board: where the board tracks epics through stages, this is where you scan, filter, and drill into individual work items.

### More views

Three more views round out a project, in the left nav:

- **Dependencies** — the project-wide dependency graph across every epic and ticket, so you can see the whole DAG at once rather than one epic at a time.
- **Runs** — every run anton has executed, each with its epic · ticket · agent, status (done / failed), and duration. Runs are the per-ticket unit of work: a worktree, a `claude` session, tests, a commit.
- **Jobs** — the background job queue behind those runs — `execute-epic`, `review-fix`, and the scheduled jobs — showing what's running, queued, done, or parked, with attempts and timing. A stuck job can be **force-killed** here.

A global **usage pill** in the sidebar tracks your live Claude session and weekly limits at a glance (toggle with `ANTON_USAGE_PILL`).

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

### Installing them

- **node ≥ 20** — via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`), [fnm](https://github.com/Schniz/fnm) (`fnm install 22`), Homebrew (`brew install node`), or [nodejs.org](https://nodejs.org). The prebuilt bundle self-heals its native modules for your Node version during `anton setup`, so any current major works.
- **git** — `xcode-select --install` (macOS) · `brew install git` · `apt install git` / `dnf install git` (Linux).
- **bd** (beads) — the work source of truth:
  ```bash
  curl -sSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash
  ```
  Then run `bd init` inside each repo you point anton at.
- **claude** (Claude Code) — `npm install -g @anthropic-ai/claude-code`, or the native installer at [claude.com/claude-code](https://claude.com/claude-code). Run `claude` once to sign in.
- **gh** (GitHub CLI, optional) — `brew install gh` (macOS), or see [cli.github.com](https://cli.github.com) (Linux); then `gh auth login`. Without it you lose PRs + review-fix.
- **stringer** (optional) — a git-archaeology tool that mines repos for beads issues, installed via [Homebrew](https://brew.sh):
  ```bash
  brew install davetashner/tap/stringer
  ```
  Without it you lose the nightly scan → beads job. Source: [github.com/davetashner/stringer](https://github.com/davetashner/stringer).

Run `anton doctor` at any time to check what's present.

## Install

[Get started](#get-started) above shows the **one-line installer** — the quickest path. Here's what it actually does. It downloads a small (~15 MB) prebuilt, per-platform bundle — the built app plus its native modules — and drops the `anton` launcher on your `PATH`. No toolchain, no build step:

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
anton setup     check prereqs, migrate DB, install/refresh agents & skills  [--agents <a,b,c>|all] [--force-skills]
anton init      configure beads in a target repo + register it       [path] [--prefix <p>] [--force-skills]
anton doctor    check prereqs + anton.db + stale skills (non-destructive)
anton board-check  report beads that break epic → feature → ticket   [path...] (default: cwd)
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
- **Required skills — always installed.** The machinery anton itself needs — the `shape`, `bd`, `scan-triage`, `review`, and `review-fix` skills, plus the founder-run `setup` scaffolder — is installed automatically into `~/.claude/skills/<name>/SKILL.md` and can't be deselected.
- **Your own work is respected.** Agent prompts and any skill copy carrying local edits are left **byte-for-byte untouched** — always, and so are files you add to a skill directory. Re-running `anton setup` is idempotent: no duplicate installs, and the only thing it ever rewrites is a skill copy from an older release with nothing of yours in it (next three bullets).
- **Every shipped skill carries a version stamp.** Each `SKILL.md` declares `version: <digest>` — the content hash of its whole skill directory, recomputed by a test on every change, so it can never describe a body it no longer has. That one line is what makes an installed copy self-describing: if its stamp still matches its own content it is **untouched** (whatever release wrote it), and if it doesn't, someone **edited** it.
- **An untouched copy of an older release is refreshed for you.** Agents are yours to tune, so an edited one is simply *already present* and never nagged about. Skills are different: anton's own jobs load them as a runtime contract, so a copy left behind by an older release keeps shaping work against rules the current one has replaced. `anton setup` (global) and `anton init` (that repo) re-sync any drifted-but-untouched skill from the bundle and report it — *refreshed — was another release's copy* — because there are no edits in it to lose.
- **A copy you edited is never touched.** A skill whose stamp doesn't match its content (or that predates stamps entirely) is reported as *differs from bundle — left as-is* and left exactly where it is. `anton setup --force-skills` (global) or `anton init --force-skills` (that repo) adopts this release's version anyway; **local edits to those files are lost**, which is why it's opt-in. Files you added to a skill directory that anton doesn't ship are left alone either way.
- **`anton doctor` only reports.** It lists every drifted skill at both scopes — global `~/.claude/` and the current repo's `.claude/` — says which kind of drift each one is, and never writes a file. The global scope matters most: a plain `claude` session in any repo resolves `~/.claude/skills/` even where anton has installed nothing.
- **Non-interactive / CI.** When stdin isn't a TTY, setup skips the picker and installs just the required skills. Select agents non-interactively with `anton setup --agents nextjs,fastapi` (or `--agents all`); `--no-agents` installs skills only.

**How an agent tag resolves at run time.** When a ticket carries an `agent:<tag>` label, anton loads the prompt for `<tag>` and appends it to the run's system prompt, resolving in order: the target project's `.claude/agents/<tag>.md`, then your global `~/.claude/agents/<tag>.md`, then anton's bundled prompt. The first match wins — your customization takes precedence, and anton's bundled copy is always the fallback, so a run works even before setup installs anything.

### `anton setup` vs `anton init`

Two different scopes — run each at its own layer:

- **`anton setup` configures the anton runtime itself** — once per machine. It checks prereqs, migrates `anton.db`, heals native modules, and installs anton's skills & agents into your global `~/.claude/`. It doesn't touch any of your repos.
- **`anton init [path]` configures one target repo for anton to drive** — run it per project. It enforces anton's committed **beads** team-config (`bd init` when `.beads/` is absent → `config.yaml` keys → `.beads/.gitignore` → Dolt remote wiring over `origin`) and registers the repo with anton so it appears on the projects board. It's the terminal equivalent of adding a project from the UI — both converge to the same end state — and every step is idempotent, so a re-run (or a run on an already-configured repo) is a no-op. It needs `bd`, a git repo, and an `origin` remote; a missing one fails loud with the fix.

**Git hooks are optional for anton-driven repos.** beads normally installs `post-merge`/`post-checkout` hooks to hydrate Dolt on pull/checkout, but anton's runner pushes Dolt explicitly on every write, so hydration hooks are redundant for a repo anton drives. If a hooks manager (husky/lefthook) or a custom `core.hooksPath` already owns the repo's hooks, `anton init` **warns and prints the manual chaining steps rather than rewriting your hooks** — you can safely ignore it for anton-driven repos, or chain `bd hooks run` in yourself if you also work the repo by hand.

## Using anton

Once the server is up at `http://localhost:3000`, a full turn of work looks like this:

1. **Add a project.** From the projects screen, add a local repo that has a `.beads/` directory — or run **`anton init <path>`** in a terminal, which configures beads there and registers the repo in one step (see [`anton setup` vs `anton init`](#anton-setup-vs-anton-init)). Adding a repo from the UI records its path and detects its default branch; it self-heals the beads team-config but never rewrites your git history.
2. **Shape a feature.** Click **Add work** to open an interactive `/shape` session in the browser terminal. You talk through the idea with `claude`; together you land a **feature** — one PR's worth of work, with Goal, Acceptance criteria, Context, Out of scope and Verify — under the **epic** (the product outcome) it advances, which you pick from the board or shape on the spot. The feature lands in **backlog**, unapproved.
3. **Review and approve the feature.** Open the **feature** on the board and read its Goal, Acceptance criteria, and tickets. When it's right, click **Approve**. This is the gate: **anton only ever executes approved work.** Approval is per feature — the epic above it groups features and is never approved or run itself, so each PR gets its own decision. Nothing runs against your code until you approve.
4. **Watch it run.** On approval the feature moves to **implementing** and anton enqueues its run — one worktree, one PR. The run works through the tickets shaped under the feature (a feature with none is itself the single ticket), driving `claude` (base contract + your seed prompt + the ticket's agent prompt) to implement each one, running your test command, and committing. A live terminal streams the session; the board shows progress. When the work is done the feature moves to **in-review** with its PR link.
5. **Let review-fix work the PR.** The **review-fix** job polls each open PR. When a reviewer requests changes or CI fails, it dispatches `claude` with the PR context (comments, failing checks) to resolve them, pushes, and re-requests review — repeating until the PR is clean. You review and merge; anton keeps the loop tidy in between.

You stay in control at two points — approving the feature and merging the PR. Everything between is autonomous.

### Project settings

Each project has its own settings (under **Settings** for that project). Nothing here is required — sensible defaults apply when a field is empty.

| Setting | What it controls |
|---------|------------------|
| **Model** | Which model the headless `claude` driver uses for runs (Opus / Sonnet / Haiku / Fable, or **Default** to use `claude`'s own configured model). |
| **Seed prompt** | Extra operator guidance layered onto the locked base contract for every run — conventions, things to avoid, where key files live. It customizes *how* epics are approached; it can't override the base contract. Empty = base + agent prompt only. |
| **Review-fix prompt** | Overrides the default review-fix reasoning prompt (`skills/review-fix/SKILL.md`). anton appends the concrete PR context beneath it. Empty = the shipped default. |
| **Verify gates** | The commands anton runs in a worktree to verify a ticket before committing — **test**, plus optional **lint**, **typecheck**, and **build**. Each is a shell command; a non-zero exit fails the ticket. Unset gates are skipped. |
| **Active agents** | Which specialist agent prompts dispatch may assign. A run whose ticket needs a disabled agent is **parked** rather than silently run with the default. Empty (never set) = all discovered agents active. |
| **Base branch** | The branch runs target and open their PRs against (defaults to the repo's detected default branch). |
| **Conventional-commit PR titles** | When on, prefixes the epic PR title with a derived `<type>(<scope>): ` (bug→`fix`, epic/task→`feat`; scope = the `agent:` label). Off by default — the title stays `<title> (<id>)`. |
| **Max concurrent runs** | How many worktrees run in parallel (1–6). |
| **Job timeout / max retries** | Wall-clock limit for a single job attempt, and how many attempts before a job is parked for a human. |
| **Autonomous execution** | Whether approved epics run without further prompting. When off, approval still enqueues the run but it waits until you turn autonomy back on. |

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
| `ANTON_USAGE_PILL` | on | live Claude usage pill (`GET /api/usage`); set falsy (`0`/`false`/`off`) to disable |

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

**`anton doctor` flags a drifted skill.** The copy in `~/.claude/skills/` (or the repo's `.claude/skills/`) isn't the one this release ships, so `/shape` will keep shaping work against rules the current release has replaced. What to do depends on which drift doctor names:

- *is another release's copy* — untouched, so just re-run `anton setup` (global) or `anton init` (that repo); it refreshes automatically, no flag.
- *carries local edits* / *predates version stamps* — anton won't overwrite it. Adopt this release's version with `anton setup --force-skills` / `anton init --force-skills` (**your edits are discarded**), or ignore the warning if the difference is deliberate.

Either way, restart any running `claude` session afterwards: skills are read at session start, so an updated file doesn't reach a session already open.

**`/shape` produced a board that doesn't match `epic → feature → ticket`.** Run `anton board-check` in that repo (or pass one or more repo paths) for every violation on the board and the `bd` command that fixes each one. It exits non-zero only on a *dead* bead — one no run will ever reach, such as a ticket left under an epic that has features under it. Features outside the 2–6 ticket budget, features with no epic, and beads whose parent isn't on the board print as advisories: they run, they just cost you later. The same judgement gates approval for the target being approved, so a dead bead can't reach a run. It needs `bd` on PATH and nothing else — no anton checkout, no build.

## Stack

Next.js 16 (App Router, RSC) · React 19 · Tailwind 4 · shadcn/ui · Drizzle + better-sqlite3 · node-pty + @xterm/xterm · in-process durable job runner · bun (pm) / node (runtime).

## Contributing

Setup, quality gates, CI, and release process live in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
