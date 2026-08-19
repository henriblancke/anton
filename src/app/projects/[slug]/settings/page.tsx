import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { allIssues } from "@/lib/beads/issues";
import { boardLabelVocabulary } from "@/lib/beads/labels";
import { bundledAgentIds, discoverAgents } from "@/lib/agents-discovery";
import { DEFAULT_SCHEDULES, listSchedules } from "@/lib/schedules";
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
  // Real per-project schedule state — cadence, last fire, next fire and enabled — so the Automation
  // table shows the row that actually fires rather than copy that can drift from it. lastRunAt is
  // the one fact the old rows dropped, and it is what answers "is this thing working".
  const schedules = (await listSchedules(project.id)).map((s) => ({
    type: s.type,
    enabled: s.enabled,
    cron: s.cron,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
  }));
  // The cadence each automation ships with, so "Reset to default" has one source of truth.
  const defaultCrons = Object.fromEntries(DEFAULT_SCHEDULES.map((d) => [d.type, d.cron]));
  // Every agent this project can assign, plus which ids belong to anton's bundled namespace. The
  // Agents tab splits them: bundled ids are toggleable in the allowlist; the project's own
  // .claude/agents (ids anton doesn't ship) are shown as always-active, never gated (anton-dvo.1
  // reversal). We partition by bundled-id membership, not by DiscoveredAgent.source — a user
  // override of a bundled name reports source "global"/"project" but still lives in anton's slot.
  // Plus the label vocabulary the board actually uses (anton-prng), so value nominations are picked
  // from this project's own namespaces rather than from labels anton assumed. Read alongside the
  // agents (the snapshot is usually warm from the board) and fail-soft: a board anton can't read
  // leaves the picker empty, where the editor still takes a typed label.
  const [agents, bundledIds, beads] = await Promise.all([
    discoverAgents(project.repoPath).catch(() => []),
    bundledAgentIds().catch(() => []),
    allIssues(project.repoPath, { blockOnPendingWrite: false }).catch(() => []),
  ]);
  const labelVocabulary = boardLabelVocabulary(beads);

  return (
    <SettingsView
      project={project}
      settings={settings}
      basePrompt={basePrompt}
      schedules={schedules}
      defaultCrons={defaultCrons}
      agents={agents}
      bundledIds={bundledIds}
      labelVocabulary={labelVocabulary}
    />
  );
}
