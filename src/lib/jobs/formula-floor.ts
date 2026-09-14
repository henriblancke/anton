/**
 * anton's invariant floor (anton-6b99): the only thing a project pipeline may NOT do.
 *
 * The run formula is project-owned (anton-hrql) — that is the point, and it is only safe because
 * there is a floor underneath it. anton owns the run's guarantees (one run target = one worktree =
 * one PR, git as the evidence of record, park-on-failure); the project owns the steps. So the floor
 * constrains OMISSION and ORDER, never extension: a formula may add as many steps as it likes, but
 * it may not define a run that never implements, never commits, or never reaches a human — and it
 * may not order the steps so that the work it does is thrown away, reviewed before it exists, or
 * gated behind a step the run's own completion marker would let a resume skip.
 *
 * This module is pure. It takes a cooked formula plus the step registry (anton-4npr, which DECLARES
 * the classes and which steps write to the worktree) and returns the full list of violations —
 * never one, and never a throw, so an operator fixes the file once instead of a round trip per
 * problem. {@link assertRunFormulaFloor} is the thin FAIL-LOUD wrapper execute-epic calls at run
 * start, before the lease is published and before a worktree exists.
 *
 * Order here means EXECUTION order, because that is what the walker runs: the loader (anton-hrql)
 * hands back `cooked.steps` already sorted by `needs` (declaration order breaking ties), and the
 * walk follows that list one step at a time.
 */
import type { CookedFormula, CookedStep } from "../beads/bd";
import { PoisonEpic } from "./errors";
import {
  BUILTIN_STEPS,
  STEP_LABEL_PREFIX,
  stepName,
  type StepDefinition,
  type StepRegistry,
} from "./step-registry";

/**
 * The ordering invariants name specific steps rather than classes: git is the run's evidence of
 * record (`commit`), the PR is the only way the work reaches a human (`pr`), and the self-review is
 * the one step that reads the committed diff (`review`). They live here, not in the registry,
 * because the ORDER is anton's invariant — the registry only declares what a step is and whether it
 * writes to the worktree.
 */
const COMMIT_STEP = "commit";
const PR_STEP = "pr";
const REVIEW_STEP = "review";

export type FloorViolationKind =
  | "unresolved-step"
  | "duplicate-step-id"
  | "missing-required-step"
  | "duplicate-required-step"
  | "pr-before-commit"
  | "step-after-pr"
  | "review-before-commit"
  | "diff-after-commit";

export interface FloorViolation {
  kind: FloorViolationKind;
  /** The offending step — its formula id, or `step:<name>` when the fault is that there is none. */
  step: string;
  /** One line an operator can act on: what is wrong, and what the floor requires instead. */
  detail: string;
}

export interface FloorCheckResult {
  /** True exactly when `violations` is empty. */
  ok: boolean;
  violations: FloorViolation[];
}

/** A cooked step paired with the registry entry its `step:<name>` label names, if any. */
interface Classified {
  step: CookedStep;
  definition?: StepDefinition;
}

/** The formula as the floor reads it: steps in EXECUTION order, addressable by step name. */
interface Pipeline {
  steps: Classified[];
  /** Execution index of the first step resolving to `name`, or -1 when the formula has none. */
  indexOf(name: string): number;
}

/** One floor condition: given the pipeline, the steps it refuses. Empty when the condition holds. */
type FloorCheck = (pipeline: Pipeline, registry: StepRegistry) => FloorViolation[];

function classify(cooked: CookedFormula, registry: StepRegistry): Pipeline {
  const steps: Classified[] = (cooked.steps ?? []).map((step) => {
    const name = stepName(step);
    return { step, definition: name ? registry[name] : undefined };
  });
  return { steps, indexOf: (name) => steps.findIndex((c) => c.definition?.name === name) };
}

/**
 * Refuses a step anton cannot classify. Resolution comes first: an unresolved step has no class and
 * no diff behaviour, so every later check would have to guess what it is. Collected rather than
 * thrown — the loader (anton-hrql) already parks on this with a fuller message; here it only has to
 * keep the floor's own report honest.
 */
const refuseUnclassifiableSteps: FloorCheck = ({ steps }) =>
  steps.flatMap(({ step, definition }) => {
    if (definition) return [];
    const name = stepName(step);
    return [
      {
        kind: "unresolved-step" as const,
        step: step.id,
        detail: name
          ? `step "${step.id}" names \`${STEP_LABEL_PREFIX}:${name}\`, which maps to no anton handler — ` +
            `anton cannot tell whether it satisfies the floor, so the run is parked rather than skipping it`
          : `step "${step.id}" carries no \`${STEP_LABEL_PREFIX}:<name>\` label, so anton cannot tell what ` +
            `it should run`,
      },
    ];
  });

