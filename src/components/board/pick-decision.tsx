"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CircleSlashIcon, HourglassIcon } from "lucide-react";

import { MetaChip } from "@/components/atoms";
import type { ReleaseRefusal } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One answer per pick (PR #212 review).
 *
 * A ranked card carries both ways to respond — `[Release]` inside the card and the two vetoes above
 * it — and they are the SAME decision seen from two sides. Each control tracking only its own
 * pending flag lets the operator click both while one request is out: a release can start work the
 * veto just deferred, or a veto can record a decline against a plan the release already accepted,
 * leaving two contradictory verdicts on one pick.
 *
 * So the decision, not the button, holds the state. `claim` is synchronous and ref-backed — two
 * clicks in one tick cannot both take it, which no `disabled` prop can promise — and it is the whole
 * gate: a control that fails to claim does nothing at all.
 *
 * `settle` is TERMINAL: an answer that landed is the card's answer, and the other control stays shut
 * until the surface re-reads. `abandon` is for a write that did not land (or one whose own copy asks
 * the operator to try again), which must leave the pick open to answer.
 *
 * Outside a provider the lock is a no-op — a Backlog card renders exactly one of these controls, so
 * there is nothing to serialize.
 *
 * It also carries WHICH pick is being answered — the generation of the plan the operator is looking
 * at (PR #212 review). The controls that write a verdict live at different depths (the vetoes sit on
 * the lane's own row, `[Release]` inside the shared card), and both must name the same decision, so
 * the generation belongs to the pick rather than to either button's props.
 */
export type PickDecision = {
  /** `open` — answerable. `deciding` — a write is out. `settled` — this pick has its answer. */
  state: "open" | "deciding" | "settled";
  /**
   * The plan generation this pick was displayed from, when it came from a recorded plan — from the
   * pick's own provider, or failing that from the surface's ({@link PlanGenerationProvider}).
   * Undefined under neither: a Backlog card is not a pick, so its approve answers no decision.
   */
  planId?: string;
  /**
   * This card is one of anton's LIVE picks — the fact a lane row carries by existing.
   *
   * Only half of "may this be released": the other half is whether a current generation names it
   * (see {@link useUnrecordedPick}). Set only by a surface that presents the card as a pick, and it
   * defaults to false everywhere else — an ordinary Backlog card is not a pick at all, and its plain
   * Approve is nobody's agreement with anton.
   */
  pick: boolean;
  /** Take the pick synchronously; `false` means another control already holds or settled it. */
  claim: () => boolean;
  /** The write landed — the pick is answered. */
  settle: () => void;
  /** The write did not land — hand the pick back. */
  abandon: () => void;
};

const OPEN: PickDecision = {
  state: "open",
  pick: false,
  claim: () => true,
  settle: () => {},
  abandon: () => {},
};

const PickDecisionContext = createContext<PickDecision>(OPEN);

/** What a surface that renders picks without a lane row of their own tells the cards below it. */
type PlanSurface = {
  planId?: string;
  /**
   * The LIVE ranking's targets by bead id. Which cards below are picks at all — the fact a lane row
   * carries by existing, and that a swimlane has to be told (see {@link useUnrecordedPick}).
   */
  ranked?: ReadonlySet<string>;
  onVetoed?: (beadId: string, untilMs: number) => void;
};

const EMPTY_SURFACE: PlanSurface = {};

/** The plan generation on screen, for surfaces that render picks without a per-pick provider. */
const PlanSurfaceContext = createContext<PlanSurface>(EMPTY_SURFACE);

/**
 * The generation the cards below were drawn from, where the picks are NOT rows of the lane (PR #212
 * review).
 *
 * The epic swimlanes are that surface: Up Next is a column position, so grouping by epic leaves the
 * picks in their epic's Backlog slice — still marked, still offering `[Release]`, but with no lane
 * row to carry the generation. Without one the server resolves the accept against whatever plan is
 * current, so a later pass that re-picked the bead would be credited with an agreement to a pick the
 * operator never saw.
 *
 * `ranked` is what tells those cards they are picks. The lane row says it by existing — every row is
 * one — so without it a live-ranked target the recorded plan does not name is indistinguishable here
 * from an ordinary Backlog card, and the start anton-5axf withholds would come back with one click
 * of the grouping toggle (PR #226 review).
 *
 * `onVetoed` is the other half of that missing row: with no row to hang them on, the two ways to
 * DISAGREE with a pick go on the card itself, and this is where the hold they place is reported so
 * the surface can hold the target back before its next poll. Its presence is what puts them there —
 * a surface whose rows carry their own vetoes (the lane) leaves it out, and the card renders none.
 *
 * The GENERATION only, never the lock. The lock is per pick (see {@link PickDecisionProvider}); one
 * spanning a whole board would let answering one card freeze every other.
 */
export function PlanGenerationProvider({
  planId,
  ranked,
  onVetoed,
  children,
}: {
  planId?: string;
  ranked?: ReadonlySet<string>;
  onVetoed?: (beadId: string, untilMs: number) => void;
  children: React.ReactNode;
}) {
  const surface = useMemo<PlanSurface>(
    () => ({
      ...(planId === undefined ? {} : { planId }),
      ...(ranked === undefined ? {} : { ranked }),
      ...(onVetoed === undefined ? {} : { onVetoed }),
    }),
    [planId, ranked, onVetoed],
  );
  return <PlanSurfaceContext.Provider value={surface}>{children}</PlanSurfaceContext.Provider>;
}

/**
 * How a card reports a veto it renders itself, or undefined when the surface has rows that own the
 * vetoes (the Up Next lane) — in which case the card draws none.
 */
export function useCardVeto(): PlanSurface["onVetoed"] {
  return useContext(PlanSurfaceContext).onVetoed;
}

export function PickDecisionProvider({
  planId,
  pick = false,
  children,
}: {
  /** The generation the cards below were projected from; omitted when there is no plan to name. */
  planId?: string;
  /** The card below is one of anton's live picks — every lane row is ({@link PickDecision}). */
  pick?: boolean;
  children: React.ReactNode;
}) {
  const held = useRef<PickDecision["state"]>("open");
  const [state, setState] = useState<PickDecision["state"]>("open");

  const claim = useCallback(() => {
    if (held.current !== "open") return false;
    held.current = "deciding";
    setState("deciding");
    return true;
  }, []);
  const move = useCallback((next: PickDecision["state"]) => {
    held.current = next;
    setState(next);
  }, []);
  const settle = useCallback(() => move("settled"), [move]);
  const abandon = useCallback(() => move("open"), [move]);

  const value = useMemo<PickDecision>(
    () => ({
      state,
      pick,
      claim,
      settle,
      abandon,
      ...(planId === undefined ? {} : { planId }),
    }),
    [state, pick, claim, settle, abandon, planId],
  );
  return <PickDecisionContext.Provider value={value}>{children}</PickDecisionContext.Provider>;
}

/**
 * What stands where `[Release]` would, on a pick no CURRENT generation names (anton-5axf).
 *
 * The start is withheld because the ACCEPT is: a release records the operator's agreement with a
 * named decision, and that record is the evidence earned autonomy is granted on — so a start against
 * a generation no plan names would credit the picker with an agreement to nothing. The plain Approve
 * is withheld for the same reason and not a weaker one: it would start anton's own pick while
 * recording no answer at all, which is the same missing evidence with the button relabelled.
 *
 * RARE, and the copy has to read that way (anton-84lx). Every board read now writes the ranking it
 * derived down (anton-f12y), so a drawn pick is normally named by a generation the moment it appears;
 * this state is what is left when that write did not land and the standing plan has gone stale. The
 * old copy promised a wait on the ten-minute pass, which was long enough to teach the operator to go
 * around the lane and approve from Backlog — which is exactly the unevidenced start it withholds. So
 * the wait it names is the real one: the next board read, which the open board is already taking.
 */
export function PickAwaitingRecord({ className }: { className?: string }) {
  return (
    <MetaChip className={cn("pointer-events-auto", className)}>
      <HourglassIcon className="size-2.5" aria-hidden="true" />
      {/* Terse like the chips beside it, because it shares their row on a lane-width column — so the
          label carries the clearing condition and the title carries why there is a wait at all. */}
      <span title="anton ranks this lane live and writes the ranking down on every board read, so no current generation names this pick yet — releasing now would file an agreement against a decision nothing recorded. The next board read records it and the start comes back; no action needed.">
        anton records this next read
      </span>
    </MetaChip>
  );
}

const REFUSAL_COPY: Record<ReleaseRefusal, string> = {
  retired: "anton no longer picks this",
  settled: "already taken",
};

/**
 * What stands where `[Release]` would once the server REFUSED the start (anton-k4qr / anton-84lx).
 *
 * Distinct from {@link PickAwaitingRecord} on purpose, and that is the whole point of it. The two
 * states look alike from the operator's seat — the start is gone either way — but they are opposite
 * answers: one is a record that has not caught up yet and clears itself, the other is anton having
 * re-decided that this is not work it would start. Reported as the pending one, a refusal would have
 * the operator waiting for a start that is never coming back.
 *
 * The sentence is the SERVER's: it already names which fact retired the pick and what to do instead
 * ("approve it directly if you still want this run"), and restating it here would be a second copy
 * to drift from the exclusion reasons it is drawn from.
 */
export function ReleaseRefused({
  refusal,
  message,
  className,
}: {
  refusal: ReleaseRefusal;
  /** The route's own refusal sentence, kept verbatim as the chip's explanation. */
  message: string;
  className?: string;
}) {
  return (
    <MetaChip tone="partial" className={cn("pointer-events-auto", className)}>
      <CircleSlashIcon className="size-2.5" aria-hidden="true" />
      {/* An alert, unlike the ambient chip above: the operator clicked, and the button they clicked
          has just been replaced by this. */}
      <span role="alert" title={message}>
        {REFUSAL_COPY[refusal]}
      </span>
    </MetaChip>
  );
}

/**
 * Does THIS card offer no start, because no current generation names it (anton-5axf)?
 *
 * One question, asked one way on every surface: the card is a live pick AND the generation on screen
 * either does not exist or does not name it. Both halves are needed — an ordinary Backlog card fails
 * the first, and a pick the standing plan names fails the second — and the lane and the swimlanes
 * differ only in how they answer the first. The lane's rows say it by existing (`pick` on their own
 * {@link PickDecisionProvider}); the swimlanes have no rows, so the surface names the live ranking
 * instead (PR #226 review). Without that second path the grouping toggle was a way around the
 * withheld start: the server refuses the accept either way, so the button offered a start it could
 * not evidence.
 *
 * @param recorded the `◈ policy` mark of a plan anton still stands behind (`isPickerPick`) — the
 * current generation naming this very target.
 */
export function useUnrecordedPick(beadId: string, recorded: boolean): boolean {
  const decision = usePickDecision();
  const { ranked } = useContext(PlanSurfaceContext);
  const isPick = decision.pick || ranked?.has(beadId) === true;
  return isPick && (decision.planId === undefined || !recorded);
}

export function usePickDecision(): PickDecision {
  const decision = useContext(PickDecisionContext);
  // A per-pick provider names its own generation; anything else falls back to the one the surface is
  // showing, so a control outside the lane still answers the decision it was drawn from.
  const generation = useContext(PlanSurfaceContext).planId;
  return useMemo(
    () =>
      decision.planId !== undefined || generation === undefined
        ? decision
        : { ...decision, planId: generation },
    [decision, generation],
  );
}
