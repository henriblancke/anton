/**
 * The clean-verdict resume key (anton-qmuyt): what a clean self-review passed ON, not merely that it
 * passed, so a resume that finds the same key can skip the gate instead of blindly re-reviewing.
 *
 * Three inputs, every one already computed elsewhere for its own reason:
 *  - the merge-base commit — the gate pins it per round (review-gate.ts), because a moved base is a
 *    different diff;
 *  - the branch tip — `readWorktreeState`'s HEAD, moved by any added, amended, or reset commit;
 *  - a hash of the reviewer contract — {@link resolveReviewerContract}'s resolved text plus the
 *    `resolveReviewConfig` fields that shape the verdict (`maxRounds`, `scoreAlarm`), since the
 *    contract is project-editable and a run that never touches it must not reuse a verdict graded on
 *    a rubric that has since changed underneath it.
 *
 * HEAD is the right tip by construction: the gate reviews `merge-base..HEAD` and the PR contains
 * `merge-base..HEAD`, so "what the reviewer saw" and "what the human merges" are the same range. The
 * one blind spot is an edited-but-uncommitted worktree — the tip doesn't move, so the key still
 * matches — which is consistent with `git push` sending commits only: an uncommitted change reaches
 * neither the PR nor the reviewer either.
 */
import { createHash } from "node:crypto";
import { readWorktreeState, resolveMergeBase } from "../git/ops";
import { resolveReviewConfig, type ProjectSettings, type ReviewConfig } from "../projects";
import { resolveReviewerContract, type ReviewFinding, type ReviewerSource } from "./review-context";

export interface ReviewKey {
  baseRev: string;
  head: string;
  /** sha256 of the resolved reviewer contract + the config fields that shape the verdict. */
  fingerprint: string;
}

/** One string a resume compares by exact equality — never parsed back apart. */
export function reviewKeyToken(key: ReviewKey): string {
  return `${key.baseRev}:${key.head}:${key.fingerprint}`;
}

function fingerprintContract(reviewer: ReviewerSource, reasoning: string, config: ReviewConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({ reviewer, reasoning, maxRounds: config.maxRounds, scoreAlarm: config.scoreAlarm }))
    .digest("hex");
}

/**
 * Recompute the key for the worktree as it stands right now — the same shape a clean verdict was
 * recorded under, so an exact match means the reviewer would be handed a byte-identical diff and
 * contract.
 */
export async function computeReviewKey(args: {
  worktreePath: string;
  /** The pinned fork ref the review step itself diffs against ({@link StepContext.baseRef}). */
  baseBranch: string;
  settings: ProjectSettings;
}): Promise<ReviewKey> {
  const { worktreePath, baseBranch, settings } = args;
  const [baseRev, state] = await Promise.all([
    resolveMergeBase(worktreePath, baseBranch),
    readWorktreeState(worktreePath),
  ]);
  const config = resolveReviewConfig(settings);
  const { reasoning, reviewer } = await resolveReviewerContract(settings, worktreePath, baseRev);
  return { baseRev, head: state.head, fingerprint: fingerprintContract(reviewer, reasoning, config) };
}

/** The advisories a skipped review restores into the run-phase carry, or none for an unparseable row. */
export function parseRecordedAdvisories(raw: string | null | undefined): ReviewFinding[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReviewFinding[]) : [];
  } catch {
    return [];
  }
}
