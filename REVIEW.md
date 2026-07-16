# PR Review Instructions

These instructions are posted to Codex on every pull request. Keep them focused on what matters for
this codebase; Codex already reads `AGENTS.md` for general conventions.

## Priorities (in order)

1. **Correctness** — logic bugs, unhandled edge cases, incorrect async/await, race conditions, and
   off-by-one errors.
2. **Process & CLI boundaries** — this codebase shells out to external CLIs (`bd`, `gh`, `stringer`,
   `claude`). Flag unvalidated interpolation into shell commands, missing error handling on spawned
   processes, and assumptions that a CLI is present without a guard.
3. **Data layer** — review Drizzle schema/query changes for destructive or non-reversible
   migrations, and confirm schema changes line up with their query sites.
4. **Regressions** — behavior changes that aren't covered by a test.

## This project's conventions

- Next.js App Router with Server Components by default. Flag `"use client"` added without need, and
  data fetching pushed to the client that belongs on the server.
- Runtime is **bun** — flag Node-only APIs or npm-specific assumptions that won't hold under bun.
- Tests are `vitest` (`bun run test`). Integration suites self-skip when their CLI is absent; new
  logic paths should still ship with a unit test.
- Note missing test coverage on new logic paths.

## What to keep quiet about

- Pure formatting/style already enforced by ESLint — don't restate lint.
- Subjective naming preferences unless they genuinely obscure meaning.
- Speculative "you could also…" suggestions with no concrete defect behind them.

Prefer a short list of high-confidence findings over an exhaustive one.
