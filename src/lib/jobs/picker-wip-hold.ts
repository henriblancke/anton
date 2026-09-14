/**
 * The WIP hold's I/O end (anton-wy9y / R4.2): count the PRs already waiting on the operator, and
 * hold the picker while that queue is full.
 *
 * Split the way picker-score-breaker.ts is split from autopilot-score-slide.ts — the rules are pure
 * and everything that needs a db, a repo or `gh` lives here. What this module owns is the one join
 * the pure rules cannot make: **which in-review target still has an unmerged PR**.
 *
 * The candidates come off the board the pass ALREADY read — a `stage:in-review` run target carrying
 * a PR ref — which is why the count is derived rather than counted into a column somewhere. A
 * counter drifts the first time a run dies between opening a PR and recording it; the board cannot,
 * because the ref is what every other in-review surface reads too.
 *
 * The board alone is not enough for the CLOSE half of the release, though. A merged PR retires its
 * bead on its own (review-fix's `finalizeMergedEpic`), so it leaves the count without help — but a
 * PR closed WITHOUT merging is deliberately left untouched, ref and stage and all, so a recovery
 * re-run can find it. Read off the board only, that PR would hold the picker forever. So each
 * candidate's state is confirmed with the same cheap read the run-health sweep uses
 * (`getPrActivity`), and MERGED/CLOSED drop out.
 *
 * Those reads are paid for ONLY when the board already shows the limit's worth of in-review
 * targets. Under the limit no confirmation could produce a hold, so the common case — a project
 * whose operator is keeping up — costs zero `gh` spawns and the ten-minute cadence stays free. And
 * OVER the limit they are bounded and stop at the limit (see {@link confirmSlots}), so the backlog
 * this brake exists for cannot turn each pass into one `gh` process per waiting PR.
 */
import { readAllIssues } from "../beads/issues";
import type { Bead } from "../beads/types";
import type { AutopilotHold } from "../autopilot-breaker";
import { detectWipHold, toAutopilotHold, type ReviewSlot, type WipHold } from "../autopilot-wip";
import { getDb } from "../db";
import { getPrActivity, type PrActivity } from "../git/pr";
import { getProjectSettings, resolveWipLimit } from "../projects";
import type { Project } from "../types";
import { inReviewTargets } from "./run-health";
import type { AntonDb } from "./queue";

/** How a caller supplies PR state. Injectable so tests (and any future forge) need no `gh`. */
export type ReadPrActivity = (
  repo: string,
  number: number,
  signal?: AbortSignal,
) => Promise<PrActivity>;

export interface WipHoldInput {
  projectId: string;
  /** Where `gh` runs — the project's repo, as run-health passes it. */
  repoPath: string;
  /** The board the pass just read — where the in-review targets are, at no extra `bd` call. */
  board: Bead[];
  signal?: AbortSignal;
  readPrActivity?: ReadPrActivity;
}

/**
 * Has this PR LEFT the operator's queue? Only a merge or a close does that; everything else —
 * including a state `gh` reported in some shape this does not know — is still work waiting on a
 * human.
 */
function stillInReview(state: string): boolean {
  return state !== "MERGED" && state !== "CLOSED";
}

/**
 * Confirm one candidate still occupies the queue.
 *
 * An unreadable PR COUNTS. The bead's own `stage:in-review` plus its PR ref is the board's standing
 * claim that this work is waiting on a review, and `gh` is consulted only to retire that claim
 * early — so when `gh` cannot answer (no auth, no network, a rate limit) the right answer is the
 * one the board already gave. Failing the other way would let a flaky `gh` quietly lift the
 * operator's own flow limit, which is the exact outcome the brake exists to prevent.
 */
async function occupiesQueue(
  read: ReadPrActivity,
  input: WipHoldInput,
  prNumber: number,
): Promise<boolean> {
  try {
    return stillInReview((await read(input.repoPath, prNumber, input.signal)).state);
  } catch {
    return true;
  }
}

/**
 * How many PR reads may be in flight at once. Every one is a `gh pr view` PROCESS with a two-minute
 * ceiling of its own, and the project that reaches this code is by definition the one with the
 * biggest in-review backlog — so confirming a fourteen-PR queue all at once would answer a flow
 * problem with a process burst against GitHub's rate limit, on every pass and every board load.
 * Wide enough that the ordinary case (a queue at the limit) is still a single round trip.
 */
const PR_READ_CONCURRENCY = 4;

/**
 * Confirm candidates until `limit` of them are known to still occupy the queue.
 *
 * Bounded AND short-circuited: past the limit the answer cannot change — a hold is a hold whether
 * five or fifty PRs are waiting — so a backlog costs the same handful of reads a full queue does.
 * The batch that reaches the limit is finished rather than abandoned, so an over-limit queue can
 * still report more slots than the limit, which `describeWipHold` is worded for.
 *
 * `truncated` is the price of that bound: candidates left unread are PRs that may well still be
 * waiting, so the slots are a lower bound on the queue and the hold has to be described as one.
 */
