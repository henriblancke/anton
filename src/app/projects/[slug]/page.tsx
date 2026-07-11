import { EpicBoard } from "@/components/board/epic-board";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <div className="flex flex-1 flex-col">
      <EpicBoard slug={slug} />
    </div>
  );
}
