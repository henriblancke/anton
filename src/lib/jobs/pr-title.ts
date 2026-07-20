/**
 * Pure PR-title derivation for execute-epic (anton-41d). anton builds the epic PR title itself
 * (bypassing the agent), so the operator's "follow conventional commits" intent has to be applied
 * here. Gated by the opt-in `conventionalCommits` project setting: OFF (default) keeps today's
 * exact `${title} (${id})`; ON prefixes a deterministic conventional-commit type/scope derived
 * from the target bead — never LLM-derived (a decision this session). PR-title-only: squash-merge
 * makes the PR title the commit that lands on main, so this still shapes main history.
 */
import { labelValueOf, type Bead } from "../beads/bd";

/**
 * Deterministic conventional-commit type from the target bead's issue type: a `bug` is a `fix`,
 * an `epic`/`task` is a `feat`. Only feat/fix are derivable from bead metadata (by decision), so
 * anything else falls back to `feat`.
 */
function conventionalType(issueType: string | undefined): "feat" | "fix" {
  return issueType === "bug" ? "fix" : "feat";
}

/**
 * The epic/standalone PR title. When `conventionalCommits` is off (or absent) this is byte-identical
 * to anton's historical `${title} (${id})`. When on, it prefixes `<type>(<scope>): ` — type from the
 * bead's issue type, scope from the `agent:` label when present (`feat(nextjs): …`) and omitted
 * otherwise (`feat: …`).
 */
export function buildPrTitle(
  target: Pick<Bead, "title" | "issue_type" | "labels">,
  epicBeadId: string,
  conventionalCommits: boolean | undefined,
): string {
  const suffix = `${target.title} (${epicBeadId})`;
  if (!conventionalCommits) return suffix;
  const type = conventionalType(target.issue_type);
  const scope = labelValueOf(target.labels, "agent");
  const prefix = scope ? `${type}(${scope})` : type;
  return `${prefix}: ${suffix}`;
}
