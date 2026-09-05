"use client";

import { Fragment, useMemo } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import Link from "next/link";

import type { UpNextCard } from "@/components/board/board-utils";
import { UP_NEXT_LABEL, isPickerPick, upNextMetaLabel } from "@/components/board/board-utils";
import { BudgetDivider, BudgetWaiting, useBudgetSignal } from "@/components/board/budget-line";
import { EpicCard } from "@/components/board/epic-card";
import { PickDecisionProvider } from "@/components/board/pick-decision";
import { StandaloneChip } from "@/components/board/standalone-chip";
import { VetoActions } from "@/components/board/veto-actions";
import { budgetLine } from "@/lib/budget-line";
import type { UpNextAbsence } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The `Up Next` lane, between Backlog and Implementing (anton-t9m4 / R3.1–R3.4).
 *
 * It owns its cards: the board hands it the ranked plan already subtracted from Backlog
 * (`takeUpNext`), so a bead renders in exactly one lane. It is NOT a stage — the four columns beside
 * it map to bead state, this one is a ranking this machine recorded — so it carries no stage dot, no
 * column droppable, and a caption that says whose plan it is. Nothing here is shared board state,
 * and the copy must never let it read as if it were (R3.4).
 *
 * The cards themselves are the SAME components Backlog renders. A forked lane card would be a second
 * place a target's approve/claim/release affordances live, and the two would drift; what the lane
 * adds is the ranking's own facts above each card, the two ways to disagree with a pick (R3.9), and
 * the dashed line where the budget runs out (R3.6) — none of which Backlog can say.
 */
