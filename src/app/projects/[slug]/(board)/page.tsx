import { Suspense } from "react";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { EpicBoard } from "@/components/board/epic-board";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { EscalationsPanel } from "@/components/board/escalations-panel";
import { Topbar } from "@/components/shell/topbar";
import { getBoard } from "@/lib/board";
import { openEscalations } from "@/lib/escalations";

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
  const [board, settings, escalations] = await Promise.all([
    project ? getBoard(project) : null,
    getProjectSettingsBySlug(slug),
    project ? openEscalations(project.id) : [],
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar projectSlug={slug} projectName={project?.name} />
      <div className="flex min-h-0 flex-1 flex-col p-[18px]">
        {/* Above the columns on purpose: an escalation is work that has STOPPED, and the board is
            where the operator decides what runs next. It renders nothing when there are none. */}
        <EscalationsPanel slug={slug} escalations={escalations} />
        {/* The board reads its Epic/Area narrowing from the URL (useSearchParams), which needs a
            Suspense boundary so the shell above it isn't dragged into client-side rendering. */}
        <Suspense fallback={<BoardSkeleton />}>
          <EpicBoard slug={slug} initialBoard={board} budgetAware={settings.budgetAware === true} />
        </Suspense>
      </div>
    </div>
  );
}
