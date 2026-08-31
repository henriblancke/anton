import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { allIssues } from "@/lib/beads/issues";
import { boardLabelVocabulary } from "@/lib/beads/labels";
import { discoverVocabulary } from "@/lib/policy/vocabulary";
import { boardIssueTypes, calibratePolicy } from "@/lib/policy/calibrate";
import { policyCandidates } from "@/lib/policy/candidates";
import { earnedAutonomyOfKind, emptyTrackRecord } from "@/lib/gardener/autonomy";
import { GARDENER_DETECTION_KINDS } from "@/lib/gardener/detections";
import { proposalTrackRecord } from "@/lib/gardener/track-record";
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
    lastRun: s.lastRun,
    pendingRun: s.pendingRun,
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
  const [agents, bundledIds, board] = await Promise.all([
    discoverAgents(project.repoPath).catch(() => []),
    bundledAgentIds().catch(() => []),
    // The failure is CARRIED, not swallowed into an empty board: an unreadable board and a board with
    // no work look identical downstream, and the work policy panel must not let an operator arm a
    // fallback policy fitted to a read failure.
    allIssues(project.repoPath, { blockOnPendingWrite: false }).then(
      (issues) => ({ issues, ok: true }),
      () => ({ issues: [] as Awaited<ReturnType<typeof allIssues>>, ok: false }),
    ),
  ]);
  const beads = board.issues;
  const labelVocabulary = boardLabelVocabulary(beads);
  // Which of those namespaces read as a SCALE (anton-g631) — the only ones the policy editor offers a
  // hand-ranking on, since "rank these" means nothing on a `team:` or `component:`.
  const rankingCandidates = discoverVocabulary(beads)
    .namespaces.filter((n) => n.rankingCandidate)
    .map((n) => n.namespace);
  // What first arm proposes (anton-c7iv): the policy this project's OWN approvals would have
  // matched, so the panel is never a blank form and never speaks a vocabulary this board doesn't.
  // Pure over the snapshot already read above — no extra board call — and inert: the draft is only
  // rendered, never stored, until the operator accepts it.
  const policyDraft = calibratePolicy(beads);
  const issueTypes = boardIssueTypes(beads);
  // Every STARTABLE run target, flattened to what the predicate reads, so the editor's match count
  // and its per-bead "why not?" answer in the browser as the operator edits (anton-qsr1). Startable
  // is the picker's own gate, so the panel counts the set a policy actually chooses from; the rest
  // of the open run targets arrive as a count the panel explains. Off the same snapshot — no extra
  // board call.
  const { candidates, notStartable } = policyCandidates(beads);

  // What this board's own settled proposals say about each kind (anton-m29g) — the second gate
  // arming needs, and the one no setting lifts. Derived here rather than in the form because the
  // form is a client module and the verdict is a fact about the board; it arrives as plain counts
  // and a reason, so a locked control is never an unexplained disabled control. A board anton cannot
  // read yields an empty record, which locks everything — the safe direction.
  const record = await allIssues(project.repoPath)
    .then(proposalTrackRecord)
    .catch(() => emptyTrackRecord());
  const earned = Object.fromEntries(
    GARDENER_DETECTION_KINDS.map((kind) => {
      const { applied, settled, eligible, reason } = earnedAutonomyOfKind(kind, record);
      return [kind, { applied, settled, eligible, ...(reason ? { reason } : {}) }];
    }),
  );

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
      rankingCandidates={rankingCandidates}
      issueTypes={issueTypes}
      policyDraft={policyDraft}
      policyCandidates={candidates}
      policyNotStartable={notStartable}
      boardUnavailable={!board.ok}
      earned={earned}
    />
  );
}
