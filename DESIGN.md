# anton — design

A local, single-user app that turns ideas and code-scan findings into **approved epics** and
executes them **autonomously** in git worktrees, opening a PR per unit of work. Epic-first,
approval-gated, agent-driven. You run it on your machine; it drives `claude`, `git`, `gh`, and
`bd` (beads) locally.

anton is the successor to the `loom` Claude Code plugin: it keeps loom's shaping and agents
(now `src/prompts/`) and its execution/durability model, and wraps them in a Next.js/shadcn UI
with multi-project support, an xterm, and durable background jobs.

## 1. What it is / isn't

- **Local, not deployed.** Runs as a local Next.js server (like foolery/scotty). No Vercel
  Workflow, no Cache Components — those solve serverless problems anton doesn't have.
- **beads is the work source of truth.** Epics/tickets live in each project's `.beads/`
  (queried live via `bd --json`). anton's own SQLite (`anton.db`) holds app state: projects,
  runs, jobs, schedules, sessions, PR/worktree links.
- **Claude Code is the executor.** anton spawns `claude` (headless for autonomous work, pty for
  interactive shaping), injecting a ticket's agent-tag prompt via `--append-system-prompt`.

## 2. Stages (simple, by design)

```
backlog        open bead, not yet approved          (shaped, awaiting your OK)
implementing   approved + a run is executing it      (worktree, claude working)
in-review      PR open; review-fix job watching it   (comments + CI auto-resolved)
done           PR merged / bead closed
```

Mapping to beads: `backlog` = open, no `approved` label · `implementing` = `in_progress` +
active run · `in-review` = open PR linked in `runs` · `done` = closed. **Approval is a label on
the epic**, set by you in the UI. The execute job only ever touches approved epics.

## 3. Data model — two tiers by shareability

Persistence splits by whether state is **shareable/durable** (belongs in git, follows the repo)
or **ephemeral/machine-local** (execution plumbing, meaningless off this machine). This mirrors
how foolery works: it keeps no work DB — beads is the source of truth, git-shareable via
`.beads/*.jsonl` (Dolt-backed export); only machine-local config lives outside git.

**Shareable/durable → beads (`.beads/*.jsonl`, git-versioned):**
- epics/tickets and their Goal/Acceptance/Context/labels/deps
- **approval** — a label on the epic (`approved`)
- **stage** — labels (`stage:implementing` / `in-review`) as needed
- **PR link** — the bead's native `--external-ref` (`gh-123`)
- meaningful outcomes — bead comments/events

So "where is this epic, is it approved, what PR shipped it" travels with the repo and is
visible to any machine, scotty, or foolery. anton reads/writes it via `bd` (never duplicates it).

**Ephemeral/machine-local → `anton.db` (SQLite/Drizzle, git-ignored):**
- **projects** — `id, slug, name, repoPath, defaultBranch, settingsJson, createdAt`
- **runs** — the execution handle: `id, projectId, epicBeadId, ticketBeadId?, worktreePath,
  branch, model, agentTag, attempts, leaseExpiresAt, error, startedAt, endedAt` (stage + PR live
  in beads; this is just the local plumbing)
- **jobs** — the durable queue: `id, type, projectId, payloadJson, status, runAt,
  leaseExpiresAt, attempts, lastError`
- **schedules** — crons: `id, projectId, type, cron, enabled, lastRunAt, nextRunAt`
- **sessions** — claude sessions for history/diagnostics/xterm: `id, projectId, runId?, kind,
  beadId?, status, logPath, startedAt, endedAt`

These are inherently local (a worktree path or live lease is meaningless elsewhere), so they are
never committed. `anton.db` is disposable — it can be rebuilt; the truth is in beads + git.

## 4. Background jobs + durability (the hard part)

An in-process **job runner** in the Next server: a loop that leases queued/due jobs, runs them,
and reschedules. Durability = **resumability, not retry-in-place**:

- **Idempotent jobs** — safe to re-run.
- **Leases** — a running job/run holds a lease; a crashed one is reclaimed when the lease
  expires (stale recovery).
- **API-limit backoff** — a run that hits a usage limit **parks** and the job is rescheduled
  past the reset window. You cannot retry an exhausted quota.
- **Poison-pill** — a job that fails `maxAttempts` times parks for a human (visible in the UI).

Job types:
1. **execute-epic** — approved epic → warm worktree → per ticket: `claude` (agent prompt) →
   tests → commit → when the epic's tickets are done, open one PR → `in-review`.
2. **review-fix** — for `in-review` runs: poll the PR (via `gh`) for review comments + CI
   status; when actionable, dispatch `claude` in the worktree to resolve, push, re-request.
3. **nightly-stringer** — `stringer scan --delta` → `/scan-triage` prompt → beads (per project,
   on cron).
4. **orphan-grooming** — tickets with no epic → bucket into an epic, or fix in a single PR.

## 5. Claude driver

- **Headless** (`claude -p`) for autonomous jobs, `--permission-mode` for autonomy,
  `--append-system-prompt "<agent prompt>"` from the ticket's `agent:` tag, `--model` from
  settings, `cwd` = the worktree. Output streamed to `sessions` log + the UI (SSE); parsed for
  usage-limit signals → backoff.
- **Interactive** (node-pty) for `/shape` and any "take over" — a real terminal streamed to the
  browser xterm. Shaping is a conversation, so it runs interactively.

anton is standalone — it ships its own required skills and needs no external plugin. The
`shape` / `bd` / `scan-triage` / `review-fix` skills live as self-contained assets in `skills/`
(each a `SKILL.md`; `REQUIRED_SKILLS` in `src/lib/claude/prompt.ts` is the canonical list). The
setup wizard (anton-3n5) always installs this set into a target project's `.claude/skills/`.
Agent-tag specialist prompts and the locked base contract live in `src/prompts/` (`agents/*.md`,
`system-base.md`); `ETHOS.md` / `BEADS.md` are anton's operating-context source, and the
conventions they hold travel embedded in the `bd` and `shape` skills.

## 6. UI (Next.js 16 App Router + shadcn)

- **Projects** — add/list repos (each with a `.beads/`); per-project settings (stack, active
  agents, concurrency, crons).
- **Epics board** (per project, the primary surface) — four columns (backlog/implementing/in-
  review/done); an epic card shows Goal + Acceptance + its tickets; **Approve** on the epic.
- **Run / xterm** — live terminal for the active session; runs list + history + diagnostics.
- **Add work** — opens an interactive `/shape` session in the xterm; result lands in backlog.

## 7. The vertical slice (Phase 1 — build this first)

Add a project → `/shape` an epic (xterm) → it appears in `backlog` → **Approve** → the
`execute-epic` job runs it in a worktree (claude + agent prompt → tests → PR) → it moves to
`in-review` with a live xterm + PR link. That is the core loop end to end.

**Phase 2:** review-fix job · nightly stringer + scan-triage · orphan grooming.
**Phase 3:** diagnostics/history polish · concurrency + cron settings UI · multi-project scale.

## 8. Stack

Next.js 16 (App Router, RSC) · React 19 · Tailwind 4 · shadcn/ui · Drizzle + better-sqlite3 ·
node-pty + @xterm/xterm · bun (pm) / node (runtime). External CLIs: `bd`, `git`, `gh`,
`stringer`, `claude`.

> Setup note: `node-pty` ships prebuilts that don't match node 22 — after `bun install`, run
> `cd node_modules/node-pty && npx node-gyp rebuild`. (A postinstall will automate this.)
