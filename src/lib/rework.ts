/**
 * Rework: send a ticket back with instructions (anton-4ocm).
 *
 * A self-review scores every run, but until now acting on a bad score meant a hand-typed `bd note` +
 * `bd reopen` in a terminal — so the loop the score was supposed to close stayed open. This module
 * is that action, in one call, with the provenance the board needs to stay honest afterwards:
 *
 *   • REOPEN — the acceptance was never actually met. The same bead runs again, carrying the
 *     founder's instructions as a human note and a `--reason` on the reopen event. Its earlier
 *     rounds keep their scores, because they scored the work that was actually delivered then.
 *   • FOLLOW-UP — the acceptance WAS met and the founder wants another pass. A NEW bead carries the
 *     instructions, linked `discovered-from` the original, so the original's score stays attached to
 *     what it shipped instead of being re-earned by later work.
 *
 * The choice is the caller's and is never inferred: which of the two is right is a judgement about
 * whether the ticket lied about being done, and only a human reading the review can make it.
 *
 * Neither path means anything unless the target can RUN again, which is what the target's own pull
 * request decides (anton-leit) — see {@link planRework}.
 *
 * This file is the ORCHESTRATION, and the module's public surface. The judgement each step makes
 * lives beside it: what may be sent back (lib/rework-target.ts), what the PR allows and the retire
 * that acts on it (lib/rework-pipeline.ts), the two modes (lib/rework-modes.ts), the words they
 * write (lib/rework-notes.ts), and the request contract the route shares (lib/rework-contract.ts).
 */
import { withBeadWriteLocks } from "./beads/claim-lock";
import { nudgeSync } from "./beads/sync-nudge";
import type { Bead } from "./beads/bd";
import {
  validateReworkInput,
  type ReworkInput,
  type ReworkRequest,
} from "./rework-contract";
import {
  applyFollowUp,
  applyReopen,
  type AppliedRework,
} from "./rework-modes";
import {
  assertRetireStood,
  planRework,
  retireFinishedRun,
  retireWrote,
  snapshotBeforeWrites,
  type ReworkPlan,
  type RetireResult,
} from "./rework-pipeline";
import { resolveReworkScope } from "./rework-target";
import type { Project, ReworkPipeline, ReworkResult } from "./types";

export {
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
  ReworkUnavailableError,
} from "./rework-contract";
export type { ReworkInput } from "./rework-contract";
export { reworkNoteBody } from "./rework-notes";

/**
 * Apply a rework to one ticket of a run target.
 *
 * Idempotent by construction rather than by token: a repeat of the same request finds its own note
 * already on a bead already in the state it wanted (reopen) or its own follow-up already linked
 * (follow-up) and writes nothing, so a double-click leaves one note and one bead. Every check and
 * its write are serialized on the ticket's AND the target's write locks, which is what makes that
 * hold for two requests in flight at once.
 */
export async function reworkTicket(
  project: Project,
  targetId: string,
  input: ReworkInput,
): Promise<ReworkResult> {
  const request = validateReworkInput(input);
  const { all, target, ticket } = await resolveReworkScope(project, targetId, request.ticketId);
  // What the target's own pull request allows, decided BEFORE any write: it can override the mode.
  const plan = await planRework(project.repoPath, target, ticket, all, request.mode);

  // Both beads' write locks, taken together in sorted order (withBeadWriteLocks): the mode's writes
  // land on the ticket while the pipeline reset lands on the TARGET, and the reset is only correct
  // against a target nothing else is moving. Deduped for a standalone target, where the ticket IS
  // the target.
  const applied = await withBeadWriteLocks(project.repoPath, [ticket.id, target.id], () =>
    applyUnderLocks(project, target, ticket, request, plan),
  );

  // Fire-and-forget, like every other board write behind a route: the writes already landed locally
  // and the run reads local state, so don't block the response on a slow/unreachable remote. Nudged
  // before the throw below, because a rolled-back retire is still a write another machine has to see.
  if (wroteToBoard(applied)) nudgeSync(project, "rework");
  assertRetireStood(applied.retire, {
    targetId: target.id,
    ticketId: ticket.id,
    reworkedId: applied.result.reworkedId,
    rollsBackTicket: plan.rollsBackTicket,
  });
  return reworkResult(applied, plan.pipeline);
}

/** An applied rework and what became of the target's finished-run marker — the whole locked section. */
type AppliedUnderLocks = AppliedRework & { retire: RetireResult };

/**
 * Everything that writes, under both beads' locks: the pre-write snapshot the rollback restores, the
 * mode itself, and the pipeline reset the send-back only earns by landing where this target's run
 * will dispatch it.
 */
async function applyUnderLocks(
  project: Project,
  target: Bead,
  ticket: Bead,
  request: ReworkRequest,
  plan: ReworkPlan,
): Promise<AppliedUnderLocks> {
  const before =
    plan.pipeline?.outcome === "retired"
      ? await snapshotBeforeWrites(project.repoPath, target, ticket, plan.rollsBackTicket)
      : undefined;
  const applied = await applyMode(project, target, ticket, request, plan);
  // Only retire when the instructions landed on a bead THIS target's run will dispatch: a parentless
  // follow-up is its own run target, so clearing the target's ref and `stage:in-review` would strip
  // the merge gate off a PR that is still open — and hand the claimer a target whose work is already
  // on the branch — to unblock a run that was never going to carry the fix. Attempted even on a
  // no-op double submit: the first request may have written the note and died before the reset, and
  // a repeat that reported "already sent back" over a still short-circuiting target would be the
  // very false green this exists to remove. Idempotent — a target whose ref is already gone has
  // nothing left to retire.
  const retire: RetireResult =
    before && applied.runsUnderTarget
      ? await retireFinishedRun(project, before.target, before.ticket)
      : { outcome: "not-attempted" };
  return { ...applied, retire };
}

/** The founder's mode, as the target's PR may have redirected it ({@link planRework}). */
function applyMode(
  project: Project,
  target: Bead,
  ticket: Bead,
  request: ReworkRequest,
  plan: ReworkPlan,
): Promise<AppliedRework> {
  return plan.mode === "reopen"
    ? applyReopen(project, target, ticket, request)
    : applyFollowUp(project, target, ticket, request, plan.pipeline);
}

/**
 * Did this request touch the board at all? The mode's own write, the reconcile that moves a bead on a
 * request that is otherwise a no-op, and the retire — which can land on the repeat that finished a
 * half-applied send-back, whose mode step wrote nothing.
 */
function wroteToBoard(applied: AppliedUnderLocks): boolean {
  return applied.result.applied || applied.reconciled === true || retireWrote(applied.retire);
}

/**
 * `retired` is a claim about a write, so it is reported only where that write was the plan. A
 * follow-up that runs as its own target had nothing standing in its way, and saying "run it again"
 * over an untouched target would point the founder at a run that short-circuits.
 */
function reworkResult(applied: AppliedUnderLocks, pipeline?: ReworkPipeline): ReworkResult {
  const reported =
    pipeline?.outcome === "retired" && !applied.runsUnderTarget ? undefined : pipeline;
  return { ...applied.result, ...(reported ? { pipeline: reported } : {}) };
}
