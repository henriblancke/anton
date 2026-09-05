/**
 * The four RE-CHECKS an apply pass re-asks between its entry gate and its enqueue (PR #218 review).
 *
 * The caller reads the stance, the disarm and the WIP hold once, before the ranking; what follows is
 * a mirror refresh, a board read, the CAS, the settle window and the flow brake's own `gh` reads —
 * long enough for any of them to move. Each is a seam here rather than a direct read so the
 * scheduled pass can hand down its injected `gh` reader and a test can move the answer INSIDE the
 * window rather than around it.
 *
 * They answer in one shape — the reason the start must not happen, or nothing — because to the pass
 * "the policy stopped admitting it", "the project was frozen" and "the review queue filled up" are
 * one question asked of three sources.
 */
import { activeDisarm } from "../autopilot-disarm";
import { describeWipHold } from "../autopilot-wip";
import { loadAllIssues } from "../beads/issues";
import type { Bead } from "../beads/types";
import { pickerTrackRecord } from "../picker-veto";
import {
  getProjectSettings,
  resolvePickerAutonomy,
  resolvePickerPolicy,
  resolveWipLimit,
} from "../projects";
import { armedPickerPolicy } from "./picker-policy";
import { confirmWipQueue, type ReadPrActivity } from "./picker-wip-hold";
import type { AntonDb } from "./queue";

/**
 * Is the operator's standing approval STILL what this start rests on? Answers with the reason it is
 * not, or undefined while it holds — the same shape as the board's own exclusions, because to a
 * reader "the policy stopped admitting it" and "the target stopped being startable" are one question
 * asked of two sources.
 */
export type PickerStanceCheck = (target: Bead, board: Bead[]) => Promise<string | undefined>;

/**
 * Is the project FROZEN right now? Answers with the reason it is, or undefined while it is armed —
 * the same shape as {@link PickerStanceCheck}, because to the pass they are one question ("may this
 * start still happen?") asked of two tables.
 */
export type PickerDisarmCheck = () => Promise<string | undefined>;

/**
 * What the flow brake answered: the hold's own copy while the queue is full, and the slots the
 * verdict took off the board's count to reach it (PR #218 review).
 *
 * The other two brakes answer with a bare reason; this one cannot, because a CLEARING verdict of its
 * own rests on PR states no later board read can re-check. See {@link WipQueueVerdict}.
 */
export interface PickerHoldVerdict {
  hold?: string;
  /** The retired slots, keyed as {@link slotKey} — empty whenever the verdict read no PR at all. */
  retired?: readonly string[];
}

/**
 * Is the operator's review queue full right now? Answers with the hold's own copy, or nothing while
 * there is bandwidth — the third of the three brakes, asked in the same shape as the other two.
 * Takes the board to judge, so a caller holding a fresh one spends no second `bd list`.
 */
export type PickerHoldCheck = (board?: Bead[]) => Promise<PickerHoldVerdict>;

/**
 * Re-resolve the picker's stance and judge the target against it (PR #218 review).
 *
 * `ineligibility` re-asks the BOARD's question under the lock and again after the settle; this asks
 * the SETTINGS one, which nothing else re-asks. The stance the pass is acting on was read once,
 * before the ranking, and everything since is a board read, a CAS, a settle window and the WIP
 * check's `gh` reads — long enough for the operator to withdraw the very approval the start stands
 * on. Removing the work policy,
 * narrowing it past this target, relabelling the target out of it, or moving the picker off `apply`
 * are all the same act: the standing approval is gone, and a start made on the old one is
 * unattended work nobody currently sanctions.
 *
 * Resolved through `resolvePickerAutonomy`/`resolvePickerPolicy` rather than by re-reading the
 * stored fields, so both floors — the armed policy and the EARNED record — bite here exactly as they
 * do where the pass first decided to call the apply at all.
 */
export function pickerStance(db: AntonDb, projectId: string): PickerStanceCheck {
  return async (target, board) => {
    // Two independent reads, and this closure runs three times per apply — under the claim lock,
    // after the settle, and again at the final gate — so they go in parallel rather than costing a
    // round trip each on the critical path.
    const [settings, record] = await Promise.all([
      getProjectSettings(db, projectId),
      pickerTrackRecord(db, projectId),
    ]);
    const autonomy = resolvePickerAutonomy(settings, record);
    if (autonomy !== "apply") {
      return `this project's picker autonomy is no longer apply (now ${autonomy})`;
    }
    const armed = resolvePickerPolicy(settings);
    // Unreachable while `resolvePickerAutonomy` floors an unarmed project to `shadow`; kept because
    // the two resolutions are separate functions and a start off no policy is the one outcome this
    // whole gate exists to refuse.
    if (!armed) return "the work policy behind this start was withdrawn";
    const verdict = armedPickerPolicy(armed, board).admits(target);
    if (verdict.admitted) return undefined;
    return verdict.detail
      ? `the work policy no longer admits it — ${verdict.detail}`
      : "the work policy no longer admits it";
  };
}