/** Refuses an id used twice: ids are how `needs` addresses a step and how the run log names one. */
const refuseDuplicateStepIds: FloorCheck = ({ steps }) => {
  const timesById = new Map<string, number>();
  for (const { step } of steps) timesById.set(step.id, (timesById.get(step.id) ?? 0) + 1);

  return [...timesById]
    .filter(([, times]) => times > 1)
    .map(([id, times]) => ({
      kind: "duplicate-step-id" as const,
      step: id,
      detail:
        `step id "${id}" is declared ${times} times — ids are how \`needs\` addresses a step and how ` +
        `the run log names one, so a repeated id makes the pipeline ambiguous`,
    }));
};

/**
 * Refuses a required step that is missing or repeated. Read from the registry's classes rather than
 * a list held here — adding a required step is then a one-line registry change, not two.
 */
const refuseRequiredStepNotDeclaredExactlyOnce: FloorCheck = ({ steps }, registry) =>
  Object.values(registry).flatMap((definition): FloorViolation[] => {
    if (definition.class !== "required") return [];
    const found = steps.filter((c) => c.definition?.name === definition.name);
    if (found.length === 1) return [];

    if (found.length === 0) {
      return [
        {
          kind: "missing-required-step",
          step: `${STEP_LABEL_PREFIX}:${definition.name}`,
          detail:
            `no step is labelled \`${STEP_LABEL_PREFIX}:${definition.name}\` — the floor requires one, to ` +
            `${definition.summary}. A run without it has no evidence of record or no way to reach a human`,
        },
      ];
    }
    return [
      {
        kind: "duplicate-required-step",
        step: found.map((f) => f.step.id).join(", "),
        detail:
          `\`${STEP_LABEL_PREFIX}:${definition.name}\` is declared ${found.length} times ` +
          `(${found.map((f) => `"${f.step.id}"`).join(", ")}) — a run is one worktree, one commit point ` +
          `and one PR, so each required step runs exactly once`,
      },
    ];
  });

/**
 * Refuses a PR opened before the commit: it would be opened on a branch carrying none of the run's
 * work, and the commit that followed would land where no reviewer is looking.
 */
const refusePrBeforeCommit: FloorCheck = ({ steps, indexOf }) => {
  const commitAt = indexOf(COMMIT_STEP);
  const prAt = indexOf(PR_STEP);
  if (commitAt < 0 || prAt < 0 || prAt > commitAt) return [];

  return [
    {
      kind: "pr-before-commit",
      step: steps[prAt].step.id,
      detail:
        `step "${steps[prAt].step.id}" opens the PR before "${steps[commitAt].step.id}" ` +
        `commits — the PR would be opened on a branch carrying none of the run's work, and the commit ` +
        `that followed would land where no reviewer is looking. The floor requires \`` +
        `${STEP_LABEL_PREFIX}:${COMMIT_STEP}\` to precede \`${STEP_LABEL_PREFIX}:${PR_STEP}\``,
    },
  ];
};

/**
 * Refuses any step placed after the PR. The PR is the run's TERMINUS, not merely its last required
 * step: anton stamps the PR ref on the target the moment `pr` returns, and a resumed run reads a live
 * ref as proof the run finished (execute-epic step 0a) — so a step placed after the PR that failed
 * would be skipped by the next attempt, which would settle the run `done` with that step never having
 * run. Requiring `pr` last is what makes the completion marker honest.
 *
 * Reported only when the PR is otherwise well placed: a `pr` before the commit is already named by
 * `pr-before-commit`, and a second `pr` step by `duplicate-required-step`. Repeating them here would
 * tell the operator to move the wrong step.
 */
const refuseStepsAfterPr: FloorCheck = ({ steps, indexOf }) => {
  const commitAt = indexOf(COMMIT_STEP);
  const prAt = indexOf(PR_STEP);
  if (prAt < 0 || (commitAt >= 0 && commitAt > prAt)) return [];

  return steps
    .slice(prAt + 1)
    .filter(({ definition }) => definition?.name !== PR_STEP)
    .map(({ step }) => ({
      kind: "step-after-pr" as const,
      step: step.id,
      detail:
        `step "${step.id}" runs after "${steps[prAt].step.id}" opens the run's pull request — ` +
        `the PR ref anton stamps there is what a resumed run reads as proof the run FINISHED, so a ` +
        `step that failed after it would be silently skipped on the next attempt and the run would ` +
        `settle as done anyway. The floor requires \`${STEP_LABEL_PREFIX}:${PR_STEP}\` to be the ` +
        `pipeline's LAST step — move this one before it`,
    }));
};

