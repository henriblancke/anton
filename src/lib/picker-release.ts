/**
 * WHICH pick a release answers, and whether it may be answered at all (anton-d2h6, anton-k4qr).
 *
 * A release is the approve route's ordinary approval plus one extra half: the target was anton's
 * pick and the operator agreed with it, so the choice is recorded as an accept that
 * `pickerTrackRecord` — and through it earned autonomy — reads as evidence. The `release` flag is a
 * CLIENT'S CLAIM about that, never a fact: a stale lane, a retried request or any direct caller can
 * set it on a target the picker never offered. So the server re-derives the very predicate the
 * `[Release]` button is drawn from (`board.ts` → `isPickerPick`) rather than trusting the flag.
 *
 * Split out of the route because it has two halves the route runs at different moments, and the
 * order is load-bearing:
 *
 *   1. {@link resolveRelease} — asked BEFORE anything is written, against the pre-write board. It
 *      names the generation this release answers, or says why the accept is not recordable, or
 *      REFUSES the start outright.
 *   2. {@link recordRelease} — asked after the claim swap and before the enqueue, so the accept and
 *      a veto from another tab settle against each other in the store rather than around the window
 *      the run start holds open.
 *
 * Judged against the caller's PRE-WRITE board snapshot: the approval's own label and claim would
 * otherwise invalidate the very plan they are answering.
 */
import {
  agedOutPicks,
  getBoardPickerPlan,
  isPlanStale,
  saveBoardPickerPlan,
  stampBoard,
  type BoardPickerPlan,
  type PickerExclusion,
} from "./board-picker-plan";
import type { Bead } from "./beads/types";
import { systemClock, type AntonDb } from "./jobs/queue";
import { ADMIT_ALL_POLICY, decideBoardPickerPlan } from "./jobs/picker-decision";
import { armedPickerPolicy } from "./jobs/picker-policy";
import type { Policy } from "./policy/types";
import {
  activeDeferrals,
  declinedPicks,
  pickerTrackRecord,
  recordPickerAccept,
} from "./picker-veto";
import { getProjectSettings, resolvePickerAutonomy, resolvePickerPolicy } from "./projects";
import type { ReleaseRefusal } from "./types";
import { scheduleEnabled } from "./schedules";

/** The decision a release answers: the generation, and that generation's own rank and rule. Read
 *  off the plan, never off the request — a client-supplied rank could name any decision. */
export interface ReleasePick {
  planId: string;
  rank: number;
  rule?: string;
}

/**
 * What the server makes of a release's claim, in the three shapes the route acts on differently:
 *
 *   • `accept` — this release answers a live pick; record it.
 *   • `skip`   — the run is the operator's to have, the evidence is not. The approval and the run go
 *                ahead and nothing is written about the picker.
 *   • `refuse` — the start itself must not happen: the operator answered a generation that has been
 *                replaced, and the ranking as of now does not carry this target at all. `refusal`
 *                says WHICH of those it is, for the card that must report it as a state
 *                ({@link ReleaseRefusal}, {@link isAlreadySettled}).
 */
export type ReleaseResolution =
  | { accept: ReleasePick }
  | { skip: string }
  | { refuse: string; refusal: ReleaseRefusal };

export interface ResolveReleaseInput {
  projectId: string;
  beadId: string;
  /** The requesting route's PRE-WRITE board read — see the module note for why it is not a fresh one. */
  board: Bead[];
  /** The plan generation the operator had on screen, when the client named one. */
  displayedPlanId?: string;
}

/**
 * Resolve which pick this release answers — the server's own verdict on the client's claim.
 *
 * The gates, in the order the answer narrows, each mirroring a fact the board gates the `[Release]`
 * button on:
 *
 *   • the picker is ARMED (its schedule is on) and at a level that OFFERS its picks — `propose`
 *     ranks and offers nothing (R3.5), so a flag from a tab opened before the level changed answers
 *     a pick this project never put in front of anyone;
 *   • a plan exists at all;
 *   • the operator has not since VETOED this target;
 *   • the generation the operator answered is still the one that stands — see below;
 *   • that generation actually carries this target as an entry (naming the right plan is not
 *     agreeing with a decision it contains);
 *   • the board and policy have not moved past it, including the age bounds the plan's digest
 *     cannot hold (`agedOutPicks`).
 *
 * A SUPERSEDED generation re-derives rather than dropping the answer (anton-k4qr). It used to skip
 * — which lost the accept while the approve and the enqueue still landed, so the operator's choice
 * left no trace and earned autonomy read a start with no evidence behind it. The honest reading of a
 * replaced generation is that we do not yet know whether the pick survived it, and that is a
 * question with an answer: re-decide the plan from the board this request already read, exactly as a
 * board read does (`decideBoardPickerPlan` → `saveBoardPickerPlan`, idempotent per decision, so
 * restating what stands mints no generation). Still ranked → the accept is recorded against THAT
 * generation, with its rank and its rule. No longer ranked → anton would not start this target now,
 * so the release is refused before it writes anything.
 *
 * The veto is tested BEFORE the generation, so a vetoed pick keeps skipping rather than being
 * refused by the re-derivation that would exclude it as `deferred` — "you already said no to this"
 * and "anton no longer picks this" are different answers with different remedies.
 *
 * FAILS CLOSED on its own errors: an unreadable store skips, never refuses. The accept is evidence
 * about the picker, not a gate on the run, so an anton.db hiccup must not cost the operator a start
 * they are entitled to.
 */
