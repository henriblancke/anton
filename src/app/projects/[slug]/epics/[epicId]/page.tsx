import { EpicDetailView } from "@/components/epic/epic-detail-view";

export default async function EpicDetailPage({
  params,
}: {
  params: Promise<{ slug: string; epicId: string }>;
}) {
  const { slug, epicId } = await params;

  return (
    <div className="flex flex-1 flex-col p-4 sm:p-6">
      <EpicDetailView slug={slug} epicId={epicId} />
    </div>
  );
}
