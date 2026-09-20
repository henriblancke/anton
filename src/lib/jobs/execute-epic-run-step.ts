/**
 * What one post-commit formula step is handed, and what it leaves for the next (anton-1lix).
 *
 * A leaf module on purpose: the walk ({@link ./execute-epic-run-phase}) and the review step it
 * dispatches ({@link ./execute-epic-review-step}) both speak this shape, and either importing the
 * other for it would make them a cycle.
 */
import type { ReviewFinding } from "./review-context";
import type { ResolvedStep } from "./run-formula";
import type { StepContext } from "./step-registry";
import type { RunNarrative } from "./steps/result";

/** What one run step leaves for the ones after it — and, at the end, for the run row. */
export interface RunPhaseCarry {
  /**
   * Advisory findings the review gate left open. They ride along in the PR body so the founder sees
   * them at the merge gate, which is why the steps that follow are handed them.
   */
  advisories: ReviewFinding[];
  /**
   * The run's PR narrative, set by `describe` (anton-fpkk8). Restored at the top of the walk from
   * whatever a prior attempt on THIS run row already earned, so a resumed describer that fails to
   * report one (its own contract: a failure costs the narrative and nothing else, `steps/describe.ts`)
   * doesn't erase a perfectly good earlier one. A describer that DOES report one overwrites it, same
   * as advisories.
   */
  narrative?: RunNarrative;
  /**
   * A stale PR body's advisories, when even the bead note failed — carried out on the run row, the
   * only home left for text that exists nowhere else.
   */
  staleBodyFallback: string | null;
}

/** One dispatched run step: the cooked formula step, its handler, and the context it reads. */
export interface RunStepDispatch {
  cooked: ResolvedStep["step"];
  definition: ResolvedStep["definition"];
  stepCtx: StepContext;
}
