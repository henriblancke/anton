# PRODUCT

The stable context every anton skill reads before shaping or building. Keep it current; keep
it short. This is *what this business is* — not a backlog (that's beads) and not entities
(those are `entities/`).

## What it is
anton is a local, single-user app that turns an idea — or a finding from scanning your code —
into work that ships itself. You describe what you want; anton **shapes** it into an epic with
concrete tickets and sets it aside for your OK. **Approval** is the founder's gate, and it is
authored once: arm a standing policy — written in your repo's own labels — and anton's
deterministic picker approves and starts the work that falls inside it, showing its hand in Up
Next first so you can veto a target before it runs. Approving a single target by hand stays
available, and disarming returns every start to your click. From there each ticket runs
autonomously: isolated git worktree → drives `claude` to write the code → runs your tests →
opens a PR → then **auto review-fixes** the PR until comments and CI are clean. The loop:
`shape → approve (a standing policy, or one target) → autonomous run → PR → auto review-fix`.

## Who it's for (ICP)
A solo developer/founder who wants work to ship autonomously while staying in control of two
things — what anton may start (a standing approval policy they author and can disarm, or a
per-epic approval) and merging the PR. Runs entirely on their own machine (nothing to sign up
for, nothing leaves the box); reached as an open local tool, not a service.
The one exception is **opt-in and self-hosted**: a project can point its board at a shared Dolt
server *the team runs* so a small team works one real-time board instead of push/pull syncing
(DESIGN.md §3a). Still no vendor, no account, no anton service — the default stays fully local.

## Why it wins
Local, not deployed — it drives your existing `claude`, `git`, `gh`, `bd`, and `stringer`, so
there's no hosted runtime and nothing leaves your machine except what you deliberately point it
at (the opt-in team Dolt server above, which is yours). Epic-first and approval-gated: the
founder authors the boundary, anton owns everything inside it. It doesn't stop at the PR — it
keeps working the PR (review comments + red CI) until it's mergeable, which is the part most
"AI writes a PR" tools drop.

## What we're deliberately NOT doing
- Not a hosted/deployed service — no Vercel Workflow, no Cache Components, no multi-tenant
  serverless. It's a local Next.js server by design; the opt-in team board server is *your*
  infrastructure, not anton becoming a service.
- Not the work source of truth — beads owns epics/tickets/stage/PR links; anton never forks that.
- Not auto-merging — merge stays a human decision, including under an armed policy.
- Not an LLM picking the work — selection and ranking are deterministic code, so a start is
  explainable and costs nothing.
- Not a shared policy — a standing approval is armed per project; there is no cross-project or
  global arming.

## Success signals
- Approved epics reach an open, green, review-clean PR with no human touch between approve and merge.
- review-fix closes reviewer comments and CI failures without a human re-driving the PR.
- The board stays trustworthy — stage is always derived live from beads, never a stale cache.

## Stack
Next.js 16 (App Router) + React 19, Drizzle ORM over SQLite (`anton.db`, app/execution state
only), Zod 4, Tailwind 4, Vitest, TypeScript, bun. beads is the work source of truth — Dolt-synced
via `refs/dolt/data` by default, or held on a self-hosted shared `dolt sql-server` in server mode.
Drives local `claude`, `git`, `gh`, `bd`, `stringer`. Applicable
agent: `nextjs` (app layer; Drizzle is covered there — no separate DB agent). No Python, Docker,
Terraform, or Kubernetes surface at the repo root.
