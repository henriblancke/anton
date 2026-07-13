# Contributing to anton

Setup, quality gates, and release process for working *on* anton. If you just want to *run* anton, see the [README](./README.md).

## Local development

```bash
bun install          # install dependencies (also installs the husky pre-commit hook)
anton setup          # prereq checks, DB migrations, node-pty rebuild
```

anton is a Next.js app; during development use the scripts directly:

```bash
anton dev            # or: bun run dev   — Next.js dev server (hot reload)
anton start          # or: bun run build && bun run start
```

The **job runner and cron scheduler auto-start** with the server (via `src/instrumentation.ts`). Set `ANTON_RUNNER=off` to boot the UI without them — useful when you want to inspect state without anything executing.

## Quality gates

```bash
bun run lint         # eslint
bun run typecheck    # tsc --noEmit
bun run test         # vitest (unit + integration; integration suites self-skip
                     # when bd/gh/stringer/claude aren't installed)
bun run build        # next build
```

- **Pre-commit** — a husky hook runs `lint-staged` (`eslint --fix` on staged `.ts`/`.tsx`) then `typecheck`. Installed automatically on `bun install`.
- **CI** — `.github/workflows/ci.yml` runs lint + typecheck + test + build on every push to `main` and every PR.
- **Release** — pushing a `v*` tag runs the same gates and cuts a GitHub Release (`.github/workflows/release.yml`).

## Database migrations

anton uses Drizzle over `better-sqlite3`. After editing `src/lib/db/schema.ts`:

```bash
bun run db:generate  # generate a migration from the schema diff
bun run db:migrate   # apply pending migrations to anton.db
```

`anton setup` also runs `db:migrate`, so a fresh checkout gets an up-to-date `anton.db`.

## Issue tracking

This repo uses **bd (beads)**, not markdown TODOs.

```bash
bd ready             # find available work
bd show <id>         # view issue detail
bd update <id> --claim   # claim work
bd close <id>        # complete work
```

Run `bd prime` for the full workflow context and session-close protocol.

**How beads state syncs:** the issue database is Dolt, and it syncs through
`refs/dolt/data` on the git remote — not through committed files. `anton setup`
points the Dolt remote at git `origin` and hydrates a fresh clone with
`bd dolt pull`. The `.beads/*.jsonl` files are passive, git-ignored local
exports for viewers; never commit them and never treat them as the source of
truth.
