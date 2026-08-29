import { Suspense } from "react";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { EpicBoard } from "@/components/board/epic-board";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { Topbar } from "@/components/shell/topbar";
import { getBoard } from "@/lib/board";
import { openEscalations } from "@/lib/escalations";
import { currentDisarm } from "@/lib/autopilot-disarm";

export const dynamic = "force-dynamic";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  // The board read (bd + git), the settings read, and the escalation read are independent — run them
  // concurrently so the slowest one sets the page's latency instead of their sum.
  //   • settings — whether this project paces autonomous work (anton-y2ue), which drives the
  //     per-card approval affordance (Approve immediate vs Queue paced).
  //   • escalations — stalls the unstick pass could not safely restart (anton-wvcy).
  //   • disarm — whether a quality breaker has frozen the autopilot (anton-5c8h), which the board
  //     states in its own band rather than making the operator open settings to find out.
  const [board, settings, escalations, disarm] = await Promise.all([
    project ? getBoard(project) : null,
    getProjectSettingsBySlug(slug),
    project ? openEscalations(project.id) : [],
    project ? currentDisarm(project.id) : undefined,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar projectSlug={slug} projectName={project?.name} />
      <div className="flex min-h-0 flex-1 flex-col p-[18px]">
        {/* Escalations are handed to the board rather than rendered here: they are one severity band
            of the attention strip, alongside the polled hygiene report (anton-ue90.1). The board
            reads its Epic/Area narrowing from the URL (useSearchParams), which needs a Suspense
            boundary so the shell above it isn't dragged into client-side rendering. */}
        <Suspense fallback={<BoardSkeleton />}>
          <EpicBoard
            slug={slug}
            initialBoard={board}
            escalations={escalations}
            breaker={disarm}
            budgetAware={settings.budgetAware === true}
          />
        </Suspense>
      </div>
    </div>
  );
}
