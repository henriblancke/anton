/**
 * APPLY: the board-picker starts its top-ranked target (R1.5-R1.7).
 *
 * The pass above this one decides and records; this is the only place it WRITES. It writes exactly
 * what a human approval writes, through the same code: `approved` plus the auto-claim, as one
 * operation under the bead's claim-write lock (`beads/approve-claim.ts`, shared with the approve
 * route), then an enqueue through `enqueueExecuteEpicIfAbsent` — the idempotent path unstick and
 * gate-check already use, so two overlapping passes leave exactly one run.
 *
 * ONE target per pass, the top of the ranking. The plan is a view of the board, never a queue of
 * events (gate-check.ts's rule, which this inherits): "listed" must not read as "start it", so the
 * pass takes the single pick its ranking is confident about and re-decides everything else from a
 * fresh board next cadence, when the brakes, the budget and the operator's vetoes have all had a
 * chance to move.
 *
 * Four things this deliberately does NOT do:
 *
 *   • It never takes a target a HUMAN holds. The plan already excludes claimed targets, and the
 *     guard re-asks under the lock — a claim landing in that window loses the target, not the claim.
 *   • It never writes `approved` speculatively. The label is contingent on the CAS, so a lost claim
 *     race leaves the bead exactly as it found it: unapproved, unclaimed, and startable by whoever
 *     won. Losing is a SKIP, never a retry — retrying into a race is how one target becomes two runs.
 *   • It never bypasses the budget. The enqueue asks for no `bypassBudget`, so a governed project
 *     paces a policy start exactly as it paces a queued one.
 *   • It never invents a claim protocol. The bead write-lock and the assignee CAS are the ones the
 *     approve route uses; on an embedded board the mirror they judge is refreshed first (see
 *     {@link refreshFor}) and the pass stands down when that refresh does not land.
 */
import { beads, LABELS } from "../beads/bd";
import { isServerMode } from "../beads/board-mode";
import { approveAndClaim } from "../beads/approve-claim";
import { setAssigneeIfOwner } from "../beads/claim";
import { nudgeSync } from "../beads/sync-nudge";
import type { PickerPlanEntry } from "../board-picker-plan";
import { resolveOperator } from "../operator";
import { ineligibility } from "./picker-targets";
import { enqueueExecuteEpicIfAbsent, type AntonDb, type Clock } from "./queue";

/**
 * The actor every unattended board write is attributed to (R1.7), matching `gardener/apply.ts`:
 * a start nobody watched is recorded as made by nobody, so a reader scanning `bd` history can tell
 * anton's own decisions from a founder's without opening anton at all.
 */
export const POLICY_ACTOR = "policy";

/** What one pass started: the pick, where it stood, and the run it enqueued. */
export interface PickerStart {
  beadId: string;
  rank: number;
  rule: string;
  jobId: string;
}

/**
 * One apply pass's outcome. A skip is a VALUE and carries its reason: a pass that starts nothing is
 * the common case (a moved board, a claim lost, a run already covering the target), and it has to be
 * readable in the log without being an error.
 */
export type PickerApplyOutcome =
  | { started: PickerStart }
  | { skipped: { beadId?: string; reason: string } };

/** Why the under-lock guard abandoned the start — see {@link applyPickerPlan}. */
type StartRefusal = { stale: string } | { ineligible: string };

export interface PickerApplyInput {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  /** The plan this pass decided, in rank order. Only its first entry is ever started. */
  entries: readonly PickerPlanEntry[];
}

/**
 * The bead note that records a start (R1.7) — one line, because beads stores notes as a single
 * newline-joined blob where each unindented line is its own entry.
 *
 * It names the RULE and the RANK because those are the two questions asked of an unattended start:
 * which of my criteria let this through, and why this one before the others. The last sentence is
 * the one the gardener's armed applies also carry — the answer to "who approved this" is nobody, and
 * the setting is what a reader has to change.
 */
export function pickerStartNote(entry: PickerPlanEntry, ranked: number): string {
  return (
    `anton: started by POLICY — rank ${entry.rank} of ${ranked}, admitted by ${entry.rule}. ` +
    `Nobody approved this: this project's picker autonomy is set to apply.`
  );
}

/**
 * Refresh the local mirror before the CAS, or refuse — the cross-machine half of the guard.
 *
 * The claim lock is keyed on `repoPath`, so it orders THIS machine only; across machines the guard
 * is the assignee CAS, and on an embedded board that CAS reads a per-machine mirror which trails the
 * shared remote by a sync heartbeat. A claim another machine published moments ago is invisible in
 * that window, and the only direction a stale mirror can be wrong is the one that double-approves.
 * So the pass pulls first and FAILS CLOSED when the pull does not land — the same treatment unstick
 * gives cross-machine run ownership.
 *
 * Undefined on a shared-server board: there is no mirror to refresh (the write is global the moment
 * it commits), and `bd dolt pull` would run against the server and fail.
 */
function refreshFor(repoPath: string): (() => Promise<StartRefusal | undefined>) | undefined {
  if (isServerMode(repoPath)) return undefined;
  return async () => {
    try {
      await beads.pull(repoPath);
      return undefined;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { stale: `the board could not be refreshed before claiming (${detail})` };
    }
  };
}

