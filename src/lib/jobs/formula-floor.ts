/**
 * anton's invariant floor (anton-6b99): the only thing a project pipeline may NOT do.
 *
 * The run formula is project-owned (anton-hrql) — that is the point, and it is only safe because
 * there is a floor underneath it. anton owns the run's guarantees (one run target = one worktree =
 * one PR, git as the evidence of record, park-on-failure); the project owns the steps. So the floor
 * constrains OMISSION and ORDER, never extension: a formula may add as many steps as it likes, but
 * it may not define a run that never implements, never commits, or never reaches a human — and it
 * may not order the steps so that the work it does is thrown away.
 *
 * This module is pure. It takes a cooked formula plus the step registry (anton-4npr, which DECLARES
 * the classes and which steps write to the worktree) and returns the full list of violations —
 * never one, and never a throw, so an operator fixes the file once instead of a round trip per
 * problem. {@link assertRunFormulaFloor} is the thin FAIL-LOUD wrapper execute-epic calls at run
 * start, before the lease is published and before a worktree exists.
 *
 * Order here means DECLARATION order, because that is what the walker executes: the loader hands
 * back `cooked.steps` in file order and the walk follows it.
 */
import type { CookedFormula, CookedStep } from "../beads/bd";
import { PoisonEpic } from "./errors";
import {
  BUILTIN_STEPS,
  STEP_LABEL_PREFIX,
  stepName,
  type StepDefinition,
} from "./step-registry";

/** The step registry as the validator reads it: `step:<name>` suffix → its definition. */
export type StepRegistry = Readonly<Record<string, StepDefinition>>;

/**
 * The two ordering invariants name specific steps rather than classes: git is the run's evidence of
 * record (`commit`) and the PR is the only way the work reaches a human (`pr`). They live here, not
 * in the registry, because the ORDER is anton's invariant — the registry only declares what a step
 * is and whether it writes to the worktree.
 */
const COMMIT_STEP = "commit";
const PR_STEP = "pr";

export type FloorViolationKind =
  | "unresolved-step"
  | "duplicate-step-id"
  | "missing-required-step"
  | "duplicate-required-step"
  | "pr-before-commit"
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

/**
 * Check a cooked formula against the floor. Pure — no filesystem, no bd, no run state — so the
 * whole table of rejections is unit-testable without execute-epic, and a caller may pass a registry
 * of its own. The registry is a required argument on purpose: the classes are what the floor is made
 * of, and a default would let a call site validate against something other than the steps anton can
 * actually run.
 */
export function checkFormulaFloor(cooked: CookedFormula, registry: StepRegistry): FloorCheckResult {
  const steps = cooked.steps ?? [];
  const classified: Classified[] = steps.map((step) => {
    const name = stepName(step);
    return { step, definition: name ? registry[name] : undefined };
  });
  const violations: FloorViolation[] = [];

  // Resolution first: an unresolved step has no class and no diff behaviour, so every later check
  // would have to guess what it is. Collected rather than thrown — the loader (anton-hrql) already
  // parks on this with a fuller message; here it only has to keep the floor's own report honest.
  for (const { step, definition } of classified) {
    if (definition) continue;
    const name = stepName(step);
    violations.push({
      kind: "unresolved-step",
      step: step.id,
      detail: name
        ? `step "${step.id}" names \`${STEP_LABEL_PREFIX}:${name}\`, which maps to no anton handler — ` +
          `anton cannot tell whether it satisfies the floor, so the run is parked rather than skipping it`
        : `step "${step.id}" carries no \`${STEP_LABEL_PREFIX}:<name>\` label, so anton cannot tell what ` +
          `it should run`,
    });
  }

  const timesById = new Map<string, number>();
  for (const { step } of classified) timesById.set(step.id, (timesById.get(step.id) ?? 0) + 1);
  for (const [id, times] of timesById) {
    if (times < 2) continue;
    violations.push({
      kind: "duplicate-step-id",
      step: id,
      detail:
        `step id "${id}" is declared ${times} times — ids are how \`needs\` addresses a step and how ` +
        `the run log names one, so a repeated id makes the pipeline ambiguous`,
    });
  }

  // Presence and singularity of the required steps, read from the registry's classes rather than a
  // list held here — adding a required step is then a one-line registry change, not two.
  for (const definition of Object.values(registry)) {
    if (definition.class !== "required") continue;
    const found = classified.filter((c) => c.definition?.name === definition.name);
    if (found.length === 0) {
      violations.push({
        kind: "missing-required-step",
        step: `${STEP_LABEL_PREFIX}:${definition.name}`,
        detail:
          `no step is labelled \`${STEP_LABEL_PREFIX}:${definition.name}\` — the floor requires one, to ` +
          `${definition.summary}. A run without it has no evidence of record or no way to reach a human`,
      });
    } else if (found.length > 1) {
      violations.push({
        kind: "duplicate-required-step",
        step: found.map((f) => f.step.id).join(", "),
        detail:
          `\`${STEP_LABEL_PREFIX}:${definition.name}\` is declared ${found.length} times ` +
          `(${found.map((f) => `"${f.step.id}"`).join(", ")}) — a run is one worktree, one commit point ` +
          `and one PR, so each required step runs exactly once`,
      });
    }
  }

  const indexOf = (name: string) => classified.findIndex((c) => c.definition?.name === name);
  const commitAt = indexOf(COMMIT_STEP);
  const prAt = indexOf(PR_STEP);

  if (commitAt >= 0 && prAt >= 0 && prAt < commitAt) {
    violations.push({
      kind: "pr-before-commit",
      step: classified[prAt].step.id,
      detail:
        `step "${classified[prAt].step.id}" opens the PR before "${classified[commitAt].step.id}" ` +
        `commits — the PR would be opened on a branch carrying none of the run's work, and the commit ` +
        `that followed would land where no reviewer is looking. The floor requires \`` +
        `${STEP_LABEL_PREFIX}:${COMMIT_STEP}\` to precede \`${STEP_LABEL_PREFIX}:${PR_STEP}\``,
    });
  }

  if (commitAt >= 0) {
    for (const [i, { step, definition }] of classified.entries()) {
      if (i <= commitAt || !definition?.producesDiff) continue;
      violations.push({
        kind: "diff-after-commit",
        step: step.id,
        detail:
          `step "${step.id}" (\`${STEP_LABEL_PREFIX}:${definition.name}\`) writes to the worktree but ` +
          `runs after "${classified[commitAt].step.id}" — its work would never be committed, so the run ` +
          `would report success on changes no one can see. Move it before the commit`,
      });
    }
  }

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
      `commit. A project may ADD steps freely — the floor constrains omission and ordering, never ` +
      `extension. Fix ${formula.source} (or delete it to fall back to anton's default), then resume ` +
      `the run.`,
  );
}
