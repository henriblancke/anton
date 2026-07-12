import { getProjectBySlug } from "@/lib/projects";
import { EpicBoard } from "@/components/board/epic-board";
import { Topbar } from "@/components/shell/topbar";

export const dynamic = "force-dynamic";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar projectSlug={slug} projectName={project?.name} />
      <div className="flex min-h-0 flex-1 flex-col p-[18px]">
        <EpicBoard slug={slug} />
      </div>
    </div>
  );
}