/**
 * Re-ask the DISARM latch, the one brake nothing else here re-asks (PR #218 review).
 *
 * The caller reads it once, before the ranking; what follows is a mirror refresh, a board read, the
 * CAS, the settle window and the WIP check's `gh` reads, and a latch can appear anywhere in it — an
 * overlapping pass's failure breaker or score slide tripping on a run that settled in the meantime. The disarm is the strongest
 * refusal anton has (a frozen project starts nothing until a HUMAN re-arms it), so honouring a stale
 * "armed" verdict here would start exactly the unattended run the freeze was raised to stop.
 *
 * Separate from {@link pickerStance} rather than folded into it because the two name different
 * states to the operator and have different remedies: a withdrawn stance is a setting they changed,
 * a disarm is a brake they have to clear.
 */
export function pickerDisarmed(db: AntonDb, projectId: string): PickerDisarmCheck {
  return async () => {
    const disarm = await activeDisarm(db, projectId);
    return disarm ? `this project's autopilot is disarmed — ${disarm.detail}` : undefined;
  };
}

/**
 * Re-ask the WIP hold, the flow brake the caller read before the ranking (PR #218 review).
 *
 * Same window as the disarm and the stance, different owner: a run entering `stage:in-review` — or
 * the operator lowering the limit — inside the refresh, the CAS and the settle turns a queue that
 * had bandwidth into a full one, and honouring the entry verdict would start the N+1th unattended
 * run the brake exists to hold back. The hold is derived and never latched, so re-asking is the
 * only way to see it; nothing else here does.
 *
 * Judged against the board the caller passes — the settle's read, the freshest this pass has — and
 * only against a fresh one of its own when there is none. An unreadable verdict FAILS CLOSED, like
 * the pre-CAS refresh: the stand-down is reversible, a start is not.
 */
export function pickerWipHold(
  db: AntonDb,
  input: {
    projectId: string;
    repoPath: string;
    signal?: AbortSignal;
    readPrActivity?: ReadPrActivity;
  },
): PickerHoldCheck {
  return async (board) => {
    try {
      const { hold, retired } = await confirmWipQueue(db, {
        projectId: input.projectId,
        repoPath: input.repoPath,
        board: board ?? (await loadAllIssues(input.repoPath)),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.readPrActivity ? { readPrActivity: input.readPrActivity } : {}),
      });
      return {
        ...(hold ? { hold: describeWipHold(hold) } : {}),
        retired: retired.map((slot) => slotKey(slot.beadId, slot.prNumber)),
      };
    } catch (e) {
      return { hold: `the review queue could not be checked before starting (${errorText(e)})` };
    }
  };
}

/**
 * Read the flow brake's OTHER input on its own — the operator's limit, without the `gh` reads
 * (PR #218 review).
 *
 * A hold is a verdict about a board AND a limit, and the limit is resolved when the brake is asked,
 * ahead of its `gh pr view` per waiting PR. So an operator lowering it — or switching the hold on
 * from `0` — inside that confirmation leaves the verdict judged against a rule the project no longer
 * has, and the board reconciliation cannot see it: no bead joined the queue, so a stale "there is
 * bandwidth" looks covered while the current setting would refuse the start outright.
 *
 * Answers `0` for a hold the operator has turned off, and `undefined` for a limit that could not be
 * read at all — which the pass treats like every other unreadable answer here and fails closed on.
 */
export type PickerWipLimitCheck = () => Promise<number | undefined>;

/** {@link PickerWipLimitCheck} over this pass's own db — the settings read `confirmWipQueue` makes. */
export function pickerWipLimit(db: AntonDb, projectId: string): PickerWipLimitCheck {
  return async () => {
    try {
      return resolveWipLimit(await getProjectSettings(db, projectId))?.limit ?? 0;
    } catch {
      return undefined;
    }
  };
}


/** One review slot's identity, shared by the two reconciliations that compare slots across reads. */
export function slotKey(beadId: string, prNumber: number): string {
  return `${beadId}#${prNumber}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
