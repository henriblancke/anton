/**
 * The run target's merge wait (anton-k0kj — extracted from execute-epic.ts in anton-1lix). Past the
 * PR step the only thing left to learn is whether that PR merges, and a `gh:pr` gate is how anton
 * makes that board state rather than a polling sweep.
 */
import { beads, type Bead, type Gate } from "../beads/bd";
import { prNumberFromRef } from "../git/pr";
import { safe } from "./execute-epic-persist";

// ── merge wait (anton-k0kj) ──

/**
 * How long a merge wait may go unanswered before it stops being a wait and becomes a stall. Nothing
 * in bd acts on it — a `gh:pr` gate resolves on MERGE and on nothing else, and the `timer` scope
 * does not even enumerate a gh gate that carries a timeout (measured on bd 1.1.0 and 1.1.2) — so
 * this is purely the deadline gate-check's expiry pass reads to surface the wait for a human ONCE.
 * Generous on purpose: a week of review is slow, not broken, and the note costs one glance.
 * Go duration syntax, which has no `d` unit.
 */
const MERGE_GATE_TIMEOUT = "168h";

/**
 * Arm the run target's merge wait: a `gh:pr` gate on THIS PR number, so "waiting for merge" is board
 * state that `bd gate check` settles project-wide in one call, instead of a sweep that re-reads every
 * open PR to discover a merge (anton-k0kj). gate-check closes the gate when the PR merges and hands
 * the target to review-fix, whose merge-finalize behaviour is unchanged.
 *
 * Two cases the arm has to get right, both on the recovery path:
 *
 *   • ALREADY ARMED for this same PR (a re-run that reused the open PR) — create nothing. Re-creating
 *     would leave two gates racing to close the same wait. Every OTHER open merge gate on the target
 *     is still resolved first, so a stale one left behind by a failed resolve doesn't survive.
 *   • ARMED FOR A DIFFERENT PR — this target's previous PR was closed without merging and this run
 *     re-opened it under a new number. bd leaves that gate open FOREVER (a closed-unmerged PR
 *     escalates, it never resolves), so it must be resolved here or it lingers as a dead wait that
 *     gate-check would later surface as a stall against a PR nobody is waiting on.
 *
 * `board` is the run's own snapshot; gate beads reach it via loadAllIssues. A snapshot too old to
 * carry a gate just means a duplicate gate on the same PR number — both resolve on the same merge.
 *
 * A legacy `epic` run target gets NO gate: bd refuses the edge outright ("epics can only block other
 * epics, not tasks" — a gate bead is not an epic), and a failed `gate create` still leaves the gate
 * bead behind, blocking nothing. So the case is refused here rather than attempted: that target keeps
 * learning about its merge from the review-fix sweep, exactly as before. Features and standalone
 * task/bug targets — every run target the tier split produces — take the gate.
 */
/**
 * What arming this target's merge wait has to do, from the board alone: every open merge gate that
 * awaits a DIFFERENT PR (`stale`), and whether this PR's own wait still has to be created.
 *
 * ALL the stale gates, not the first: a `gateResolve` that failed on an earlier run leaves a
 * superseded gate open ALONGSIDE the replacement, and dependency order says nothing about which is
 * seen first. Stopping at the current PR's gate would strand the other as a dead wait that
 * gate-check later surfaces as a stall against a PR nobody is waiting on.
 */
export function mergeGatePlan(
  board: Bead[],
  targetId: string,
  awaitId: string,
): { stale: Gate[]; create: boolean } {
  const byId = new Map(board.map((b) => [b.id, b]));
  const armed = (board.find((b) => b.id === targetId)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => byId.get(d.depends_on_id))
    .filter((b): b is Gate => b !== undefined && b.status !== "closed" && beads.isMergeWaitGate(b));
  return {
    stale: armed.filter((g) => g.await_id !== awaitId),
    create: !armed.some((g) => g.await_id === awaitId),
  };
}

export async function armMergeGate(
  repo: string,
  targetId: string,
  prRef: string,
  board: Bead[],
): Promise<void> {
  const number = prNumberFromRef(prRef);
  if (number === undefined) return; // not a PR pointer (a tracker ref) — nothing to wait on
  const target = board.find((b) => b.id === targetId);
  if (target && beads.isEpic(target)) {
    console.log(
      `[execute-epic] ${targetId} is an epic — bd refuses a gate edge onto one, so its merge stays ` +
        `on the review-fix sweep (no gh:pr gate armed for PR #${number})`,
    );
    return;
  }
  const awaitId = String(number);

  const { stale, create } = mergeGatePlan(board, targetId, awaitId);

  for (const gate of stale) {
    const resolved = await safe(() =>
      beads.gateResolve(
        repo,
        gate.id,
        `PR #${gate.await_id} is no longer ${targetId}'s pull request — superseded by #${awaitId}`,
      ),
    );
    // A stale gate bd never auto-resolves (a closed-unmerged PR escalates forever) is a permanent
    // artifact if this write is lost — say so rather than leaving a dead wait to be surfaced later
    // against a PR nobody is waiting on.
    if (!resolved) {
      console.warn(
        `[execute-epic] could not resolve ${targetId}'s superseded merge gate ${gate.id} ` +
          `(PR #${gate.await_id}) — it stays open alongside the gate for #${awaitId}`,
      );
    }
  }
  if (!create) return; // the wait for this PR already exists — a second gate would race it

  await beads.gateCreate(repo, {
    blocks: targetId,
    type: "gh:pr",
    awaitId,
    timeout: MERGE_GATE_TIMEOUT,
    reason: `${targetId} is in review — waiting for PR #${awaitId} to merge`,
  });
}
