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

The operating context these skills need travels with them: `bd` embeds anton's beads conventions,
and `shape` carries anton's values inline — so a `/shape` run has full context from anton's
assets alone.

## How they're used

- **anton's runtime** loads the skill bodies directly for its background jobs
  (`scan-triage` → nightly-stringer, `review-fix` → review-fix) via
  `src/lib/claude/prompt.ts` (`loadSkill`).
- **The setup wizard** (epic `anton-3n5`) treats this whole set as anton's **REQUIRED** skills —
  always installed into a target project's `.claude/skills/`, never deselectable — so an
  interactive `claude` session in that project resolves `/shape`, the `bd` conventions, etc.

The canonical list lives in `REQUIRED_SKILLS` in `src/lib/claude/prompt.ts`; a test asserts each
asset is present and well-formed.
