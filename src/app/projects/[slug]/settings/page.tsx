import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { discoverAgents } from "@/lib/agents-discovery";
import { listSchedules } from "@/lib/schedules";
import { loadBaseSystemPrompt } from "@/lib/claude/system-prompt";
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
  // The locked base prompt is shown read-only so operators see what's always applied.
  const basePrompt = await loadBaseSystemPrompt().catch(() => "");
  // Real per-project schedule state, so the Automation toggles reflect schedules.enabled.
  const schedules = (await listSchedules(project.id)).map((s) => ({
    type: s.type,
    enabled: s.enabled,
  }));
  // Every agent this project can assign — bundled + the operator's own .claude/agents (anton-dvo.1),
  // so Settings → Agents toggles the real set, not just the hardcoded bundled ids.
  const agents = await discoverAgents(project.repoPath).catch(() => []);

  return (
    <SettingsView
      project={project}
      settings={settings}
      basePrompt={basePrompt}
      schedules={schedules}
      agents={agents}
    />
  );
}