/**
 * Undo what THIS pass wrote when the enqueue never happened — the one failure that would otherwise
 * strand the target for good.
 *
 * An approved, self-claimed target with no run is invisible to the next pass (its own guard reads it
 * as claimed) and to a human (it looks like work already under way). So the writes come back off in
 * the reverse order they went on: the label first, because the label is what locks the reservation —
 * releasing the claim while it stood would publish the target to any worker looking for approved,
 * unclaimed work.
 *
 * `wroteLabel` is false when the target was ALREADY approved before this pass touched it (a human
 * approved it and never started it), and removing it there would erase somebody else's decision.
 * Best-effort: it is a repair, and one that fails leaves exactly the state we were already reporting.
 */
async function unwindStart(
  repoPath: string,
  beadId: string,
  owner: string | undefined,
  wrote: { label: boolean; claim: boolean },
): Promise<void> {
  if (wrote.label) {
    await beads
      .untag(repoPath, beadId, [LABELS.approved])
      .catch((e) => console.error(`[picker-apply] could not unapprove ${beadId}`, e));
  }
  if (wrote.claim) {
    await setAssigneeIfOwner(repoPath, beadId, owner, undefined).catch((e) =>
      console.error(`[picker-apply] could not release the claim on ${beadId}`, e),
    );
  }
}

/**
 * Start the plan's top-ranked target: approve it, claim it, enqueue its run, and record why.
 *
 * The caller owns the decision to CALL this — the armed level, the disarms, the WIP hold. What is
 * owned here is that the start is atomic, idempotent and reversible: no label without a claim, no
 * second run behind an overlapping pass, and nothing left half-written when the enqueue falls over.
 */
export async function applyPickerPlan(input: PickerApplyInput): Promise<PickerApplyOutcome> {
  const { db, clock, projectId, repoPath, entries } = input;
  const top = entries[0];
  if (!top) return { skipped: { reason: "the plan ranked nothing to start" } };

  // This machine's identity, exactly as the approve route resolves it: the assignee a run's ownership
  // gate reads. Undefined only when no identity resolves at all, where the CAS is a verified no-op —
  // the target is approved and left unclaimed, which is what the approve route does there too.
  const operator = await resolveOperator();

  // Set by the guard, off the board read the write is made against: whether the label is OURS to
  // take back if the enqueue then fails (see unwindStart).
  let wroteLabel = false;

  const swap = await approveAndClaim<StartRefusal>({
    repoPath,
    beadId: top.beadId,
    // The plan only ever carries UNCLAIMED targets, so this is the CAS's whole cross-machine guard:
    // anyone who claimed since the pass read the board wins here and we abandon the start.
    expectedOwner: undefined,
    nextOwner: operator,
    refresh: refreshFor(repoPath),
    guard: (locked, board) => {
      // Re-ask the pass's OWN eligibility rule under the lock, not a hand-rolled subset of it: a
      // target claimed, closed, abandoned, blocked, labelled `agent:human` or newly failing the
      // approve gate since the plan was decided must lose here rather than be started on a verdict
      // minutes old. It answers with the same machine-readable reason the plan's exclusions carry.
      const excluded = ineligibility(locked, board);
      if (excluded) {
        const why = excluded.detail ? `${excluded.reason} — ${excluded.detail}` : excluded.reason;
        return { ineligible: why };
      }
      wroteLabel = !beads.isApproved(locked);
      return undefined;
    },
  });

  if ("vanished" in swap) {
    const reason = "the target left the board before it started";
    return { skipped: { beadId: top.beadId, reason } };
  }
  if ("refused" in swap) {
    const reason = "stale" in swap.refused ? swap.refused.stale : swap.refused.ineligible;
    return { skipped: { beadId: top.beadId, reason } };
  }
  // Lost the claim race. Abandoned cleanly and NOT retried: the winner holds the target, nothing was
  // written here (the label is contingent on this swap), and the next pass re-decides from a board
  // that now shows their claim.
  if (!swap.ok) {
    const holder = swap.owner ?? "another worker";
    return { skipped: { beadId: top.beadId, reason: `${holder} claimed it first` } };
  }

  // The idempotent enqueue: a run already covering this epic locally withholds an id rather than
  // spawning a second, which is what makes two overlapping passes one run. No `bypassBudget` — a
  // policy start is paced by the governor exactly as a queued one is.
  let jobId: string | undefined;
  try {
    jobId = enqueueExecuteEpicIfAbsent(db, clock, projectId, top.beadId);
  } catch (e) {
    console.error(`[picker-apply] could not enqueue a run for ${top.beadId}`, e);
    await unwindStart(repoPath, top.beadId, operator, { label: wroteLabel, claim: swap.wrote });
    return { skipped: { beadId: top.beadId, reason: "the run could not be enqueued" } };
  }
  if (!jobId) {
    // A run already covers the epic here — an overlapping pass, or a resumable job from a previous
    // one. The approval and the claim stand (they are what that run needs); no second note is
    // written, because no second start happened.
    return { skipped: { beadId: top.beadId, reason: "a run already covers this target" } };
  }

  // The board-native record of the start, written as `policy` so bd's own history says who decided.
  // Best-effort: the run is already enqueued, and failing the pass over the audit line would leave a
  // started target reported as unstarted — the one lie the note exists to prevent.
  await beads
    .note(repoPath, top.beadId, pickerStartNote(top, entries.length), POLICY_ACTOR)
    .catch((e) => console.error(`[picker-apply] could not note the start of ${top.beadId}`, e));

  // Publish the approval and the claim, exactly as the approve route does after its own write.
  nudgeSync({ id: projectId, repoPath }, "picker-apply");

  return { started: { beadId: top.beadId, rank: top.rank, rule: top.rule, jobId } };
}