export async function resolveRelease(
  db: AntonDb,
  input: ResolveReleaseInput,
): Promise<ReleaseResolution> {
  const { projectId, beadId, board, displayedPlanId } = input;
  const skip = (why: string): ReleaseResolution => {
    console.warn(`[approve] release of ${beadId} recorded no accept: ${why}`);
    return { skip: why };
  };
  try {
    // One clock read for every question below, so the stamp, the age bounds it cannot carry and the
    // re-derivation are all judged at the instant the board read is judged at.
    const now = Date.now();
    const [plan, armed, settings, record, deferrals] = await Promise.all([
      getBoardPickerPlan(db, projectId),
      scheduleEnabled(db, projectId, "board-picker"),
      getProjectSettings(db, projectId),
      pickerTrackRecord(db, projectId),
      activeDeferrals(db, projectId, new Date(now)),
    ]);
    const policy = resolvePickerPolicy(settings);
    if (!armed) return skip("the picker is disarmed");
    if (resolvePickerAutonomy(settings, record) === "propose") {
      return skip("the picker is at propose — it offers no picks to answer");
    }
    if (!plan) return skip("no recorded plan picks this target");
    if (deferrals.has(beadId)) return skip("the operator vetoed this pick");
    if (displayedPlanId !== undefined && plan.planId !== displayedPlanId) {
      return await rederiveRelease(db, { projectId, beadId, board, policy, deferrals, now });
    }
    const entry = plan.entries.find((e) => e.beadId === beadId);
    if (!entry) return skip("no recorded plan picks this target");
    // Keyed on the plan id the entry above came from, so this asks whether THIS generation has been
    // vetoed — including the pick whose hold lapsed with no pass to rewrite the plan (isPlanStale).
    const declined = await declinedPicks(db, projectId, plan.planId);
    if (
      isPlanStale(
        plan,
        stampBoard(board, now, policy),
        deferrals,
        declined,
        agedOutPicks(plan, board, policy, now),
      )
    ) {
      return skip("the plan that picked it is no longer the decision anton stands behind");
    }
    return { accept: pickOf(plan.planId, entry.rank, entry.rule) };
  } catch (err) {
    console.error(`[approve] failed to resolve the picker release for ${beadId}`, err);
    return { skip: "the picker's record could not be read" };
  }
}

/**
 * Re-decide the plan from the board this request read, and answer with the pick it now holds
 * (anton-k4qr).
 *
 * The same pure decision a pass and a board read make — nothing here re-derives a rule of its own —
 * and recorded through the same idempotent writer, so a re-derivation that restates the standing
 * decision hands back the generation that already stands rather than retiring it under the surface
 * still showing it. It never yields to a fresher observation: like the board read, what it records
 * is what it just judged against, and the accept it is about to file has to name that.
 */
async function rederiveRelease(
  db: AntonDb,
  input: {
    projectId: string;
    beadId: string;
    board: Bead[];
    policy?: Policy;
    deferrals: ReadonlyMap<string, number>;
    now: number;
  },
): Promise<ReleaseResolution> {
  const { projectId, beadId, board, policy, deferrals, now } = input;
  const decision = decideBoardPickerPlan({
    board,
    policy: policy ? armedPickerPolicy(policy, board, new Date(now)) : ADMIT_ALL_POLICY,
    ...(policy ? { armedPolicy: policy } : {}),
    runtime: { observedAtMs: now, deferrals },
  });
  const fresh: BoardPickerPlan = await saveBoardPickerPlan(db, systemClock, {
    projectId,
    ...decision,
  });
  const entry = fresh.entries.find((e) => e.beadId === beadId);
  if (entry) return { accept: pickOf(fresh.planId, entry.rank, entry.rule) };
  // Named, not merely refused: the operator clicked a pick, and "it stopped being one" is only
  // actionable if it says which fact retired it. The exclusion is the decision's own words — the
  // same ones the lane groups the rest of the board by.
  // The decision reports every refusal but a CLOSED target's (`eligibleTargets`): finished work is
  // most of a mature board and nobody asks why it isn't next. A release can still name one — the
  // run it started finished while this view was open — so that one reading is restored here.
  const excluded =
    decision.exclusions.find((x) => x.beadId === beadId) ??
    (board.find((b) => b.id === beadId)?.status === "closed"
      ? { beadId, reason: "not-open" as const, detail: "closed" }
      : undefined);
  const because = excluded
    ? `${excluded.reason}${excluded.detail ? ` — ${excluded.detail}` : ""}`
    : "it is no longer in the ranked set";
  if (excluded && isAlreadySettled(excluded)) {
    return {
      refusal: "settled",
      refuse:
        `${beadId} is already taken (${because}) — it was settled while this view was open. ` +
        `Nothing new was approved or started; the board is catching up.`,
    };
  }
  return {
    refusal: "retired",
    refuse:
      `${beadId} is no longer one of anton's picks: the plan you released from was replaced, and ` +
      `the current one leaves it out (${because}). Nothing was approved or started — approve it ` +
      `directly if you still want this run.`,
  };
}