/**
 * Refuses a self-review placed before the commit. The gate reads the run's COMMITTED diff
 * (`merge-base..HEAD`); before the commit that diff is empty, so the gate would review nothing, find
 * nothing, and report clean — a silent pass, which is worse than a rejected run. Rejected rather than
 * reordered for the operator: a formula that asks to review before it commits is asking for a gate
 * that cannot see the work.
 */
const refuseReviewBeforeCommit: FloorCheck = ({ steps, indexOf }) => {
  const commitAt = indexOf(COMMIT_STEP);
  const reviewAt = indexOf(REVIEW_STEP);
  if (reviewAt < 0 || commitAt < 0 || reviewAt > commitAt) return [];

  return [
    {
      kind: "review-before-commit",
      step: steps[reviewAt].step.id,
      detail:
        `step "${steps[reviewAt].step.id}" self-reviews before "${steps[commitAt].step.id}" ` +
        `commits — the gate reads the run's committed diff (\`merge-base..HEAD\`), which is empty ` +
        `until the commit lands, so it would review nothing and pass on nothing. The floor requires ` +
        `\`${STEP_LABEL_PREFIX}:${REVIEW_STEP}\` to run after \`${STEP_LABEL_PREFIX}:${COMMIT_STEP}\``,
    },
  ];
};

/** Refuses a step that writes to the worktree after the commit — its work would never be committed. */
const refuseDiffAfterCommit: FloorCheck = ({ steps, indexOf }) => {
  const commitAt = indexOf(COMMIT_STEP);
  if (commitAt < 0) return [];

  return steps.slice(commitAt + 1).flatMap(({ step, definition }): FloorViolation[] => {
    if (!definition?.producesDiff) return [];
    return [
      {
        kind: "diff-after-commit",
        step: step.id,
        detail:
          `step "${step.id}" (\`${STEP_LABEL_PREFIX}:${definition.name}\`) writes to the worktree but ` +
          `runs after "${steps[commitAt].step.id}" — its work would never be committed, so the run ` +
          `would report success on changes no one can see. Move it before the commit`,
      },
    ];
  });
};

/**
 * The floor, in reporting order: what a step IS before where it sits, so an operator reads the
 * unclassifiable step before the ordering faults derived from classes it does not have.
 */
const FLOOR_CHECKS: readonly FloorCheck[] = [
  refuseUnclassifiableSteps,
  refuseDuplicateStepIds,
  refuseRequiredStepNotDeclaredExactlyOnce,
  refusePrBeforeCommit,
  refuseStepsAfterPr,
  refuseReviewBeforeCommit,
  refuseDiffAfterCommit,
];

/**
 * Check a cooked formula against the floor. Pure — no filesystem, no bd, no run state — so the
 * whole table of rejections is unit-testable without execute-epic, and a caller may pass a registry
 * of its own. The registry is a required argument on purpose: the classes are what the floor is made
 * of, and a default would let a call site validate against something other than the steps anton can
 * actually run.
 *
 * Every check runs: the result is the FULL list of violations, so an operator fixes the file once
 * instead of a round trip per problem.
 */
export function checkFormulaFloor(cooked: CookedFormula, registry: StepRegistry): FloorCheckResult {
  const pipeline = classify(cooked, registry);
  const violations = FLOOR_CHECKS.flatMap((check) => check(pipeline, registry));

  return { ok: violations.length === 0, violations };
}

/** What the loader (anton-hrql) hands over: the cooked pipeline and the file it came from. */
export interface ValidatableFormula {
  cooked: CookedFormula;
  /** Absolute path the pipeline was read from — the file a rejection must name. */
  source: string;
}

/**
 * FAIL LOUD: park the run when the pipeline violates the floor, naming the file, every offending
 * step, and what the floor requires. Never a degraded run — anton has no safe way to walk a pipeline
 * that throws its own work away, so the operator fixes the file and resumes.
 */
export function assertRunFormulaFloor(
  formula: ValidatableFormula,
  registry: StepRegistry = BUILTIN_STEPS,
): void {
  const { ok, violations } = checkFormulaFloor(formula.cooked, registry);
  if (ok) return;
  throw new PoisonEpic(
    `run formula ${formula.source} violates anton's invariant floor:\n` +
      violations.map((v) => `  • ${v.detail}`).join("\n") +
      `\nThe floor is what anton guarantees about a run, not a style rule: it must implement, commit, ` +
      `and open a PR, in that order, with everything that writes to the worktree happening before the ` +
      `commit, the self-review (when present) between the commit and the PR, and the PR opening LAST. ` +
      `A project may ADD steps freely — the floor constrains omission and ordering, never ` +
      `extension. Fix ${formula.source} (or delete it to fall back to anton's default), then resume ` +
      `the run.`,
  );
}
