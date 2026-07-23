import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { bundledAgentIds, discoverAgents } from "@/lib/agents-discovery";
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
  // Every agent this project can assign, plus which ids belong to anton's bundled namespace. The
  // Agents tab splits them: bundled ids are toggleable in the allowlist; the project's own
  // .claude/agents (ids anton doesn't ship) are shown as always-active, never gated (anton-dvo.1
  // reversal). We partition by bundled-id membership, not by DiscoveredAgent.source — a user
  // override of a bundled name reports source "global"/"project" but still lives in anton's slot.
  const [agents, bundledIds] = await Promise.all([
    discoverAgents(project.repoPath).catch(() => []),
    bundledAgentIds().catch(() => []),
  ]);

  return (
    <SettingsView
      project={project}
      settings={settings}
      basePrompt={basePrompt}
      schedules={schedules}
      agents={agents}
      bundledIds={bundledIds}
    />
  );
}
