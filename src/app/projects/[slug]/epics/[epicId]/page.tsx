import { EpicDetailView } from "@/components/epic/epic-detail-view";

export default async function EpicDetailPage({
  params,
}: {
  params: Promise<{ slug: string; epicId: string }>;
}) {
  const { slug, epicId } = await params;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EpicDetailView slug={slug} epicId={epicId} />
    </div>
  );
}
