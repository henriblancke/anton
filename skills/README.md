# anton skills — the required set

These are **anton's own skills**, vendored so anton is standalone: it needs no external plugin,
loom project, or session-start hook to shape work or run its jobs. Each skill is a self-contained
[Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) — a directory with a
`SKILL.md` (frontmatter `name` + `description`, then the body).

## The required skills

| Skill         | Role |
|---------------|------|
| `bd`          | How anton writes to the beads board — labels, edges, lifecycle, the bead contract, exact `bd` commands. The standalone conventions home; `shape` and `scan-triage` reference it. |
| `shape`       | Idea → validated epic + contract-shaped child beads (`/shape`). |
| `scan-triage` | Stringer scan → the few beads worth doing (`/scan-triage`). Run by anton's nightly-stringer job. |
| `review-fix`  | Per-finding judgment for resolving open-PR review feedback. Run by anton's review-fix job. |
| `setup`       | Scaffold a repo's `.beads/` + `.product/` from anton's bundled templates (`/setup`). The one skill a founder runs by hand, in their own repo, before `/shape` has anything to read. |

The operating context these skills need travels with them: `bd` embeds anton's beads conventions,
and `shape` carries anton's values inline — so a `/shape` run has full context from anton's
assets alone.

## How they're used

- **anton's runtime** loads the skill bodies directly for its background jobs
  (`scan-triage` → nightly-stringer, `review-fix` → review-fix) via
  `src/lib/claude/prompt.ts` (`loadSkill`).
- **The setup wizard** (epic `anton-3n5`) treats the four runtime-backed skills — `bd`, `shape`,
  `scan-triage`, `review-fix` — as anton's **REQUIRED** set: always installed into a target
  project's `.claude/skills/`, never deselectable, so an interactive `claude` session in that
  project resolves `/shape`, the `bd` conventions, etc.
- **`setup` is founder-run, not job-loaded.** It's bundled here so `/setup` resolves in a target
  repo, but anton's runtime never loads it for a background job (there's nothing to scaffold
  server-side), so it lives outside `REQUIRED_SKILLS`.

The canonical required list lives in `REQUIRED_SKILLS` in `src/lib/claude/prompt.ts`; a test
asserts each of those assets is present and well-formed.
