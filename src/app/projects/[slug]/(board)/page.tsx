import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { EpicBoard } from "@/components/board/epic-board";
import { Topbar } from "@/components/shell/topbar";
import { getBoard } from "@/lib/board";

export const dynamic = "force-dynamic";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  const board = project ? await getBoard(project) : null;
  // Whether this project paces autonomous work (anton-y2ue) — drives the per-card approval affordance
  // (Approve immediate vs Queue paced), mirroring the epic detail page.
  const settings = await getProjectSettingsBySlug(slug);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar projectSlug={slug} projectName={project?.name} />
      <div className="flex min-h-0 flex-1 flex-col p-[18px]">
        <EpicBoard slug={slug} initialBoard={board} budgetAware={settings.budgetAware === true} />
      </div>
    </div>
  );
}