async function confirmSlots(
  read: ReadPrActivity,
  input: WipHoldInput,
  candidates: readonly { bead: Bead; prNumber: number }[],
  limit: number,
): Promise<{ slots: ReviewSlot[]; retired: ReviewSlot[]; truncated: boolean }> {
  const slots: ReviewSlot[] = [];
  const retired: ReviewSlot[] = [];
  let confirmed = 0;
  for (let i = 0; i < candidates.length && slots.length < limit; i += PR_READ_CONCURRENCY) {
    const batch = await Promise.all(
      candidates
        .slice(i, i + PR_READ_CONCURRENCY)
        .map(async ({ bead, prNumber }) => ({
          slot: { beadId: bead.id, prNumber },
          occupied: await occupiesQueue(read, input, prNumber),
        })),
    );
    confirmed = Math.min(i + PR_READ_CONCURRENCY, candidates.length);
    for (const { slot, occupied } of batch) (occupied ? slots : retired).push(slot);
  }
  return { slots, retired, truncated: confirmed < candidates.length };
}

/** What one confirmation found: the hold it produced, and the slots it took OFF the board's count. */
export interface WipQueueVerdict {
  /** The hold, or absent while there is still review bandwidth. */
  hold?: WipHold;
  /**
   * In-review targets the board still lists whose PR this confirmation found merged or CLOSED, so
   * they did not count (PR #218 review).
   *
   * The one input to a CLEARING verdict that no later board read can re-check. A merged PR retires
   * its bead, but a closed one is deliberately left on the board ref and stage and all — so
   * reopening it refills a review slot without moving a single bead, and a caller reconciling its
   * verdict against a fresh board would see no drift at all. Carried out so that caller can
   * reconcile these the only way they can be: against another confirmation.
   */
  retired: ReviewSlot[];
}

/**
 * The project's WIP hold and what the confirmation retired to reach it.
 *
 * Nothing is written and nothing is latched: re-asking on the next pass re-derives the answer from
 * whatever the board and GitHub say then, which is what makes the release automatic.
 */
export async function confirmWipQueue(
  db: AntonDb,
  input: WipHoldInput,
): Promise<WipQueueVerdict> {
  const config = resolveWipLimit(await getProjectSettings(db, input.projectId));
  if (!config) return { retired: [] };

  const candidates = inReviewTargets(input.board);
  // Under the limit even before any PR is confirmed merged: confirming can only SHRINK the count,
  // so there is no hold to find and no reason to spawn `gh` at all — and nothing is retired, because
  // nothing was read.
  if (candidates.length < config.limit) return { retired: [] };

  const read = input.readPrActivity ?? getPrActivity;
  const { slots, retired, truncated } = await confirmSlots(read, input, candidates, config.limit);
  const hold = detectWipHold(slots, config, truncated);
  return { ...(hold ? { hold } : {}), retired };
}

/**
 * The project's WIP hold, or `undefined` when there is still review bandwidth (and when the
 * operator has turned the hold off with a limit of 0) — {@link confirmWipQueue} for callers that
 * only need the verdict.
 */
export async function checkWipLimit(
  db: AntonDb,
  input: WipHoldInput,
): Promise<WipHold | undefined> {
  return (await confirmWipQueue(db, input)).hold;
}

/**
 * How long a PAGE's read may wait on `gh`. A pass has all the time gh gives it (two minutes per
 * spawn); a render does not — an unreachable GitHub would otherwise leave a subprocess hanging for
 * that whole window on every board load. Timing out counts the PR as still in review, exactly as
 * any other unreadable answer does (see {@link occupiesQueue}), so the fast answer is the safe one.
 */
const UI_PR_READ_TIMEOUT_MS = 5_000;

/**
 * The hold as a surface shows it, over the shared anton.db and the cached board snapshot — the read
 * path for the lane header, mirroring `currentDisarm`.
 *
 * The snapshot is the one the page just rendered from, so this costs no `bd` spawn; and under the
 * limit it costs no `gh` spawn either (see {@link checkWipLimit}).
 */
export async function currentWipHold(project: Project): Promise<AutopilotHold | undefined> {
  const { beads: board } = await readAllIssues(project.repoPath);
  const hold = await checkWipLimit(getDb(), {
    projectId: project.id,
    repoPath: project.repoPath,
    board,
    signal: AbortSignal.timeout(UI_PR_READ_TIMEOUT_MS),
  });
  return hold ? toAutopilotHold(hold) : undefined;
}
