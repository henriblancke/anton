"use client";

import { useState } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { ReworkDialog } from "@/components/epic/rework-dialog";
import { TicketDialog } from "@/components/ticket/ticket-dialog";
import { EpicContractPanel } from "@/components/epic/epic-contract-panel";
import { EpicDetailHeader } from "@/components/epic/epic-detail-header";
import { EpicDetailSkeleton } from "@/components/epic/epic-detail-parts";
import { summarizeEpicDetail } from "@/components/epic/epic-detail-summary";
import { EpicGraphPanel } from "@/components/epic/epic-graph-panel";
import { useEpicDetail } from "@/components/epic/use-epic-detail";

/**
 * One run target in full: what it promises (the contract column), what it has produced (the
 * dependency graph), and every action that moves it (the header).
 *
 * The read and the writes live in use-epic-detail.ts, the derived counts in
 * epic-detail-summary.ts, and the sections in the three panel modules beside this one — so this
 * only picks which of them a state gets.
 */
export function EpicDetailView({
  slug,
  epicId,
  budgetAware = false,
}: {
  slug: string;
  epicId: string;
  /**
   * Whether this project's budget governor paces autonomous work (anton-d8i4). On → the run action
   * splits into "Approve" (immediate execution) and "Queue" (paced for optimal usage). Off → a single
   * run button (the governor never runs, so there's nothing to queue for).
   */
  budgetAware?: boolean;
}) {
  const model = useEpicDetail({ slug, epicId });
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [reworkOpen, setReworkOpen] = useState(false);

  if (model.error) return <ErrorState message={model.error} onRetry={model.refresh} />;
  if (!model.detail) return <EpicDetailSkeleton />;

  const { epic, tickets, edges } = model.detail;
  const summary = summarizeEpicDetail(model.detail);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EpicDetailHeader
        slug={slug}
        detail={model.detail}
        summary={summary}
        budgetAware={budgetAware}
        running={model.running}
        onRun={(opts) => void model.run(epic.title, opts)}
        onRework={() => setReworkOpen(true)}
        onDelete={() => model.remove(epic.title)}
        onCopyWorktree={(path) => void model.copyWorktreePath(path)}
        onChanged={model.refresh}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_1fr]">
        <EpicContractPanel
          slug={slug}
          epic={epic}
          tickets={tickets}
          summary={summary}
          review={model.review}
          reviewLoading={model.reviewLoading}
          reviewError={model.reviewError}
          onOpenTicket={setOpenTicketId}
          onChanged={model.refresh}
        />
        <EpicGraphPanel
          epic={epic}
          tickets={tickets}
          edges={edges}
          onSelectTicket={setOpenTicketId}
        />
      </div>

      <ReworkDialog
        slug={slug}
        targetId={epic.id}
        tickets={tickets}
        // The page already holds the report its findings are picked from — hand it over rather than
        // spend a second hydrated read when the dialog opens.
        report={model.review}
        open={reworkOpen}
        onClose={() => setReworkOpen(false)}
        onReworked={model.refresh}
      />

      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
        onSaved={model.refresh}
        onDeleted={model.refresh}
      />
    </div>
  );
}
