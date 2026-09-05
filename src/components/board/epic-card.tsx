"use client";

import type { Epic } from "@/lib/types";
import { isPickerPick, typeWord } from "@/components/board/board-utils";
import {
  PickDecisionProvider,
  useCardVeto,
  useUnrecordedPick,
} from "@/components/board/pick-decision";
import { useApproveRun } from "@/components/board/use-approve-run";
import {
  ActiveCardHeader,
  CardMetaRow,
  CardProgress,
  CardShell,
  DoneCardBody,
  EpicSlot,
} from "@/components/board/epic-card-parts";
import { EpicBacklogActions } from "@/components/board/epic-card-actions";

/** What any surface needs to render a run target as a board card — the card and its draggable wrapper. */
export interface EpicCardProps {
  slug: string;
  epic: Epic;
  /**
   * Project budget-aware flag (anton-y2ue): on → the backlog approval splits into "Approve"
   * (immediate) and "Queue" (paced for optimal usage); off → a single "Approve" button.
   */
  budgetAware?: boolean;
  /** Fired after this epic is deleted so the board can drop it from its columns. */
  onDeleted?: (epicId: string) => void;
}

/** Rendered as the drag overlay: no card link, no controls — a picture of the card being moved. */
type EpicCardViewProps = EpicCardProps & { overlay?: boolean };

/**
 * A card the picker chose, on a surface with no lane row to answer it (the epic swimlanes, PR #212
 * review): the card carries the pick's decision itself — the two vetoes beside `[Release]`, under
 * one lock, exactly as an Up Next row does. Everywhere else this is the plain card.
 *
 * The provider has to sit OUTSIDE the card, not inside it, or the card's own approve would read the
 * surrounding context instead of the lock it just created.
 */
export function EpicCard(props: EpicCardViewProps) {
  const cardVeto = useCardVeto();
  const { epic } = props;
  const recorded = isPickerPick(epic.provenance);
  // A LIVE pick no recorded plan names is still anton's pick, and the lane offers both vetoes on one
  // (PR #226 review). What the missing record withholds is the START, which needs a generation to
  // file the accept against; disagreement needs none — the veto route records one against no pick
  // and defers all the same. Withholding it here would make the grouping toggle the thing that takes
  // away the only way to set the target aside.
  const unrecorded = useUnrecordedPick(epic.id, recorded);
  const answerable =
    cardVeto !== undefined && (recorded || unrecorded) && epic.notNowUntil === undefined;
  if (!answerable) return <EpicCardBody {...props} />;
  return (
    <PickDecisionProvider>
      <EpicCardBody {...props} cardVeto={cardVeto} />
    </PickDecisionProvider>
  );
}

/**
 * A run target as the board shows it. Two shapes, because a closed run has a different job than a
 * live one: a done card reports the outcome (merged or abandoned, plus its review score), a live
 * card reports progress and — in the backlog — offers the run.
 *
 * The rows live in epic-card-parts.tsx, the backlog controls in epic-card-actions.tsx, and approval
 * in use-approve-run.ts; this picks which of them a stage gets.
 */
function EpicCardBody({
  slug,
  epic,
  overlay = false,
  budgetAware = false,
  onDeleted,
  cardVeto,
}: EpicCardViewProps & {
  /** Set when this card owns its pick's vetoes; where the hold they place is reported. */
  cardVeto?: (beadId: string, untilMs: number) => void;
}) {
  const approval = useApproveRun({
    slug,
    target: epic,
    failureMessage: `Failed to approve ${typeWord(epic.type)}`,
  });

  if (epic.stage === "done") {
    return (
      <CardShell epic={epic} overlay={overlay} slug={slug} muted>
        <DoneCardBody slug={slug} epic={epic} />
      </CardShell>
    );
  }

  return (
    <CardShell epic={epic} overlay={overlay} slug={slug}>
      <EpicSlot slug={slug} crumb={epic.epic} />
      <ActiveCardHeader epic={epic} />

      <h4 className="text-[13px] leading-snug font-semibold" title={epic.title}>
        {epic.title}
      </h4>
      {epic.goal && (
        <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground" title={epic.goal}>
          {epic.goal}
        </p>
      )}

      <CardProgress epic={epic} />
      <CardMetaRow slug={slug} epic={epic} />

      {epic.stage === "backlog" && !overlay && (
        <EpicBacklogActions
          slug={slug}
          epic={epic}
          budgetAware={budgetAware}
          approval={approval}
          onDeleted={onDeleted}
          {...(cardVeto === undefined ? {} : { cardVeto })}
        />
      )}
    </CardShell>
  );
}
