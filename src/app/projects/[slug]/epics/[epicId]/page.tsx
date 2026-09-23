import { EpicDetailView } from "@/components/epic/epic-detail-view";
import { notFound } from "next/navigation";
import { getEpicDetail } from "@/lib/epic-detail";
import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";

export default async function EpicDetailPage({
  params,
}: {
  params: Promise<{ slug: string; epicId: string }>;
}) {
  const { slug, epicId } = await params;
  // Whether this project paces autonomous work (anton-d8i4). Drives the approval affordance: with it
  // on, the epic view offers "Approve" (immediate) vs "Queue" (paced); off, a single run button.
  const [settings, initialDetail] = await Promise.all([
    getProjectSettingsBySlug(slug),
    getProjectBySlug(slug).then((project) => {
      if (!project) notFound();
      return getEpicDetail(project, epicId).catch(() => undefined);
    }),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EpicDetailView key={`${slug}/${epicId}`} initialDetail={initialDetail} slug={slug} epicId={epicId} budgetAware={settings.budgetAware === true} />
    </div>
  );
}
