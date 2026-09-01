"use client";

import type { UpNextCard } from "@/components/board/board-utils";
import { UP_NEXT_LABEL, upNextMetaLabel } from "@/components/board/board-utils";
import { DraggableEpicCard } from "@/components/board/draggable-epic-card";
import { StandaloneChip } from "@/components/board/standalone-chip";

/**
 * The `Up Next` lane, between Backlog and Implementing (anton-t9m4 / R3.1–R3.4).
 *
 * It owns its cards: the board hands it the ranked plan already subtracted from Backlog
 * (`takeUpNext`), so a bead renders in exactly one lane. It is NOT a stage — the four columns beside
 * it map to bead state, this one is a ranking this machine recorded — so it carries no stage dot, no
 * droppable, and a caption that says whose plan it is. Nothing here is shared board state, and the
 * copy must never let it read as if it were (R3.4).
 *
 * The cards themselves are the SAME components Backlog renders. A forked lane card would be a second
 * place a target's approve/claim/release affordances live, and the two would drift; what the lane
 * adds is the ranking's own facts above each card, which is the only thing Backlog cannot say.
 */
export function UpNextLane({
  slug,
  cards,
  budgetAware = false,
  onEpicDeleted,
  onOpenTicket,
}: {
  slug: string;
  /** Ranked plan cards, in rank order — never empty, since an empty lane is not rendered at all. */
  cards: UpNextCard[];
  /** Project budget-aware flag (anton-y2ue): forwarded to cards exactly as Backlog forwards it. */
  budgetAware?: boolean;
  onEpicDeleted?: (epicId: string) => void;
  /** Open a standalone chip's detail dialog (hoisted to the board so one dialog serves all). */
  onOpenTicket?: (ticketId: string) => void;
}) {
  return (
    <section
      data-lane={UP_NEXT_LABEL}
      aria-label={UP_NEXT_LABEL}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
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
            {cards.length}
          </span>
        </div>
        {/* R3.4, said in the operator's words: this ranking belongs to this machine. The tooltip
            carries the rest — where it comes from, and that no teammate sees it. */}
        <p
          className="text-[11px] leading-snug text-subtle"
          title="Up Next is this machine's own ranking over Backlog, recorded by the board-picker. It is not a bead state, it is not shared with your teammates, and moving a card is what changes the board."
        >
          This machine&rsquo;s plan — not shared board state.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-transparent p-0.5">
        {cards.map((card) => (
          <div key={card.entry.beadId} className="flex flex-col gap-1.5">
            <UpNextMeta card={card} />
            {card.kind === "epic" ? (
              <DraggableEpicCard
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
        ))}
      </div>
    </section>
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
      className="flex items-center gap-2 px-0.5"
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
