/**
 * Where a run's pipeline splits (anton-lnkt — extracted from execute-epic.ts in anton-1lix): the
 * steps a TICKET walks, and the steps the RUN walks once for all of them.
 */
import { PoisonEpic } from "./errors";
import type { ResolvedStep } from "./run-formula";

/** The step that turns work into evidence — and, for that reason, the walk's phase boundary. */
const COMMIT_STEP_NAME = "commit";

/** The formula split into the two phases a run walks (anton-lnkt). */
export interface FormulaPhases {
  /** Through the commit: dispatched once PER TICKET, in that ticket's own session. */
  ticketSteps: ResolvedStep[];
  /** After the commit: dispatched ONCE for the whole run, over every ticket that contributed. */
  runSteps: ResolvedStep[];
}

/**
 * Split the pipeline at its commit (anton-lnkt).
 *
 * The commit is where a ticket's work becomes git evidence — an epic's children close as they
 * commit, and `worktreeHasCommitFor` reads that commit to decide whether a ticket re-runs — so it is
 * also the line between what belongs to a TICKET and what belongs to the RUN. Everything that writes
 * to the worktree must precede it (the floor, anton-6b99, enforces exactly that), so the steps
 * before it are per-ticket work; the steps after it read the run's whole diff and open its single
 * PR, so they run once. Reordering the file moves that line — which is the point: a project that
 * moves its verify gates after the commit gets one run-wide verification instead of one per ticket,
 * with no anton code change.
 *
 * The floor guarantees exactly one `step:commit`, so this is a FAIL-LOUD assertion, not a fallback.
 */
export function splitFormulaPhases(formula: { source: string; steps: ResolvedStep[] }): FormulaPhases {
  const at = formula.steps.findIndex((s) => s.definition.name === COMMIT_STEP_NAME);
  if (at < 0) {
    throw new PoisonEpic(
      `run formula ${formula.source} declares no \`step:${COMMIT_STEP_NAME}\` — a run that never ` +
        `commits leaves no evidence of record, so anton has nothing to walk`,
    );
  }
  return { ticketSteps: formula.steps.slice(0, at + 1), runSteps: formula.steps.slice(at + 1) };
}