/**
 * Whether an exclusion means the target was ALREADY SETTLED rather than retired (PR #236 review).
 *
 * A ranking drops a target because somebody else got there — a parallel release from another tab,
 * a teammate's claim, a run already in flight or finished. The remedy for a retired pick, "approve
 * it directly", is wrong for those: it invites a second approval on a start that exists. So they get
 * the stale-surface reading instead, which is what the client's 409 handler already acts on
 * (`release-action.tsx` → `router.refresh()`).
 *
 * `not-open` is read by its STATUS, not taken whole (PR #245 review): `ineligibility` reports every
 * non-open status under it, and only some of those are a start. `in_progress` and `closed` are;
 * `blocked` and `deferred` are targets nobody has, waiting on a blocker or a hold — and telling the
 * operator "already taken" would hide the one thing they need to do. Every genuinely-retired reason
 * — `needs-human`, `policy`, `approval-gap`, `blocked` — keeps the approve-directly remedy.
 */
function isAlreadySettled(excluded: PickerExclusion): boolean {
  if (excluded.reason === "claimed") return true;
  return excluded.reason === "not-open" && SETTLED_STATUSES.has(excluded.detail ?? "");
}

/** The `not-open` statuses that mean a start exists: running, or already run to completion. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["in_progress", "closed"]);

function pickOf(planId: string, rank: number, rule?: string): ReleasePick {
  return { planId, rank, ...(rule ? { rule } : {}) };
}

/**
 * File the operator's accept of the pick {@link resolveRelease} named.
 *
 * RESERVED BEFORE THE RUN, not recorded after it (PR #212 review). The accept and the veto are the
 * two answers to one pick, and only the store can settle which lands — so the release must take its
 * answer before it enqueues, or a veto posted from another tab slips into the window the enqueue
 * holds open and declines a pick whose run is already starting. Answering first collapses that
 * window: the loser is told it lost by a decision that was already durable.
 *
 * The price of reserving early is a run that then fails to start, and an accept for a run that never
 * started is evidence of nothing — so this hands back the row id and the caller withdraws it in
 * exactly that case (`withdrawPickerAccept`).
 *
 * Best-effort, like the enqueue that follows it: the approval has already landed, so a write to
 * anton.db that falls over must not fail a release the operator already got. Every failure here
 * fails CLOSED, recording nothing rather than an accept it could not stand behind.
 *
 * `recordPickerAccept` is the ARBITER of the accept/veto race, not the deferral read in
 * {@link resolveRelease}: that read cannot see a veto still being written, while this one re-asks
 * holding the write lock, so at most one of the two verdicts ever lands on a pick.
 *
 * @returns the id of the accept this request filed, or undefined when it recorded nothing.
 */
export async function recordRelease(
  db: AntonDb,
  input: { projectId: string; beadId: string; pick: ReleasePick },
): Promise<string | undefined> {
  const { projectId, beadId, pick } = input;
  try {
    const outcome = await recordPickerAccept(db, systemClock, {
      projectId,
      beadId,
      ...(pick.rule ? { rule: pick.rule } : {}),
      rank: pick.rank,
      ...(pick.planId ? { planId: pick.planId } : {}),
    });
    if (outcome.recorded) return outcome.id;
    // A duplicate is the SAME accept restated (a double-click, a retry): the standing row is not this
    // request's to withdraw, so it reports nothing reserved.
    console.warn(
      `[approve] release of ${beadId} recorded no accept: ${
        outcome.reason === "vetoed"
          ? "the operator vetoed this pick first"
          : "this pick already carries the operator's accept"
      }`,
    );
    return undefined;
  } catch (err) {
    console.error(`[approve] failed to record the picker accept for ${beadId}`, err);
    return undefined;
  }
}