export function UpNextLane({
  slug,
  cards,
  plan,
  planId,
  budgetAware = false,
  reordering = false,
  onEpicDeleted,
  onOpenTicket,
  onVetoed,
}: {
  slug: string;
  /** Ranked plan cards, in rank order — never empty, since an empty lane is not rendered at all. */
  cards: UpNextCard[];
  /**
   * Every pick in the ranking, in rank order, by bead id — including the ones the board's filters
   * are hiding. `cards` is a narrowed view of this; the budget line is placed on the whole plan.
   */
  plan: readonly string[];
  /** The plan generation these cards were projected from, carried into each card's veto. */
  planId?: string;
  /** Project budget-aware flag (anton-y2ue): forwarded to cards exactly as Backlog forwards it. */
  budgetAware?: boolean;
  /**
   * A reorder is being written. Reorders are serialized (epic-board), so the lane closes its handles
   * for the round-trip rather than letting the operator start a drag the board will refuse.
   */
  reordering?: boolean;
  onEpicDeleted?: (epicId: string) => void;
  /** Open a standalone chip's detail dialog (hoisted to the board so one dialog serves all). */
  onOpenTicket?: (ticketId: string) => void;
  /** A target the operator just set aside, so the board can hold it back before the next poll. */
  onVetoed?: (beadId: string, untilMs: number) => void;
}) {
  // Where this project's quota runs out (anton-vlom / R3.6). The signal is the governor's own
  // headroom, so a null reading — unreadable usage, or a project that is not budget-aware — draws no
  // line at all, matching the gate's fail-open rule rather than guessing a position.
  const signal = useBudgetSignal(slug);
  // Placed on the WHOLE ranking, not on what the filters left. A hidden pick still spends the
  // budget, so charging only the visible cards from zero would mark a target affordable that anton
  // would hold — the plan is what the governor pays for, the lane is just the part on screen.
  const line = useMemo(() => budgetLine(signal, plan.map(() => ({}))), [signal, plan]);
  // What crosses back to the cards is only the waiting state the full plan gives each of them.
  const waiting = useMemo(() => (line ? new Set(plan.slice(line.affordable)) : null), [line, plan]);
  // The divider goes above the first VISIBLE card the plan leaves waiting — which is the top of the
  // lane when the filters hid everything the budget affords, and nowhere when they hid the rest.
  const dividerAt = useMemo(
    () => (waiting ? cards.findIndex((card) => waiting.has(card.entry.beadId)) : -1),
    [waiting, cards],
  );
  const ids = useMemo(() => cards.map((card) => card.entry.beadId), [cards]);

  return (
    <section
      data-lane={UP_NEXT_LABEL}
      aria-label={UP_NEXT_LABEL}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
      <LaneHead
        badge={String(cards.length)}
        // R3.4, said in the operator's words: this ranking belongs to this machine. The tooltip
        // carries the rest — where it comes from, and that no teammate sees it.
        caption="This machine’s plan — not shared board state."
        captionTitle="Up Next is this machine's own ranking over Backlog, recorded by the board-picker. It is not a bead state, it is not shared with your teammates, and moving a card is what changes the board."
      />

      {/* Sortable, not droppable: the lane is a ranking, so the only drop it accepts is onto another
          of its own cards — which the board turns into a priority write (R3.8). */}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-transparent p-0.5">
          {cards.map((card, index) => {
            const row = (
              <UpNextRow
                slug={slug}
                card={card}
                planId={planId}
                budgetAware={budgetAware}
                reordering={reordering}
                onEpicDeleted={onEpicDeleted}
                onOpenTicket={onOpenTicket}
                onVetoed={onVetoed}
              />
            );
            return (
              <Fragment key={card.entry.beadId}>
                {line && index === dividerAt && <BudgetDivider line={line} />}
                {line && waiting?.has(card.entry.beadId) ? (
                  <BudgetWaiting reason={line.reason}>{row}</BudgetWaiting>
                ) : (
                  row
                )}
              </Fragment>
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

/**
 * The lane's heading, shared by the ranking and by every absence that replaces it (anton-w579).
 *
 * One component because the two must read as the SAME lane: an operator who learns the dashed dot
 * and the caption slot on a full lane should recognise the empty one as that lane, not as a new
 * panel that appeared where their plan used to be.
 */
function LaneHead({
  badge,
  caption,
  captionTitle,
}: {
  /** The count, or — on an absence — the state's own word in the count's place. */
  badge: string;
  caption: string;
  captionTitle?: string;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1 px-0.5">
      <div className="flex items-center gap-2">
        {/* Hollow and dashed where the four stages are solid: the shape says "not a stage" before
            the caption below has to. */}
        <span
          className="size-2.5 rounded-full border border-dashed border-subtle"
          aria-hidden="true"
        />
        <h2 className="text-[13px] font-semibold text-foreground">{UP_NEXT_LABEL}</h2>
        <span className="ml-auto rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-subtle">
          {badge}
        </span>
      </div>
      <p
        className="text-[11px] leading-snug text-subtle"
        {...(captionTitle ? { title: captionTitle } : {})}
      >
        {caption}
      </p>
    </div>
  );
}

/**
 * What each genuine absence IS, and what clears it (anton-w579) — the lane's copy for the states
 * where there is no ranking to draw.
 *
 * A count of `0` would be the one reading the lane must never give: "anton has nothing to start" is
 * a claim about the BOARD, and all but one of these states say nothing about the board at all. So
 * the count's place carries the state's own word instead, and the sentence under it is always the
 * clearing condition — the rule anton-5c8h set for every stopped state on this screen.
 *
 * The link goes where the condition is actually cleared, so the operator never has to hunt for the
 * control the sentence just named. `no-claimable-work` points at the policy rather than at the
 * Backlog beside it: its other holds — a blocker, a thin contract — are cleared on the target
 * itself, and a policy too narrow to admit anything is the half of that state nothing else on the
 * board would explain.
 */
const ABSENCE_COPY: Record<
  UpNextAbsence,
  { badge: string; headline: string; clears: string; link: { label: string; hash: string } }
> = {
  disarmed: {
    badge: "off",
    headline: "No pass ranks work here — board-picker is switched off.",
    clears: "Turn board-picker back on and the next pass fills this lane.",
    link: { label: "Automation settings", hash: "automation" },
  },
  "proposes-only": {
    badge: "propose",
    headline: "The picker ranks in the background, but propose offers nothing.",
    clears: "Raise picker autonomy to shadow and its picks appear here to release or veto.",
    link: { label: "Picker autonomy", hash: "policy" },
  },
  "policy-unreadable": {
    badge: "?",
    headline: "anton can’t read this project’s work policy, so it won’t guess a ranking.",
    // The only absence with no operator action to name: the next board read retries the settings on
    // its own. So the sentence sends them to the same place the link does — the panel that says what
    // is armed — rather than to a reload the board is already doing.
    clears: "The next board read retries it — check the armed policy if this lane stays empty.",
    link: { label: "Work policy", hash: "policy" },
  },
  "no-claimable-work": {
    badge: "none",
    // Never "approve one" (PR #226 review): the board's Approve STARTS the target rather than making
    // it rankable, and a veto has no control that clears it early. The remedies named here are the
    // ones that can actually put a target back in the ranking.
    headline: "Nothing on this board is work anton may start right now.",
    clears:
      "Clear what holds a target back — a blocker, a thin contract, a policy too narrow — or wait out one you set aside, and this lane fills again.",
    link: { label: "Work policy", hash: "policy" },
  },
};

/**
 * The lane when there is no ranking to draw, and the reason is one the operator can clear.
 *
 * It holds the lane's column on purpose. Removing the section is what the board did before, and an
 * operator watching Up Next disappear learns nothing about which unrelated state they are in — a
 * switched-off pass, a level that only proposes, a policy anton could not read, and a board with
 * nothing claimable on it all looked identical, and only one of them is about their work.
 */
export function UpNextAbsenceLane({ slug, absence }: { slug: string; absence: UpNextAbsence }) {
  const copy = ABSENCE_COPY[absence];

  return (
    <section
      data-lane={UP_NEXT_LABEL}
      data-absence={absence}
      aria-label={UP_NEXT_LABEL}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
      <LaneHead badge={copy.badge} caption={copy.headline} />
      <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border bg-muted/20 p-3">
        {/* Emphasised over the headline above it, for the same reason the breaker band emphasises
            its own: an operator reading an empty lane wants to know what to DO about it. */}
        <p className="text-[11px] leading-snug font-medium text-foreground">{copy.clears}</p>
        <Link
          href={`/projects/${slug}/settings#${copy.link.hash}`}
          className="inline-flex h-6 items-center rounded-lg border border-border bg-card px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {copy.link.label}
        </Link>
      </div>
    </section>
  );
}

/**
 * One ranked pick: the lane's own facts above the card Backlog would have shown.
 *
 * The drag handle lives here rather than on the card, so a target registers exactly one draggable —
 * dragging it sideways still moves its stage, dragging it within the lane reorders the plan.
 *
 * The row is also where the pick's ONE decision lives: `[Release]` renders inside the card and the
 * vetoes render above it, so nothing below could serialize them (PR #212 review). Scoped per row —
 * answering one pick never freezes the rest of the plan. The provider carries the generation on
 * screen with it, so the release inside the card names the same decision the vetoes above it do —
 * or carries that there is none to name, which is what takes the start off the card (anton-5axf).
 */
function UpNextRow({
  slug,
  card,
  planId,
  budgetAware,
  reordering,
  onEpicDeleted,
  onOpenTicket,
  onVetoed,
}: {
  slug: string;
  card: UpNextCard;
  planId?: string;
  budgetAware: boolean;
  reordering: boolean;
  onEpicDeleted?: (epicId: string) => void;
  onOpenTicket?: (ticketId: string) => void;
  onVetoed?: (beadId: string, untilMs: number) => void;
}) {
  const { beadId } = card.entry;
  const title = card.kind === "epic" ? card.epic.title : card.item.title;
  const notNowUntil = card.kind === "epic" ? card.epic.notNowUntil : card.item.notNowUntil;
  const provenance = card.kind === "epic" ? card.epic.provenance : card.item.provenance;
  // Is there a RECORDED decision behind this pick? The lane is DERIVED (anton-r0ew), so it ranks
  // targets the last pass never wrote down — and a verdict on one of those has no generation to
  // name. Both halves are asked because both are what binds it: the `◈ policy` mark is the plan
  // naming THIS target (isPickerPick, which a stale plan fails), and `planId` is the generation the
  // accept is written against. Missing either, the card offers no start at all (anton-5axf).
  const unconfirmed = planId === undefined || !isPickerPick(provenance);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: beadId,
      // `upNext` on BOTH ends is what tells the board's drop handler this was a reorder and not a
      // stage move; `stage` keeps a card draggable out of the lane into a column, as before.
      data: { upNext: true, ...(card.kind === "epic" ? { stage: card.epic.stage } : {}) },
      disabled: reordering,
    });

  const style = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    transition,
  };

  return (
    <PickDecisionProvider unconfirmed={unconfirmed} {...(planId === undefined ? {} : { planId })}>
      <div
        ref={setNodeRef}
        style={style}
        className={cn("flex flex-col gap-1.5", isDragging && "opacity-40")}
      >
        <div className="flex items-center gap-2 px-0.5">
          <UpNextMeta card={card} />
          {/* The two ways to disagree with the pick, on the pick itself (R3.9). */}
          <VetoActions
            slug={slug}
            beadId={beadId}
            {...(planId === undefined ? {} : { planId })}
            title={title}
            {...(notNowUntil === undefined ? {} : { notNowUntil })}
            className="shrink-0"
            onVetoed={(untilMs) => onVetoed?.(beadId, untilMs)}
          />
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            disabled={reordering}
            aria-label={`Reorder "${title}"`}
            title={
              reordering
                ? "Saving the last reorder — one at a time"
                : "Drag to reorder — the new position is written as this target's priority"
            }
            style={{ touchAction: "none" }}
            className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md text-subtle transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing disabled:cursor-progress disabled:opacity-40"
          >
            <GripVerticalIcon className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        {card.kind === "epic" ? (
          <EpicCard
            slug={slug}
            epic={card.epic}
            budgetAware={budgetAware}
            onDeleted={onEpicDeleted}
          />
        ) : (
          <StandaloneChip
            slug={slug}
            item={card.item}
            budgetAware={budgetAware}
            onOpen={onOpenTicket}
          />
        )}
      </div>
    </PickDecisionProvider>
  );
}

/**
 * Why this card is where it is: its position in the plan, and the three facts the ranking sorted on
 * (priority, work type, how much open work finishing it frees).
 *
 * Above the card rather than inside it, for the same reason the lane doesn't fork the card: these
 * are the LANE's facts, true only of a ranked pick, and a card that carried them everywhere would
 * be claiming a rank in Backlog and in Done.
 */
function UpNextMeta({ card }: { card: UpNextCard }) {
  const { rank } = card.entry;
  const meta = upNextMetaLabel(card.entry);

  return (
    <div
      role="group"
      aria-label={`Rank ${rank} — ${meta}`}
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary font-mono text-[10px] leading-none text-muted-foreground"
        aria-hidden="true"
      >
        {rank}
      </span>
      <span className="truncate font-mono text-[10px] text-subtle" aria-hidden="true">
        {meta}
      </span>
    </div>
  );
}
