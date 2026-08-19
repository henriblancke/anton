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
  Workflow, no Cache Components — those solve serverless problems anton doesn't have. The one
  outbound exception is opt-in and self-hosted: a project may point its board at a shared Dolt
  server you run ([§3a](#3a-board-modes--embedded-vs-shared-server)). anton itself still runs here.
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

### Claim vs approve — reserving is not approving

**Claim** and **approve** are separate actions on a run target (an epic or a parentless
task/bug), and only approve starts automation:

- **Human claim** (`POST/DELETE …/claim`) — reserve a target for a person *without* approving it
  for automation. It only sets/clears the bead's **assignee** (`beads.assign`/`unassign`); the
  bead stays `open` and in **backlog**, and no run is ever enqueued. Use it to call dibs while you
  finish shaping, or to hand a target to a teammate, before anyone hits Approve.
- **Soft-lock** — a claim is advisory, not a hard lock. Approving a target claimed by someone else
  is refused (`409`); only the claimer approves it. Taking it over is an **explicit override** —
  pass `{ steal: true }` — so approval can never silently run a teammate's reservation. Releasing
  or re-claiming someone else's claim is gated the same way. Approve also **auto-claims**: an
  unclaimed target (or one being stolen) is assigned to the approver *before* enqueuing, closing
  the gap where a teammate could claim between approve and the run.

Neither of these is the **runtime execution-claim**. That is the *runner's* `bd` claim: when
execute-epic actually starts a run it flips the bead to **`in_progress`** (the `implementing`
stage above) to mark it as executing. The human claim is a `backlog` reservation on `open`;
the execution-claim is the runner announcing work is underway. Don't conflate the two — a claimed
epic is still just reserved until you approve it.

The execution-claim **cascades to the target's open children**. `bd ready --unassigned` filters on
each *task's* assignee, so a claim that stopped at the feature would leave every child of a running
feature claimable by any other worker on the board — a second anton instance, or a plain `bd` client
that has never heard of a run lease. So the runner `bd assign`s each open child to the same actor
(a reservation: status untouched), and hands them back when the attempt stops — parked, abandoned,
or backed off after losing the lease race. It gives back only what it took: a child a *person* had
already reserved is left alone and reported in the run log, and a takeover that lands mid-run keeps
its new owner. The one attempt that keeps its reservations is a **usage-limit park** — that run
isn't dead, it's waiting out a quota window and resumes on this machine.

## 3. Data model — two tiers by shareability

Persistence splits by whether state is **shareable/durable** (belongs in git, follows the repo)
or **ephemeral/machine-local** (execution plumbing, meaningless off this machine). This mirrors
how foolery works: it keeps no work DB — beads is the source of truth, shared via Dolt sync
(`refs/dolt/data` on the git remote; the `.beads/*.jsonl` files are passive, git-ignored
local exports); only machine-local config lives outside git.

**Shareable/durable → beads (Dolt DB, synced via `refs/dolt/data` — or, opt-in, held on one shared
`dolt sql-server`; see [§3a](#3a-board-modes--embedded-vs-shared-server)):**
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

### 3a. Board modes — embedded vs shared server

The beads Dolt database runs one of two ways. **Embedded is the default and needs no
configuration**; server mode is opt-in per project via `.beads/metadata.json`.

| | **Embedded** (default) | **Server** |
|---|---|---|
| Who it's for | one machine, or teammates who tolerate push/pull lag | a small team wanting one real-time board |
| Where the DB lives | `.beads/embeddeddolt/<db>/` on each machine | one `dolt sql-server`, shared |
| How machines agree | `bd dolt pull/push` over `refs/dolt/data` on the git remote | they all write the same database |
| Offline | works | needs the server reachable |
| Sync status badge | `synced` / `not-wired` / `failing` | `shared-server` |
| Claim safety | advisory | advisory — **unchanged** |

Mode is read from `.beads/metadata.json` (`dolt_mode`) — parsed in `src/lib/beads/config.mjs`
(`readDoltMetadata`, the one reader, so the CLI and the server cannot disagree) and served to the
app through `src/lib/beads/board-mode.ts`, which adds the typed accessor and a per-process cache.
Anything unreadable, absent, or unrecognised resolves to **embedded** — the safe direction, since
embedded merely syncs when it need not, whereas a wrong "server" verdict would silently disable a
solo board's only propagation path.

**Three behaviours branch on it:**

1. **Sync is skipped entirely in server mode** (`runDoltSync`, `nudgeSync`). There is nothing to
   reconcile when every writer shares one database — and the attempt does not merely waste work, it
   fails: `bd dolt pull/push` executes *on the server*, and the `dolt-sql-server` image ships no ssh
   client and no keys, so a `git+ssh://` remote is unreachable from there by construction. Claim
   verification also skips its settle window, because a claim is visible to every other machine the
   moment it commits.

2. **A bd spawn's environment is scoped to the project it runs against** (`src/lib/beads/bd-env.ts`,
   anton-ffmw.1). Env is bd's highest-priority config source, so anton's own connection settings —
   inherited from whatever directory anton was launched in — would override the *target* project's
   `metadata.json` and point it at the wrong database. Two rules:
   - **Identity and routing are stripped** — every var that names *which* database to open, server
     or embedded (`PROJECT_SCOPED_BD_ENV` is the list), leaving the target's own per-directory
     `metadata.json` to decide.
   - **The password is narrowed to the target's database user**: `BEADS_DOLT_PASSWORD_<USER>` wins
     over the ambient `BEADS_DOLT_PASSWORD`, which is what makes per-project accounts work at all.
   An explicit `env` override at the call site beats both. `BEADS_DOLT_SERVER_TLS` is transport, not
   identity, and is left inherited.

3. **Setup enforces the profile the mode calls for** (`configureBeadsForRepo`, anton-4gd2). Embedded
   gets the Dolt-first sync knobs it always had — `export.auto`/`export.git-add` false,
   `dolt.auto-commit` on, `dolt.auto-push` false — plus the refs/dolt/data remote wiring and, on a
   fresh clone, `bd bootstrap`. Server mode gets the CONNECTION instead: none of the refs/dolt/data
   knobs are imposed (`dolt.auto-commit` survives — a write still becomes a Dolt commit, which is the
   team's history), no remote is wired, and no clone is bootstrapped, since a shared-server board
   keeps no local database to hydrate.

**Configuring server mode.** Put connection details in `.beads/metadata.json` — never in the
environment, for the reason above. The **mode** lives there and nowhere else: `bd config set
dolt.mode` reports success but writes a nested block into a file of flat dotted keys, from bd's
lowest-priority source, and has no effect. Add `dolt_mode` by hand:

```json
{
  "dolt_mode": "server",
  "dolt_server_host": "dolt.example.dev",
  "dolt_server_port": 3306,
  "dolt_server_user": "beads",
  "dolt_database": "anton"
}
```

The **connection** is mirrored into `.beads/config.yaml` as a team-wide default — `dolt.host`,
`dolt.port`, `dolt.user`, `dolt.database`, written by `bd dolt set <key> <value> --update-config`,
which anton's team-config enforcement applies for you (`src/lib/beads/config.mjs`, anton-4gd2).
metadata.json stays the truth anton reads; the mirror is what lets a clone that did not inherit one
still find the server. It is enforcement, so a required field absent from metadata.json is reported
as an error rather than defaulted.

Credentials come from the environment, never from `metadata.json` — it is committed. Give each
project's database user its own variable, `BEADS_DOLT_PASSWORD_<USER>` (uppercased, non-alphanumeric
folded to `_`): the user above wants `BEADS_DOLT_PASSWORD_BEADS`. A bare `BEADS_DOLT_PASSWORD` is
still honoured as the fallback for every project, which is the one-shared-account setup; per-user
variables are what let that account be retired. Add `BEADS_DOLT_SERVER_TLS=true` when the server sets
`require_secure_transport`. `dolt_server_port` must stay in `metadata.json` despite bd's deprecation
warning — without it bd dials port 0 against a remote host.

On the first pass for a server-mode project anton runs `bd dolt test` once and, if the server is
unreachable, records a failure naming the configured host/port and the ways out, rather than the
raw `unreachable at 127.0.0.1:0 … dolt is not installed` that the underlying tools produce.

**Connectivity — what each mode does when things break.** The trade is *offline tolerance* against
*propagation delay*, and each mode fails in the shape you'd expect from where its data lives:

- **Embedded** keeps a full copy per machine, so nothing about a red network stops you working: the
  board reads and writes locally, and only *propagation* stalls. Committed-but-unpushed work is
  counted rather than lost — the pill shows `failing · N unpushed`, and the heartbeat's backstop
  pass keeps retrying the push until it lands. The cost is lag in the other direction: a teammate's
  bead is invisible here until a `bd dolt pull` brings it over.
- **Server** has no local copy, so reachability is not optional — every `bd` call needs the server,
  and while it is down the board is down. That is the honest trade for zero propagation delay, and
  it is why the failure is made loud: the preflight above names the configured host/port/database
  and the fix, and the pill goes `failing` carrying that message. Writes error outright; reads keep
  serving anton's retained in-memory board (a snapshot is marked stale, never blanked), so the pill
  — not the board — is what tells you the data has stopped moving. A machine that still has its old
  `.beads/embeddeddolt` directory can set `dolt_mode` back to `embedded` and keep working from it —
  the escape hatch the preflight message points at — at the cost of rejoining the push/pull world
  until the server is back.

Recovery needs no restart in either mode: mode is cached per process, but reachability isn't, so a
server that comes back is picked up on the next heartbeat.

**Claim safety is unchanged — a claim stays advisory in both modes.** Server mode does not upgrade
the soft-lock of §2, and nothing in this section should be read as a new guarantee. What it removes
is *propagation delay*, not the *race*: the read-then-write window in `setAssigneeIfOwner` is
serialized only within one anton process, so two anton servers — or a teammate's plain `bd` CLI —
can still interleave read→assign→verify and both report success, exactly as they can on embedded.
The claim simply becomes visible everywhere the instant it commits, which is why claim verification
skips its settle window there. Double-*execution* is prevented by the run lease (§4), not by the
claim; a hard cross-process CAS would need a new bd primitive and is deliberately not built
(anton-od4, closed won't-fix).

## 4. Background jobs + durability (the hard part)

An in-process **job runner** in the Next server: a loop that leases queued/due jobs, runs them,
and reschedules. Durability = **resumability, not retry-in-place**:

- **Idempotent jobs** — safe to re-run.
- **Leases** — a running job/run holds a lease; a crashed one is reclaimed when the lease
  expires (stale recovery).
- **API-limit backoff** — a run that hits a usage limit **parks** and the job is rescheduled
  past the reset window. You cannot retry an exhausted quota.
- **Poison-pill** — a job that fails `maxAttempts` times parks for a human (visible in the UI).
- **Two clocks, two different verdicts** (anton-t1mo) — a heartbeating handler is never reclaimed
  by the lease sweep, so timeouts are the only thing that catches a wedge. They are scoped so that
  "wedged" and "long" don't get the same answer:
  - `jobTimeoutMinutes` bounds **silence, not runtime**: the runner aborts a job that goes that
    long without a `ctx.heartbeat()`. A handler that reports no progress is bounded from dispatch,
    exactly as a total wall clock would be.
  - `ticketTimeoutMinutes` bounds **one ticket** — the knob an operator actually tunes.
    execute-epic's length is a function of how many tickets the feature has, so a whole-run budget
    guillotines a twenty-ticket feature mid-ticket however well it was going.

  A ticket that outlives its budget is **not fatal to the run**: its partial work is rolled back
  (otherwise the next ticket's commit sweeps it up under the wrong name), the bead is blocked with
  a note, and the walk continues — the feature ships what landed and leaves one thing for a human.
  A run where *every* ticket times out parks instead: an empty PR is a false success.

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
- **Add work** — opens an interactive `/shape` session in the xterm; the founder commits a
  **feature's** contract (Goal, Acceptance, Context, Out of scope, Verify) *and* the epic it hangs
  off — picked from the board, or shaped here (outcome, Success Criteria, one `area:`) and created
  alongside it. A feature is the run target, so this is the same shape `/shape` emits from the CLI;
  a draft naming no epic is refused rather than landing parentless. Both beads are rendered from
  the project's bead formula (`.beads/formulas/anton-bead.formula.json`, installed by setup,
  project-local copy wins), so they are contract-shaped by construction rather than flagged unshaped.

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
