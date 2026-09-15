/**
 * The clean-verdict resume key (anton-qmuyt): what a clean self-review passed ON, not merely that it
 * passed, so a resume that finds the same key can skip the gate instead of blindly re-reviewing.
 *
 * Inputs, every one already computed elsewhere for its own reason, or read straight off what the
 * gate itself is handed:
 *  - the merge-base commit — the gate pins it per round (review-gate.ts), because a moved base is a
 *    different diff;
 *  - the branch tip — `readWorktreeState`'s HEAD, moved by any added, amended, or reset commit;
 *  - a hash of everything else `buildReviewPrompt` bakes into what the reviewer actually reads: the
 *    resolved reviewer contract, the `resolveReviewConfig` fields that shape the verdict (`enabled`,
 *    `maxRounds`, `scoreAlarm`), the target and ticket contracts (title, Goal/Acceptance/Out of
 *    scope/Verify), which `step:review` occurrence this is — since a formula may name the step more
 *    than once (review-gate.ts) and each is its own independent gate — and the advisories carried
 *    INTO this gate: a later `step:review` is handed the still-open advisories an earlier one in the
 *    same formula left off (`buildReviewPrompt`'s `carriedAdvisories`), and the run row keeps only the
 *    latest clean key, so a resumed earlier gate that reruns and produces a different carry must not
 *    let a stale key for the later gate go on matching it.
 *
 * HEAD is the right tip by construction: the gate reviews `merge-base..HEAD` and the PR contains
 * `merge-base..HEAD`, so "what the reviewer saw" and "what the human merges" are the same range. The
 * one blind spot is an edited-but-uncommitted worktree — the tip doesn't move, so the key still
 * matches — which is consistent with `git push` sending commits only: an uncommitted change reaches
 * neither the PR nor the reviewer either.
 */
import { createHash } from "node:crypto";
import { acceptanceBody, goalBody, outOfScopeBody, verifyBody } from "../beads/contract";
import type { Bead } from "../beads/types";
import { readWorktreeState, resolveMergeBase } from "../git/ops";
import { resolveReviewConfig, type ProjectSettings, type ReviewConfig } from "../projects";
import { resolveReviewerContract, type ReviewFinding, type ReviewerSource } from "./review-context";

export interface ReviewKey {
  baseRev: string;
  head: string;
  /** sha256 of everything else that shapes the verdict: reviewer contract, config, bead contracts, step identity. */
  fingerprint: string;
}

/** One string a resume compares by exact equality — never parsed back apart. */
export function reviewKeyToken(key: ReviewKey): string {
  return `${key.baseRev}:${key.head}:${key.fingerprint}`;
}

/**
 * The same four contract sections {@link beadBlock} (review-context.ts) renders into the prompt, for
 * the target plus every ticket — normalized the same way so an edit to Acceptance, Out of scope, or
 * Verify after a clean verdict moves this fingerprint even though it touches neither git ref.
 */
function fingerprintBeads(target: Bead, tickets: Bead[]): string {
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const beads = [target, ...(standalone ? [] : tickets)];
  return JSON.stringify(
    beads.map((b) => ({
      id: b.id,
      title: b.title,
      goal: goalBody(b) ?? "",
      acceptance: acceptanceBody(b) ?? "",
      outOfScope: outOfScopeBody(b) ?? "",
      verify: verifyBody(b) ?? "",
    })),
  );
}

function fingerprintContract(args: {
  reviewer: ReviewerSource;
  reasoning: string;
  config: ReviewConfig;
  stepId: string;
  contracts: string;
  carriedAdvisories: ReviewFinding[];
}): string {
  const { reviewer, reasoning, config, stepId, contracts, carriedAdvisories } = args;
  return createHash("sha256")
    .update(
      JSON.stringify({
        reviewer,
        reasoning,
        enabled: config.enabled,
        maxRounds: config.maxRounds,
        scoreAlarm: config.scoreAlarm,
        stepId,
        contracts,
        carriedAdvisories,
      }),
    )
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
  /** The run target and its tickets — the same beads {@link fingerprintBeads} reads Acceptance from. */
  target: Bead;
  tickets: Bead[];
  /** This step's id within the formula ({@link CookedStep.id}) — distinct `step:review` occurrences
   * must never satisfy one another's resume check (anton-nyz1v). */
  stepId: string;
  /**
   * The still-open advisories this gate is handed on entry (`carry.advisories`, restated to it as
   * `buildReviewPrompt`'s `carriedAdvisories`) — a later `step:review` reads a different prompt when
   * an earlier gate in the same formula reruns and settles a different set on an otherwise identical
   * tree, even though `stepId` alone can't tell the two runs apart (anton-nyz1v).
   */
  carriedAdvisories: ReviewFinding[];
}): Promise<ReviewKey> {
  const { worktreePath, baseBranch, settings, target, tickets, stepId, carriedAdvisories } = args;
  const [baseRev, state] = await Promise.all([
    resolveMergeBase(worktreePath, baseBranch),
    readWorktreeState(worktreePath),
  ]);
  const config = resolveReviewConfig(settings);
  const { reasoning, reviewer } = await resolveReviewerContract(settings, worktreePath, baseRev);
  const contracts = fingerprintBeads(target, tickets);
  return {
    baseRev,
    head: state.head,
    fingerprint: fingerprintContract({ reviewer, reasoning, config, stepId, contracts, carriedAdvisories }),
  };
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
