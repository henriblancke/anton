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
 *    `maxRounds`, `scoreAlarm`), the `resolveVerifyGates` commands `runReviewSession` runs as evidence
 *    for the reviewer (review-gate.ts) — a project that adds or edits `testCommand`, `lintCommand`,
 *    `typecheckCommand`, or `buildCommand` after a clean verdict must not have a resume skip the newly
 *    required gate — the target and ticket contracts (title, Goal/Acceptance/Out of scope/Verify),
 *    which `step:review` occurrence this is — since a formula may name the step more than once
 *    (review-gate.ts) and each is its own independent gate — the advisories carried INTO this
 *    gate: a later `step:review` is handed the still-open advisories an earlier one in the same
 *    formula left off (`buildReviewPrompt`'s `carriedAdvisories`), and the run row keeps only the
 *    latest clean key, so a resumed earlier gate that reruns and produces a different carry must not
 *    let a stale key for the later gate go on matching it — and the resolved reviewer MODEL (PR #280
 *    review): `runReviewSession` picks it with `resolveModel(settings, {jobType: "execute-epic",
 *    step: "review", labels})` (review-gate.ts), which a label change on the target/tickets or an
 *    edited `modelRoutes`/`model` setting can move even though `reviewer`'s own shape (agent/prompt/
 *    default) stays the same — a resume must not skip a review that would now run on a different
 *    model than the one whose verdict it is honoring.
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
import { readWorktreeState } from "../git/ops";
import { resolveReviewConfig, resolveVerifyGates, type ProjectSettings, type ReviewConfig, type VerifyGate } from "../projects";
import { resolveModel } from "./model-routing";
import { resolveReviewerContract, type ReviewFinding, type ReviewerSource } from "./review-context";
import type { RunNarrative } from "./steps/result";

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
  reviewModel: string | undefined;
  reasoning: string;
  config: ReviewConfig;
  verifyGates: VerifyGate[];
  stepId: string;
  contracts: string;
  carriedAdvisories: ReviewFinding[];
}): string {
  const { reviewer, reviewModel, reasoning, config, verifyGates, stepId, contracts, carriedAdvisories } = args;
  return createHash("sha256")
    .update(
      JSON.stringify({
        reviewer,
        reviewModel,
        reasoning,
        enabled: config.enabled,
        maxRounds: config.maxRounds,
        scoreAlarm: config.scoreAlarm,
        verifyGates,
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
  /**
   * The merge-base COMMIT the review actually judged — the gate's own pinned SHA
   * ({@link ReviewGateResult.baseRev}) when one is available, or a fresh resolution of
   * {@link StepContext.baseRef} when checking a resume before any gate in this attempt has run.
   * Never re-resolve `baseRef` after a gate has already pinned one: the branch it names is
   * movable, and a sibling run's fetch between the gate's verdict and this call could advance it
   * to a commit the reviewer never saw.
   */
  baseRev: string;
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
  const { worktreePath, baseRev, settings, target, tickets, stepId, carriedAdvisories } = args;
  const state = await readWorktreeState(worktreePath);
  const config = resolveReviewConfig(settings);
  const verifyGates = resolveVerifyGates(settings);
  const { reasoning, reviewer } = await resolveReviewerContract(settings, worktreePath, baseRev);
  const contracts = fingerprintBeads(target, tickets);
  // The exact routing call `runReviewSession` makes (review-gate.ts) — same jobType/step/labels —
  // so a route added, removed, or repointed after the clean verdict moves this key even when the
  // reviewer's `kind` (agent/prompt/default) does not.
  const reviewModel = resolveModel(settings, {
    jobType: "execute-epic",
    step: "review",
    labels: [target, ...tickets].flatMap((bead) => bead.labels ?? []),
  });
  return {
    baseRev,
    head: state.head,
    fingerprint: fingerprintContract({ reviewer, reviewModel, reasoning, config, verifyGates, stepId, contracts, carriedAdvisories }),
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

/**
 * A narrative as it is PERSISTED: the report plus the branch tip it was written against (PR #303
 * review). The tip is what makes the restore safe — see {@link parseRecordedNarrative}.
 */
export interface RecordedNarrative {
  narrative: RunNarrative;
  /** The worktree HEAD the describer read, or undefined for a row written before this was recorded. */
  head?: string;
}

/** Serialize a narrative for the run row, bound to the HEAD the describer actually described. */
export function recordNarrative(narrative: RunNarrative, head: string | undefined): string {
  return JSON.stringify({ ...narrative, ...(head ? { head } : {}) });
}

/**
 * The narrative a resumed run restores into the run-phase carry (anton-fpkk8), mirroring
 * {@link parseRecordedAdvisories}'s tolerance: a null column, an empty string, garbled JSON, or a
 * shape missing the one required field all yield no narrative rather than throwing — a misread
 * narrative here costs a PR body, never a run.
 *
 * Returns the recorded HEAD alongside the report so the caller can bind it to the branch as it
 * stands NOW. Callers must not restore a narrative whose head has moved: see
 * {@link restorableNarrative}, which is the only caller that should decide a restore.
 */
export function parseRecordedNarrative(raw: string | null | undefined): RecordedNarrative | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).summary === "string" &&
      // TRIMMED-non-empty, exactly as `isRunNarrative` (steps/describe.ts) requires of a freshly
      // parsed report: a whitespace-only summary is not a narrative, and restoring one as if it were
      // would open the PR body with a blank opening instead of falling back to today's body.
      // Unreachable through the normal write path (`sanitizeNarrativeField` trims before persisting),
      // so this is symmetry with the parser it mirrors rather than a live bug — PR #303 review.
      ((parsed as Record<string, unknown>).summary as string).trim()
    ) {
      const { head, ...narrative } = parsed as RunNarrative & { head?: unknown };
      return {
        narrative: narrative as RunNarrative,
        ...(typeof head === "string" && head ? { head } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The narrative a resume may actually USE: the recorded one, but only when the branch still stands
 * where the describer left it (PR #303 review).
 *
 * The restore exists for a resumed-in-place row whose describer does not re-report — its own
 * contract is that a failure costs the narrative and nothing else. But a run can be resumed after a
 * human amends or adds commits (a park they cleared by fixing the branch themselves), and a failed
 * re-describe would then let the PR open with a narrative describing the PREVIOUS tree — confidently
 * wrong prose about code that is no longer there. Binding to HEAD keeps the restore for the case it
 * was built for (same tree, describer didn't re-report) and discards it for the case it was never
 * meant to cover.
 *
 * Discards rather than throws on every doubt — an unreadable HEAD, a record written without one —
 * because the fallback is today's PR body, which costs a nicer opening and nothing else.
 */
export async function restorableNarrative(
  worktreePath: string,
  raw: string | null | undefined,
): Promise<RunNarrative | undefined> {
  const recorded = parseRecordedNarrative(raw);
  if (!recorded?.head) return undefined;
  const head = await readWorktreeState(worktreePath)
    .then((state) => state.head)
    .catch(() => undefined);
  return head && head === recorded.head ? recorded.narrative : undefined;
}
