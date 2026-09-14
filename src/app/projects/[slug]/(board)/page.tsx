import { Suspense } from "react";
import { cookies } from "next/headers";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { EpicBoard } from "@/components/board/epic-board";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { Topbar } from "@/components/shell/topbar";
import { getBoard } from "@/lib/board";
import { boardGroupingCookieName, parseBoardGrouping } from "@/lib/board-grouping";
import { openEscalations } from "@/lib/escalations";
import { currentBreaker } from "@/lib/autopilot-state";
import { unwatchedParksForProject } from "@/lib/unwatched-parks";

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
  //   • parks — parked work with nothing watching it (anton-kh98), which is what the escalation
  //     read CANNOT surface: with the watcher off it has no producer and comes back empty.
  //   • grouping — stage columns or epic swimlanes, the operator's own choice (anton-wds3). Read
  //     here so the FIRST paint is already the layout they picked, instead of painting the default
  //     and dropping the Up Next lane again once the client adopts the stored preference.
  const [board, settings, escalations, parks, cookieStore] = await Promise.all([
    project ? getBoard(project) : null,
    getProjectSettingsBySlug(slug),
    project ? openEscalations(project.id) : [],
    project ? unwatchedParksForProject(project.id) : undefined,
    cookies(),
  ]);
  const grouping = parseBoardGrouping(cookieStore.get(boardGroupingCookieName(slug))?.value);

  // Whether the autopilot has stopped, and which kind: a quality disarm that needs a human
  // (anton-5c8h) or the self-clearing WIP hold (anton-wy9y).
  //
  // Deliberately NOT awaited here. Confirming the hold spawns a `gh pr view` per in-review PR, so
  // a slow or unreachable GitHub would hold the entire board behind a network read — for a band
  // that is one line of context beside cards that were ready to render. The promise is handed to
  // the board and unwrapped inside its own Suspense boundary instead. Failure degrades to no band
  // for the same reason: the cards are the page, and they must not go down with it.
  const breaker = project
    ? currentBreaker(project).catch((err) => {
        console.error(`[board] autopilot breaker read failed for ${slug}`, err);
        return undefined;
      })
    : undefined;

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
            initialGrouping={grouping}
            escalations={escalations}
            parks={parks}
            breaker={breaker}
            budgetAware={settings.budgetAware === true}
          />
        </Suspense>
      </div>
    </div>
  );
}
