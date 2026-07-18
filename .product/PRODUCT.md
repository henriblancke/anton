# PRODUCT

The stable context every anton skill reads before shaping or building. Keep it current; keep
it short. This is *what this business is* — not a backlog (that's beads) and not entities
(those are `entities/`).

## What it is
anton is a local, single-user app that turns an idea — or a finding from scanning your code —
into work that ships itself. You describe what you want; anton **shapes** it into an epic with
concrete tickets and sets it aside for your OK. Once you **approve**, it runs each ticket
autonomously: isolated git worktree → drives `claude` to write the code → runs your tests →
opens a PR → then **auto review-fixes** the PR until comments and CI are clean. The loop:
`shape → approve → autonomous run → PR → auto review-fix`.

## Who it's for (ICP)
A solo developer/founder who wants work to ship autonomously while staying in control at
exactly two gates — approving the epic and merging the PR. Runs entirely on their own machine
(nothing to sign up for, nothing leaves the box); reached as an open local tool, not a service.

## Why it wins
Local, not deployed — it drives your existing `claude`, `git`, `gh`, `bd`, and `stringer`, so
there's no hosted runtime and nothing leaves your machine. Epic-first and approval-gated: the
founder decides what ships, anton owns everything in between. It doesn't stop at the PR — it
keeps working the PR (review comments + red CI) until it's mergeable, which is the part most
"AI writes a PR" tools drop.

## What we're deliberately NOT doing
- Not a hosted/deployed service — no Vercel Workflow, no Cache Components, no multi-tenant
  serverless. It's a local Next.js server by design.
- Not the work source of truth — beads owns epics/tickets/stage/PR links; anton never forks that.
- Not auto-merging — approve and merge stay human decisions.

## Success signals
- Approved epics reach an open, green, review-clean PR with no human touch between approve and merge.
- review-fix closes reviewer comments and CI failures without a human re-driving the PR.
- The board stays trustworthy — stage is always derived live from beads, never a stale cache.

## Stack
Next.js 16 (App Router) + React 19, Drizzle ORM over SQLite (`anton.db`, app/execution state
only), Zod 4, Tailwind 4, Vitest, TypeScript, bun. beads (Dolt-synced via `refs/dolt/data`) is
the work source of truth. Drives local `claude`, `git`, `gh`, `bd`, `stringer`. Applicable
agent: `nextjs` (app layer; Drizzle is covered there — no separate DB agent). No Python, Docker,
Terraform, or Kubernetes surface at the repo root.
