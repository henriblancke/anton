"use client";

import type { ReactNode } from "react";

import type { Project } from "@/lib/types";
import { PageHeader } from "@/components/atoms";
import { AgentsSection } from "@/components/settings/sections/agents-section";
import { AutomationSection } from "@/components/settings/sections/automation-section";
import { AutopilotSection } from "@/components/settings/sections/autopilot-section";
import { DangerSection } from "@/components/settings/sections/danger-section";
import { ExecutionSection } from "@/components/settings/sections/execution-section";
import { GatesSection } from "@/components/settings/sections/gates-section";
import { GeneralSection } from "@/components/settings/sections/general-section";
import { PromptSection } from "@/components/settings/sections/prompt-section";
import { ProposalsSection } from "@/components/settings/sections/proposals-section";
import { ReviewFixSection } from "@/components/settings/sections/review-fix-section";
import { ReviewSection } from "@/components/settings/sections/review-section";
import { ValueSection } from "@/components/settings/sections/value-section";
import { VariantsSection } from "@/components/settings/sections/variants-section";
import { SettingsNav } from "@/components/settings/settings-nav";
import { SettingsSaveBar } from "@/components/settings/settings-save-bar";
import type { EarnedKind } from "@/components/settings/settings-autonomy";
import { useActiveSection, type SectionId } from "@/components/settings/settings-sections";
import type {
  AutomationSchedule,
  DiscoveredAgent,
  EditableSettings,
  LabelNamespace,
} from "@/components/settings/settings-types";
import { useAutomationSchedules } from "@/components/settings/use-automation-schedules";
import { useSettingsForm } from "@/components/settings/use-settings-form";

export function SettingsView({
  project,
  settings,
  basePrompt,
  schedules,
  defaultCrons,
  agents,
  bundledIds,
  labelVocabulary,
  earned,
}: {
  project: Project;
  settings: EditableSettings;
  /** The locked base system prompt, shown read-only so operators see what always applies. */
  basePrompt: string;
  /** The project's schedule rows (cadence, next run, enabled) backing the Automation section. */
  schedules: AutomationSchedule[];
  /** DEFAULT_SCHEDULES' cron per type — the cadence "Reset to default" restores. */
  defaultCrons: Record<string, string>;
  /** Every agent this project can assign — bundled + the operator's own .claude/agents. */
  agents: DiscoveredAgent[];
  /** Ids anton ships as bundled specialists — the only agents the allowlist gates. */
  bundledIds: string[];
  /** The label namespaces this project's board actually uses — what value nominations pick from. */
  labelVocabulary: LabelNamespace[];
  /**
   * Each kind's settled-proposal record and whether it has earned `apply` (anton-m29g), keyed by
   * detection kind. Computed on the server off the board this project actually has.
   */
  earned: Record<string, EarnedKind>;
}) {
  // Which panel is displayed. The URL hash IS the state — not a copy of it — so /settings#automation
  // lands where it says it will, a reload returns to the same place, and a link points at a section
  // rather than at the top of a page.
  const active = useActiveSection();

  // The allowlist gates anton's BUNDLED agents only; the project's own `.claude/agents` (an id anton
  // doesn't ship) always run and are shown separately as "always active", not toggled here
  // (anton-dvo.1 reversal). Partition by bundled-id membership, NOT by DiscoveredAgent.source: a
  // user override of a bundled name reports source "global"/"project" but still lives in anton's
  // gated slot.
  const bundled = new Set(bundledIds);
  const bundledAgents = agents.filter((a) => bundled.has(a.id));
  const userAgents = agents.filter((a) => !bundled.has(a.id));

  const form = useSettingsForm({
    slug: project.slug,
    settings,
    agents,
    bundledAgentIds: bundledAgents.map((a) => a.id),
    earned,
  });
  // Above the panel it feeds so an optimistic cadence edit survives a trip to another section. The
  // cadence offer (anton-3xa9) persists its answer through the FORM's queued PATCH: the opt-out and
  // "Save changes" write the same settings row, and the route read-modify-writes the whole of it.
  const automationSchedules = useAutomationSchedules({
    slug: project.slug,
    schedules,
    defaultCrons,
    polling: active === "automation",
    keepProductMasterWeekly: settings.keepProductMasterWeekly === true,
    patchSettings: form.patchSettings,
  });

  // Elements, not components: building all thirteen costs a `createElement` each and keeps the panel
  // choice a lookup rather than a thirteen-arm chain — only the one this renders ever mounts.
  const panels: Record<SectionId, ReactNode> = {
    general: <GeneralSection project={project} form={form} />,
    agents: <AgentsSection form={form} bundledAgents={bundledAgents} userAgents={userAgents} />,
    prompt: <PromptSection form={form} basePrompt={basePrompt} />,
    variants: <VariantsSection form={form} />,
    execution: <ExecutionSection form={form} />,
    autopilot: <AutopilotSection form={form} />,
    value: <ValueSection form={form} labelVocabulary={labelVocabulary} />,
    gates: <GatesSection form={form} />,
    review: <ReviewSection form={form} agents={agents} />,
    "review-fix": <ReviewFixSection form={form} />,
    automation: (
      <AutomationSection form={form} schedules={automationSchedules} defaultCrons={defaultCrons} />
    ),
    proposals: <ProposalsSection form={form} earned={earned} projectSlug={project.slug} />,
    danger: <DangerSection project={project} />,
  };

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader project={project.name} section="Settings">
        <SettingsSaveBar form={form} />
      </PageHeader>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[192px_1fr]">
        <SettingsNav active={active} dirty={form.dirty} />
        {/* panels — exactly one renders at a time, chosen by the nav */}
        <div className="flex flex-col gap-7 overflow-y-auto p-6 md:p-7">{panels[active]}</div>
      </div>
    </div>
  );
}
