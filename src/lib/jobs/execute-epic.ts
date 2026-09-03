/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then WALK THE PROJECT'S RUN
 * FORMULA (anton-lnkt) — its steps in execution order, one at a time, each dispatched through the
 * step registry (anton-4npr). The walk owns the ORDER; the guards around it are unchanged.
 *
 * The formula is split at its commit (`splitFormulaPhases`, execute-epic-formula.ts): the steps
 * up to it run per ticket
 * (dispatch → gates → commit → close), the steps after it run once for the whole run (self-review →
 * ONE PR via `gh` → in-review). The pipeline is validated and floor-checked before any worktree
 * exists, so a broken one parks rather than half-executing.
 *
 * Git stays the evidence of record — there is no second store of run progress: idempotent/resumable
 * because a re-run (crash, quota backoff) reuses the existing worktree and skips tickets already
 * closed WHOSE COMMIT is on this branch; a cross-machine resume re-runs a board-closed ticket whose
 * commit never got pushed. See DESIGN.md §4/§7.
 *
 * This file is the SEQUENCE only (anton-1lix). Each phase — begin, prepare, dispatch, run phase,
 * settle — owns its own module, and they pass one `EpicRun` between them; the try/catch/finally here
 * is what guarantees a stopped attempt hands back everything it took, in that order, on every path
 * out.
 */
import { dispatchRunTickets } from "./execute-epic-dispatch";
import { prepareEpicRun } from "./execute-epic-prepare";
import { walkRunPhase } from "./execute-epic-run-phase";
import { concludeRunAttempt, settleStoppedRun } from "./execute-epic-settle";
import { beginEpicRun } from "./execute-epic-start";
import type { AntonDb, Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ExecuteEpicDeps {
  db: AntonDb;
  clock?: Clock;
  /** Override the branch prefix (default "anton"). */
  branchPrefix?: string;
}

/** Build the runner handler bound to a db/clock. Register it as the "execute-epic" handler. */
export function makeExecuteEpicHandler(deps: ExecuteEpicDeps): JobHandler {
  return async function executeEpic(ctx: JobContext): Promise<void> {
    const run = await beginEpicRun({ ...deps, ctx });
    // An abandoned target: a human declared the work won't be done, and there is no run row to
    // settle. Nothing was taken, so nothing is owed back.
    if (!run) return;

    // The error this attempt throws, thrown AFTER the cleanup rather than from inside the catch, so
    // the cleanup's own kill window can still rewrite it. Undefined = nothing to throw.
    let settled: { thrown: unknown } | undefined;
    try {
      const prep = await prepareEpicRun(run);
      // `prep.done` is step 0a's answer that this target was already carried to a live pull request:
      // the row is settled and there is nothing left for this attempt to execute.
      if (!prep.done) {
        await walkRunPhase(run, prep, await dispatchRunTickets(run, prep));
      }
    } catch (raw) {
      settled = await settleStoppedRun(run, raw);
    } finally {
      const reconciled = await concludeRunAttempt(run);
      if (reconciled) settled = reconciled;
    }
    // Thrown here rather than from the catch so the cleanup — and the kill window inside it — runs
    // first: `settled.thrown` is the attempt's final word on what happened.
    if (settled) throw settled.thrown;
  };
}
