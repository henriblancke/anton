"use client";

import type { Epic } from "@/lib/types";
import { typeWord } from "@/components/board/board-utils";
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

/**
 * A run target as the board shows it. Two shapes, because a closed run has a different job than a
 * live one: a done card reports the outcome (merged or abandoned, plus its review score), a live
 * card reports progress and — in the backlog — offers the run.
 *
 * The rows live in epic-card-parts.tsx, the backlog controls in epic-card-actions.tsx, and approval
 * in use-approve-run.ts; this picks which of them a stage gets.
 */
export function EpicCard({
  slug,
  epic,
  overlay = false,
  budgetAware = false,
  onDeleted,
}: EpicCardProps & {
  /** Rendered as the drag overlay: no card link, no controls — a picture of the card being moved. */
  overlay?: boolean;
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
      <CardMetaRow epic={epic} />

      {epic.stage === "backlog" && !overlay && (
        <EpicBacklogActions
          slug={slug}
          epic={epic}
          budgetAware={budgetAware}
          approval={approval}
          onDeleted={onDeleted}
        />
      )}
    </CardShell>
  );
}
