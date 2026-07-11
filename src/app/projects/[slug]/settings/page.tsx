import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { SettingsView } from "@/components/settings/settings-view";

export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const settings = await getProjectSettingsBySlug(slug);

  return <SettingsView project={project} settings={settings} />;
}
