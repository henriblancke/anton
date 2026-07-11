import { RunDetailView } from "@/components/runs/run-detail-view";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; runId: string }>;
}) {
  const { slug, runId } = await params;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunDetailView slug={slug} runId={runId} />
    </div>
  );
}
