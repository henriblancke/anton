/**
 * The pipeline step ids, as a dependency-free list.
 *
 * Separate from {@link BUILTIN_STEPS} (step-registry.ts) purely so the settings boundary and the
 * settings form can name a step without dragging the handlers — git ops, the Claude driver, the
 * review gate — into their module graph. step-registry types its registry against
 * {@link BuiltinStepId}, so a step added there without an id here (or an id here with no handler)
 * fails typecheck rather than shipping a settings control that names a step nothing runs.
 */
import type { JobType } from "./queue";

/** A `step:<name>` label's suffix — the handler a formula step resolves to. */
export const BUILTIN_STEP_IDS = [
  "implement",
  "verify",
  "review",
  "commit",
  "pr",
  "claude",
] as const;

export type BuiltinStepId = (typeof BUILTIN_STEP_IDS)[number];

/** The pipeline steps that invoke Claude and can therefore be selected by a model route. */
export const MODEL_ROUTABLE_STEP_IDS = ["implement", "review", "claude"] as const;

const MODEL_ROUTABLE_STEP_ID_SET = new Set<string>(MODEL_ROUTABLE_STEP_IDS);

export function isModelRoutableStepId(value: unknown): value is (typeof MODEL_ROUTABLE_STEP_IDS)[number] {
  return typeof value === "string" && MODEL_ROUTABLE_STEP_ID_SET.has(value);
}

const STEP_IDS = new Set<string>(BUILTIN_STEP_IDS);

export function isBuiltinStepId(value: unknown): value is BuiltinStepId {
  return typeof value === "string" && STEP_IDS.has(value);
}

/**
 * The only job type that walks a run formula — so a `step:` id is a fact about THIS job and no
 * other. Every other type (a review-fix, a scheduled pass) runs its own handler end to end and has
 * no steps at all, which is what makes "this job type, that step" an unsatisfiable pair worth
 * rejecting at the settings boundary.
 *
 * Hand-declared because deriving it means importing execute-epic. If a second type ever walks a
 * formula, widen this to a set — the model-routing cross-check reads it as the whole truth.
 */
export const PIPELINE_JOB_TYPE: JobType = "execute-epic";
