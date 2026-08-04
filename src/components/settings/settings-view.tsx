"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { describeCron } from "@/lib/jobs/cadence";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";
import {
  AutomationTable,
  type AutomationScheduleState,
  type AutomationSpec,
} from "@/components/settings/automation-table";
import { DeleteProjectDialog } from "@/components/settings/delete-project-dialog";
import { PruneBeadsSection } from "@/components/settings/prune-beads-section";

/**
 * One label→formula mapping (anton-aa3m), mirrored from the server's FormulaVariant. Local for the
 * same reason as EditableSettings: this client module never imports server code.
 */
interface FormulaVariant {
  label: string;
  formula: string;
}

/** A variant row being edited: the mapping plus a stable local id used only as the React key. */
interface VariantRow extends FormulaVariant {
  id: string;
}

/** Settings the UI can edit today. Kept local so this client module never imports server code. */
interface EditableSettings {
  model?: string;
  seedPrompt?: string;
  reviewFixPrompt?: string;
  /** Pre-PR self-review gate (anton-3apm); absent = ON. The knobs below only apply when on. */
  reviewEnabled?: boolean;
  reviewAgent?: string;
  reviewPrompt?: string;
  reviewMaxRounds?: number;
  /** Score-regression alarm (anton-i98r): park after `reviewLowScoreRounds` rounds below this. */
  reviewMinScore?: number;
  reviewLowScoreRounds?: number;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  /** Per-label pipeline variants (anton-aa3m), in precedence order — first matching label wins. */
  formulaVariants?: FormulaVariant[];
  concurrency?: number;
  jobTimeoutMinutes?: number;
  ticketTimeoutMinutes?: number;
  maxRetries?: number;
  agents?: string[];
  autonomy?: boolean;
  conventionalCommits?: boolean;
  /** Budget-aware execution master-switch (anton-7mpv.1); off by default. Gates the knobs below. */
  budgetAware?: boolean;
  /** Operator budget policy (anton-egrg); only the two exposed knobs round-trip through this form. */
  budgetPolicy?: {
    daytimeReservePct?: number;
    weeklyTargetPct?: number;
  };
}

// Defaults mirror the server (src/lib/projects.ts DEFAULT_*); duplicated so this client module
// stays server-import-free. Keep in sync.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2h without progress
const DEFAULT_TICKET_TIMEOUT_MINUTES = 45;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_REVIEW_MAX_ROUNDS = 2;
const REVIEW_MAX_ROUNDS_MIN = 1;
const REVIEW_MAX_ROUNDS_MAX = 5;
// Score-regression alarm (anton-i98r). A min score of 0 is the off switch — no review can score
// below zero — which is why the min of the range is 0 rather than 1.
const DEFAULT_REVIEW_MIN_SCORE = 5;
const REVIEW_MIN_SCORE_MIN = 0;
const REVIEW_MIN_SCORE_MAX = 10;
const DEFAULT_REVIEW_LOW_SCORE_ROUNDS = 2;
const REVIEW_LOW_SCORE_ROUNDS_MIN = 1;
const REVIEW_LOW_SCORE_ROUNDS_MAX = 5;
// Mirror DEFAULT_PROJECT_BUDGET_POLICY (src/lib/projects.ts) for the two operator-facing knobs.
const DEFAULT_DAYTIME_RESERVE_PCT = 15;
const DEFAULT_WEEKLY_TARGET_PCT = 90;

/** Default model options for the headless claude driver. Empty value = the CLI's own default. */
const MODELS: { value: string; label: string; hint?: string }[] = [
  { value: "", label: "Default", hint: "use claude's configured model" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "most capable" },
  { value: "claude-sonnet-5", label: "Sonnet 5", hint: "balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest" },
  { value: "claude-fable-5", label: "Fable 5", hint: "frontier" },
];

/**
 * The settings sections, in lifecycle order (anton-ue90.3): what identifies the project, then what
 * happens while a run works, then what has to pass before a PR opens, then what runs on a schedule,
 * then what cannot be undone.
 *
 * Every section that renders is listed here, and the nav SWITCHES which one renders — the previous
 * list named six of eight and only repainted a highlight. `dirtyKeys` names the form fields a
 * section owns, so the save bar can say which section is unsaved instead of offering a bare button
 * on a page whose top is out of view.
 */
const SECTIONS = [
  {
    id: "general",
    label: "General",
    group: "The project",
    dirtyKeys: ["model"],
  },
  { id: "agents", label: "Active agents", group: "The project", dirtyKeys: ["agents"] },
  {
    id: "prompt",
    label: "Execution prompt",
    group: "While a run works",
    dirtyKeys: ["seedPrompt"],
  },
  {
    id: "variants",
    label: "Pipeline variants",
    group: "While a run works",
    dirtyKeys: ["formulaVariants"],
  },
  {
    id: "execution",
    label: "Concurrency & limits",
    group: "While a run works",
    dirtyKeys: [
      "concurrency",
      "jobTimeoutMinutes",
      "ticketTimeoutMinutes",
      "maxRetries",
      "autonomy",
      "conventionalCommits",
      "budget",
    ],
  },
  { id: "gates", label: "Verify gates", group: "Before the PR opens", dirtyKeys: ["gates"] },
  {
    id: "review",
    label: "Self-review",
    group: "Before the PR opens",
    dirtyKeys: ["review"],
  },
  {
    id: "review-fix",
    label: "Review-fix",
    group: "Before the PR opens",
    dirtyKeys: ["reviewFixPrompt"],
  },
  { id: "automation", label: "Automation", group: "On a schedule", dirtyKeys: [] },
  { id: "danger", label: "Danger zone", group: "Irreversible", dirtyKeys: [] },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Group headings in the order the sections above declare them. */
const SECTION_GROUPS = SECTIONS.reduce<string[]>(
  (groups, s) => (groups.includes(s.group) ? groups : [...groups, s.group]),
  [],
);

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

function isSectionId(value: string): value is SectionId {
  return SECTION_IDS.has(value);
}

/**
 * `history.replaceState` fires no event, so a section change has to announce itself for the store
 * below to re-read the URL. Same-tab only, which is all this needs.
 */
const SECTION_CHANGE_EVENT = "anton:settings-section";

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener(SECTION_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(SECTION_CHANGE_EVENT, onChange);
  };
}

/**
 * The displayed panel, read from the URL rather than mirrored into React state (anton-ue90.3).
 *
 * `useSyncExternalStore` and not a state-seeding effect: the hash is an external system, the server
 * has no access to it, and this is the shape that renders "general" on the server and the real
 * section on the client without a hydration mismatch or a cascading render. An unknown or absent
 * hash falls back rather than rendering a blank body.
 */
function useActiveSection(): SectionId {
  const hash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.slice(1),
    () => "",
  );
  return isSectionId(hash) ? hash : "general";
}

function showSection(id: SectionId): void {
  // replaceState, not a router navigation: this is which panel is on screen, not a new page, and
  // pushing it would turn Back into "undo the last tab click" nine times over.
  window.history.replaceState(null, "", `#${id}`);
  window.dispatchEvent(new Event(SECTION_CHANGE_EVENT));
}

// What each scheduled automation DOES, and what makes it idle. Ids match the schedule row `type`.
// Cadence, next-run time, last-run time and enabled state all come from the schedules row — never
// from copy here, which could disagree with the row that actually fires.
const AUTOMATIONS: AutomationSpec[] = [
  {
    id: "nightly-stringer",
    label: "nightly-stringer",
    description: "scan → triage",
    group: "Board maintenance",
  },
  {
    id: "orphan-grooming",
    label: "orphan-grooming",
    description: "bucket loose tickets",
    group: "Board maintenance",
  },
  {
    id: "gardener",
    label: "gardener",
    description: "hygiene patrol · closes done epics, reports the rest",
    group: "Board maintenance",
  },
  {
    id: "run-health",
    label: "run-health",
    description: "report stalled runs",
    group: "Run health",
  },
  {
    id: "unstick",
    label: "unstick",
    description: "acts on run-health's findings",
    dependsOn: "run-health",
    group: "Run health",
  },
  {
    id: "gate-check",
    label: "gate-check",
    description: "resumes runs whose gate closed · human gates never auto-close",
    group: "Run health",
  },
  {
    id: "review-fix",
    label: "review-fix watcher",
    description: "poll open PRs for review events",
    group: "Delivery",
  },
];

/**
 * How often the open Automation panel re-reads the schedule rows.
 *
 * The table's countdown ticks on its own clock, but a fire is a SERVER event: when a job runs, the
 * row gets a new nextRunAt and a new lastRunAt, and neither is knowable here. Without this the panel
 * holds the snapshot it was rendered with — the countdown would tick down to "due now" and then sit
 * there, with "Last run" still naming the fire before this one, until someone reloaded the page.
 *
 * Thirty seconds is comfortably inside the fastest cadence the editor offers and costs one small
 * indexed query per open panel; the interval is only mounted while that panel is open.
 */
const SCHEDULE_POLL_MS = 30_000;

/** Per-automation schedule state from the server; a missing row means "not scheduled yet". */
interface AutomationSchedule {
  type: string;
  enabled: boolean;
  cron: string;
  /** Epoch SECONDS; absent while the schedule is disabled. */
  nextRunAt?: number;
  /** Epoch SECONDS of the last fire; absent until it has run once. */
  lastRunAt?: number;
}

/**
 * One discoverable agent (anton-dvo.1), mirrored from the server's DiscoveredAgent. Kept local so
 * this client module never imports the server-only discovery code.
 */
interface DiscoveredAgent {
  id: string;
  source: "project" | "global" | "bundled" | "plugin";
  description?: string;
}

export function SettingsView({
  project,
  settings,
  basePrompt,
  schedules,
  defaultCrons,
  agents,
  bundledIds,
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
}) {
  // Which panel is displayed. The URL hash IS the state — not a copy of it — so /settings#automation
  // lands where it says it will, a reload returns to the same place, and a link points at a section
  // rather than at the top of a page.
  const active = useActiveSection();
  const router = useRouter();

  /**
   * What "saved" currently means — the values every field is diffed against to decide it is dirty.
   *
   * Seeded from the SSR snapshot, then MOVED to the row the server stored on each successful save.
   * The `settings` prop cannot serve as this baseline: it is fixed for the component's lifetime, so
   * after a save the nav dots and the "unsaved in X" line would stay lit until a reload — and worse,
   * an operator who restored a field to its pre-save value would see the Save button go disabled
   * while the server still held the new value, with no way to put the original back.
   */
  const [baseline, setBaseline] = useState<EditableSettings>(settings);

  // The allowlist gates anton's BUNDLED agents only; the project's own `.claude/agents` (an id anton
  // doesn't ship) always run and are shown separately as "always active", not toggled here
  // (anton-dvo.1 reversal — see inactiveAgentTickets / ProjectSettings.agents). Partition by
  // bundled-id membership, NOT by DiscoveredAgent.source: a user override of a bundled name reports
  // source "global"/"project" but still lives in anton's gated slot.
  const bundled = new Set(bundledIds);
  const bundledAgents = agents.filter((a) => bundled.has(a.id));
  const userAgents = agents.filter((a) => !bundled.has(a.id));
  // The enabled bundled allowlist. Absent persisted value → seed "all bundled on", matching the
  // runtime rule that an absent allowlist means every bundled agent is active (so a no-op save
  // stays all-active). A stored value may carry stale user-agent ids from before the reversal; they
  // never match a bundled toggle and are pruned by the bundled-only filter on save.
  const [activeAgents, setActiveAgents] = useState<Set<string>>(
    () => new Set(settings.agents ?? bundledAgents.map((a) => a.id)),
  );
  const [concurrency, setConcurrency] = useState(settings.concurrency ?? DEFAULT_CONCURRENCY);
  const [jobTimeoutMinutes, setJobTimeoutMinutes] = useState(
    settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES,
  );
  const [ticketTimeoutMinutes, setTicketTimeoutMinutes] = useState(
    settings.ticketTimeoutMinutes ?? DEFAULT_TICKET_TIMEOUT_MINUTES,
  );
  const [maxRetries, setMaxRetries] = useState(settings.maxRetries ?? DEFAULT_MAX_RETRIES);
  const [autonomy, setAutonomy] = useState(settings.autonomy ?? true);
  const [conventionalCommits, setConventionalCommits] = useState(
    settings.conventionalCommits ?? false,
  );
  const [budgetAware, setBudgetAware] = useState(settings.budgetAware ?? false);
  const [daytimeReservePct, setDaytimeReservePct] = useState(
    settings.budgetPolicy?.daytimeReservePct ?? DEFAULT_DAYTIME_RESERVE_PCT,
  );
  const [weeklyTargetPct, setWeeklyTargetPct] = useState(
    settings.budgetPolicy?.weeklyTargetPct ?? DEFAULT_WEEKLY_TARGET_PCT,
  );
  // enabled: null = no schedule row for this project yet (shown as "not scheduled"; editing the row
  // creates it). A row-less automation still shows a cadence — the default one it would be created
  // at — so the picker is never blank.
  const [automations, setAutomations] = useState<Record<string, AutomationScheduleState>>(() =>
    Object.fromEntries(
      AUTOMATIONS.map((a) => {
        const row = schedules.find((s) => s.type === a.id);
        return [
          a.id,
          {
            enabled: row?.enabled ?? null,
            cron: row?.cron ?? defaultCrons[a.id] ?? "",
            nextRunAt: row?.nextRunAt,
            lastRunAt: row?.lastRunAt,
          },
        ];
      }),
    ),
  );
  // A schedule PATCH and the schedule poll both write the same rows, and the PATCH is the one that
  // knows the truth — its response carries the server's recomputed nextRunAt. These two let a poll
  // recognise that it raced a write and drop its own (pre-write) answer rather than applying it on
  // top: `inFlight` catches a write still running, `completed` a write that started AND finished
  // inside the poll's request window, which a plain in-flight check would miss entirely.
  const schedulePatchesInFlight = useRef(0);
  const schedulePatchesCompleted = useRef(0);

  const [model, setModel] = useState(settings.model ?? "");
  const [seedPrompt, setSeedPrompt] = useState(settings.seedPrompt ?? "");
  const [reviewFixPrompt, setReviewFixPrompt] = useState(settings.reviewFixPrompt ?? "");
  // Absent → ON: the self-review gate runs unless the operator turns it off (anton-3apm).
  const [reviewEnabled, setReviewEnabled] = useState(settings.reviewEnabled ?? true);
  const [reviewAgent, setReviewAgent] = useState(settings.reviewAgent ?? "");
  const [reviewPrompt, setReviewPrompt] = useState(settings.reviewPrompt ?? "");
  const [reviewMaxRounds, setReviewMaxRounds] = useState(
    settings.reviewMaxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS,
  );
  const [reviewMinScore, setReviewMinScore] = useState(
    settings.reviewMinScore ?? DEFAULT_REVIEW_MIN_SCORE,
  );
  const [reviewLowScoreRounds, setReviewLowScoreRounds] = useState(
    settings.reviewLowScoreRounds ?? DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
  );
  const [testCommand, setTestCommand] = useState(settings.testCommand ?? "");
  const [lintCommand, setLintCommand] = useState(settings.lintCommand ?? "");
  const [typecheckCommand, setTypecheckCommand] = useState(settings.typecheckCommand ?? "");
  const [buildCommand, setBuildCommand] = useState(settings.buildCommand ?? "");
  // Per-label pipeline variants (anton-aa3m). The array order IS the precedence, so edits preserve
  // it and the row controls move an entry rather than re-sorting behind the operator's back. Rows
  // carry a stable local id purely as a React key — reordering with index keys would move the
  // operator's cursor between inputs.
  const [variantRows, setVariantRows] = useState<VariantRow[]>(() =>
    (settings.formulaVariants ?? []).map((v, i) => ({ id: `v${i}`, ...v })),
  );
  const nextVariantId = useRef(variantRows.length);
  const [saving, setSaving] = useState(false);

  /**
   * Which staged edits differ from what is persisted, keyed by the names {@link SECTIONS} declares.
   *
   * The save bar reads this to name the sections it is about to submit. Without it, the only signal
   * that anything was edited is a button that looks identical whether or not it will do something —
   * which on a page where one panel (Automation) saves immediately and every other waits for Save is
   * how an operator loses an edit they thought had landed.
   *
   * Compared the same way the save body serializes: trimmed text, so trailing whitespace is not an
   * edit, and the persisted defaults, so an untouched form is never dirty.
   *
   * Against {@link baseline}, not the `settings` prop — the prop is the SSR snapshot and never
   * moves, so a save would leave every indicator here stuck on.
   */
  const dirty: Record<string, boolean> = {
    model: model !== (baseline.model ?? ""),
    agents: !sameIds(
      bundledAgents.filter((a) => activeAgents.has(a.id)).map((a) => a.id),
      baseline.agents ?? bundledAgents.map((a) => a.id),
    ),
    seedPrompt: seedPrompt.trim() !== (baseline.seedPrompt ?? "").trim(),
    reviewFixPrompt: reviewFixPrompt.trim() !== (baseline.reviewFixPrompt ?? "").trim(),
    formulaVariants: !sameVariants(variantRows, baseline.formulaVariants ?? []),
    concurrency: concurrency !== (baseline.concurrency ?? DEFAULT_CONCURRENCY),
    jobTimeoutMinutes:
      jobTimeoutMinutes !== (baseline.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES),
    ticketTimeoutMinutes:
      ticketTimeoutMinutes !== (baseline.ticketTimeoutMinutes ?? DEFAULT_TICKET_TIMEOUT_MINUTES),
    maxRetries: maxRetries !== (baseline.maxRetries ?? DEFAULT_MAX_RETRIES),
    autonomy: autonomy !== (baseline.autonomy ?? true),
    conventionalCommits: conventionalCommits !== (baseline.conventionalCommits ?? false),
    budget:
      budgetAware !== (baseline.budgetAware ?? false) ||
      daytimeReservePct !==
        (baseline.budgetPolicy?.daytimeReservePct ?? DEFAULT_DAYTIME_RESERVE_PCT) ||
      weeklyTargetPct !== (baseline.budgetPolicy?.weeklyTargetPct ?? DEFAULT_WEEKLY_TARGET_PCT),
    gates:
      testCommand.trim() !== (baseline.testCommand ?? "").trim() ||
      lintCommand.trim() !== (baseline.lintCommand ?? "").trim() ||
      typecheckCommand.trim() !== (baseline.typecheckCommand ?? "").trim() ||
      buildCommand.trim() !== (baseline.buildCommand ?? "").trim(),
    review:
      reviewEnabled !== (baseline.reviewEnabled ?? true) ||
      reviewAgent !== (baseline.reviewAgent ?? "") ||
      reviewPrompt.trim() !== (baseline.reviewPrompt ?? "").trim() ||
      reviewMaxRounds !== (baseline.reviewMaxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS) ||
      reviewMinScore !== (baseline.reviewMinScore ?? DEFAULT_REVIEW_MIN_SCORE) ||
      reviewLowScoreRounds !==
        (baseline.reviewLowScoreRounds ?? DEFAULT_REVIEW_LOW_SCORE_ROUNDS),
  };
  const dirtySections = SECTIONS.filter((s) => s.dirtyKeys.some((key) => dirty[key]));

  /**
   * Persist one automation's cadence and/or enabled flag immediately (not via Save) — optimistic,
   * reverted with a toast if the PATCH fails. A missing row is created server-side. The response
   * carries the row as stored, so the next-run readout is the server's recomputed nextRunAt rather
   * than a guess made here.
   */
  async function patchSchedule(
    id: string,
    patch: { cron?: string; enabled?: boolean },
    message: string,
  ) {
    const prev = automations[id];
    setAutomations((p) => ({ ...p, [id]: { ...prev, ...patch } }));
    schedulePatchesInFlight.current += 1;
    try {
      const res = await fetch(`/api/projects/${project.slug}/schedules`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: id, ...patch }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(error ?? "Update failed");
      }
      const { schedule } = await res.json().catch(() => ({ schedule: undefined }));
      if (schedule) {
        setAutomations((p) => ({
          ...p,
          [id]: {
            enabled: schedule.enabled,
            cron: schedule.cron,
            nextRunAt: schedule.nextRunAt,
            lastRunAt: schedule.lastRunAt,
          },
        }));
      }
      toast.success(message);
    } catch (err) {
      // Undo only the fields this patch wrote. Restoring the whole `prev` snapshot would also roll
      // back a concurrent patch for the same automation (toggle while a cadence save is in flight),
      // leaving the row wrong until reload.
      setAutomations((p) => ({
        ...p,
        [id]: {
          ...p[id],
          ...(patch.cron !== undefined ? { cron: prev.cron } : {}),
          ...(patch.enabled !== undefined ? { enabled: prev.enabled } : {}),
        },
      }));
      toast.error(err instanceof Error ? err.message : `Failed to update ${id}`);
    } finally {
      // In `finally` so a rejected patch also clears the in-flight count — otherwise one network
      // failure would leave the counter above zero and silently stop the poll for the whole session.
      schedulePatchesInFlight.current -= 1;
      schedulePatchesCompleted.current += 1;
    }
  }

  /**
   * Keep the open Automation panel's next-run and last-run times live (anton-ue90).
   *
   * Only the two TIME fields are taken from the poll. Cadence and enabled state are owned by this
   * page's optimistic writes, and letting a poll land on them would let a response that left the
   * server before an edit arrive after it and quietly put the old cadence back on screen — while the
   * editor's own draft, seeded once from the `cron` prop, kept showing the new one.
   */
  useEffect(() => {
    if (active !== "automation") return;
    let cancelled = false;

    async function refresh() {
      if (schedulePatchesInFlight.current > 0) return;
      const completedBefore = schedulePatchesCompleted.current;
      let rows: unknown;
      try {
        const res = await fetch(`/api/projects/${project.slug}/schedules`);
        if (!res.ok) return;
        ({ schedules: rows } = await res.json());
      } catch {
        // Transient — the next tick retries. A failed read must not toast or blank the table; the
        // times simply stay as stale as they were before it ran.
        return;
      }
      if (cancelled || !Array.isArray(rows)) return;
      // Re-checked AFTER the await: a write that started and landed while this request was open
      // holds the newer times, so this response is stale even though it arrived later.
      if (
        schedulePatchesInFlight.current > 0 ||
        schedulePatchesCompleted.current !== completedBefore
      ) {
        return;
      }
      setAutomations((p) => {
        const next = { ...p };
        for (const row of rows as AutomationSchedule[]) {
          const current = next[row.type];
          // A row for a type this build doesn't list is not ours to show.
          if (!current) continue;
          next[row.type] = { ...current, nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt };
        }
        return next;
      });
    }

    // Once on arrival, then on the interval. Switching sections is a hash change, not a navigation,
    // so nothing re-reads the server on the way in: without the leading read, a panel opened from a
    // page that had been sitting for an hour would show that hour-old snapshot — and now that the
    // countdown ticks, it would confidently count it down — for the first thirty seconds.
    void refresh();
    const id = setInterval(refresh, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, project.slug]);

  function toggleAutomation(id: string, next: boolean) {
    return patchSchedule(id, { enabled: next }, `${id} ${next ? "enabled" : "disabled"}`);
  }

  function setAutomationCron(id: string, cron: string) {
    return patchSchedule(id, { cron }, `${id} · ${describeCron(cron)}`);
  }

  function patchVariant(id: string, patch: Partial<FormulaVariant>) {
    setVariantRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** Move a mapping one place up or down — the list's order is the precedence an operator tunes. */
  function moveVariant(id: string, delta: -1 | 1) {
    setVariantRows((rows) => {
      const at = rows.findIndex((r) => r.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });
  }

  function toggleAgent(agent: string) {
    setActiveAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // "" clears the override → driver runs with no --model / no seed / the default review-fix prompt.
        body: JSON.stringify({
          model: model || null,
          seedPrompt: seedPrompt.trim() || null,
          reviewFixPrompt: reviewFixPrompt.trim() || null,
          // Self-review gate (anton-3apm). "" clears the reviewer swap / prompt override → the
          // shipped review contract. The knobs are sent even while the gate is off, so turning it
          // back on restores the operator's reviewer instead of silently resetting it.
          reviewEnabled,
          // A stored reviewer whose agent has since been deleted is shown but NOT resubmitted: the
          // PATCH rejects unknown ids, which would fail every unrelated save until someone noticed.
          // Omitting the key leaves the stored id untouched — runtime already falls back on its own.
          ...(reviewerMissing(reviewAgent, agents) ? {} : { reviewAgent: reviewAgent || null }),
          reviewPrompt: reviewPrompt.trim() || null,
          reviewMaxRounds,
          reviewMinScore,
          reviewLowScoreRounds,
          // "" clears a verify gate → it's skipped (no behavior change).
          testCommand: testCommand.trim() || null,
          lintCommand: lintCommand.trim() || null,
          typecheckCommand: typecheckCommand.trim() || null,
          buildCommand: buildCommand.trim() || null,
          // Per-label pipeline variants (anton-aa3m), in the order shown — that order is the
          // precedence. A half-filled row is scaffolding, not a mapping, so it's dropped rather
          // than 400ing the whole save; [] clears the map (every run walks the project's default).
          formulaVariants: variantRows
            .map((v) => ({ label: v.label.trim(), formula: v.formula.trim() }))
            .filter((v) => v.label && v.formula),
          concurrency,
          jobTimeoutMinutes,
          ticketTimeoutMinutes,
          maxRetries,
          // The enabled BUNDLED ids, in discovered order. Only bundled ids we actually rendered — a
          // stale id from a since-deleted or user agent (still in the seeded set) is pruned rather
          // than re-persisted, so user agents never leak into the bundled allowlist.
          agents: bundledAgents.filter((a) => activeAgents.has(a.id)).map((a) => a.id),
          autonomy,
          conventionalCommits,
          budgetAware,
          // Only the two exposed knobs; the server deep-merges into the stored policy, so knobs
          // set via the API (dayWindow, minSessionHeadroomPct, …) survive a save from this form.
          budgetPolicy: { daytimeReservePct, weeklyTargetPct },
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        settings?: EditableSettings;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? "Save failed");
      // The new baseline is what the server STORED, not what we sent: the PATCH deep-merges
      // (budgetPolicy), prunes (half-filled variant rows, a missing reviewer we deliberately
      // omitted) and recomputes, so the response row is the only honest answer to "what is saved
      // now". Without this the form keeps diffing against the SSR snapshot for the rest of the
      // session. If the response somehow carries no row we leave the baseline alone rather than
      // guess — an over-eager clear would claim edits were persisted that may not have been.
      if (body?.settings) setBaseline(body.settings);
      toast.success("Settings saved");
      // The server tree still holds the pre-save row; refresh it so navigating away and back
      // doesn't restore stale values out of the router cache.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Settings</span>
        </div>
        {/* The count is the point, not the button: it names what a save will actually submit, from
            anywhere in the page. Automation is absent from it on purpose — it saves on change. */}
        <span className="ml-auto flex items-center gap-2.5">
          {dirtySections.length > 0 && (
            <span
              className="text-[11.5px] text-subtle"
              title={dirtySections.map((s) => s.label).join(", ")}
            >
              unsaved in{" "}
              <span className="text-primary">
                {dirtySections.length === 1
                  ? dirtySections[0].label.toLowerCase()
                  : `${dirtySections.length} sections`}
              </span>
            </span>
          )}
          <Button size="sm" onClick={save} disabled={saving || dirtySections.length === 0}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[192px_1fr]">
        {/* subnav — switches which panel renders, so every section is one click deep and none of
            them is reachable only by scrolling past two 8000-character textareas. */}
        <nav
          aria-label="Settings sections"
          className="flex flex-row flex-wrap gap-1 border-border p-3 md:flex-col md:flex-nowrap md:overflow-y-auto md:border-r md:p-4"
        >
          {SECTION_GROUPS.map((group) => (
            <div key={group} className="contents md:block">
              <span className="hidden px-2.5 pt-3 pb-1 font-mono text-[9.5px] tracking-[0.12em] text-subtle uppercase first:pt-0 md:block">
                {group}
              </span>
              {SECTIONS.filter((s) => s.group === group).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-current={active === s.id ? "true" : undefined}
                  onClick={() => showSection(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                    active === s.id
                      ? "bg-card font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                    s.id === "danger" && active !== s.id && "text-risk-high",
                  )}
                >
                  <span className="truncate">{s.label}</span>
                  {s.dirtyKeys.some((key) => dirty[key]) && (
                    <span
                      className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                      title="unsaved changes in this section"
                    />
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* panels — exactly one renders at a time, chosen by the nav */}
        <div className="flex flex-col gap-7 overflow-y-auto p-6 md:p-7">
          {active === "general" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-semibold">General</h2>
              {/* beads connection is status, not an editable field */}
              <BeadsStatus connected={project.hasBeads} />
            </div>
            <div className="grid max-w-xl grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field label="Name" value={project.name} />
              <Field label="Default branch" value={project.defaultBranch} mono />
              <Field label="Repository path" value={project.repoPath} mono className="sm:col-span-2" />
              <ModelField value={model} onChange={setModel} className="sm:col-span-2" />
            </div>
          </section>
          )}

          {/* Agents — the allowlist gates anton's bundled specialists; your own .claude/agents
              always run and are listed below as always-active (anton-dvo.1 reversal). */}
          {active === "agents" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Active agents</h2>
              <span className="text-xs text-subtle">which of anton&apos;s bundled agents dispatch may assign</span>
            </div>
            {bundledAgents.length === 0 ? (
              <p className="max-w-2xl text-xs text-subtle">No bundled agents available.</p>
            ) : (
              <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
                {bundledAgents.map((agent) => {
                  const on = activeAgents.has(agent.id);
                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5",
                        !on && "opacity-70",
                      )}
                      title={agent.description}
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", agentDotClass(agent.id))}
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-xs">{agent.id}</span>
                      <span className="ml-auto shrink-0">
                        <Toggle
                          checked={on}
                          onChange={() => toggleAgent(agent.id)}
                          label={`agent ${agent.id}`}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {userAgents.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="text-xs text-subtle">
                  always active · your own agents (<span className="font-mono">.claude/agents</span>{" "}
                  and installed plugins) — never gated by the allowlist
                </span>
                <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {userAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5"
                      title={agent.description}
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", agentDotClass(agent.id))}
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-xs">{agent.id}</span>
                      <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9.5px] text-subtle">
                        {agent.source}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
          )}

          {/* Prompt — locked base contract (read-only) + editable operator seed */}
          {active === "prompt" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Execution prompt</h2>
              <span className="text-xs text-subtle">what anton tells claude on every autonomous run</span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Seed prompt</span>
                <span className="text-[11px] text-subtle">editable · project-specific guidance</span>
                {seedPrompt.trim() !== (settings.seedPrompt ?? "").trim() && (
                  <span className="font-mono text-[10px] text-primary">unsaved</span>
                )}
              </div>
              <textarea
                value={seedPrompt}
                onChange={(e) => setSeedPrompt(e.target.value)}
                rows={6}
                maxLength={8000}
                placeholder="e.g. Prefer server components. Our design tokens live in src/styles/tokens.css. Never touch the legacy /v1 API."
                aria-label="Seed prompt"
                className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
              />
              <span className="text-[11px] text-subtle">
                Layered on top of the base contract below. It refines behavior — it can’t override
                the contract. Empty = base + agent prompt only. {seedPrompt.length}/8000
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Base contract</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  locked · always applied
                </span>
              </div>
              <pre className="max-h-64 max-w-2xl overflow-auto rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {basePrompt || "(base prompt unavailable)"}
              </pre>
              <span className="text-[11px] text-subtle">
                Core operating rules — git &amp; beads ownership, learnings capture, scope,
                fail-loud. Defined in code; not editable here.
              </span>
            </div>
          </section>
          )}

          {/* Review-fix — how claude answers a PR's review, grouped with the other things that
              happen after the work is written rather than with the run's own seed prompt. */}
          {active === "review-fix" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Review-fix</h2>
              <span className="text-xs text-subtle">
                how claude resolves feedback on an open PR
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Review-fix prompt</span>
                <span className="text-[11px] text-subtle">editable · how claude resolves PR feedback</span>
                {reviewFixPrompt.trim() !== (settings.reviewFixPrompt ?? "").trim() && (
                  <span className="font-mono text-[10px] text-primary">unsaved</span>
                )}
              </div>
              <textarea
                value={reviewFixPrompt}
                onChange={(e) => setReviewFixPrompt(e.target.value)}
                rows={6}
                maxLength={8000}
                placeholder="Override the default review-fix reasoning prompt. Empty = anton's shipped default (skills/review-fix/SKILL.md)."
                aria-label="Review-fix prompt"
                className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
              />
              <span className="text-[11px] text-subtle">
                The reasoning contract for the review-fix job. anton appends the concrete PR context
                (comments, failing checks) beneath it. Empty = shipped default. {reviewFixPrompt.length}/8000
              </span>
            </div>
          </section>
          )}

          {/* Verify gates — operator-pinned hard checks run in the worktree before commit */}
          {active === "gates" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Verify gates</h2>
              <span className="text-xs text-subtle">
                deterministic checks anton runs after the agent, before commit · non-zero exit fails
                the ticket
              </span>
            </div>
            <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
              <GateField
                label="Test command"
                value={testCommand}
                onChange={setTestCommand}
                placeholder="e.g. bun run test"
              />
              <GateField
                label="Lint command"
                value={lintCommand}
                onChange={setLintCommand}
                placeholder="e.g. bun run lint"
              />
              <GateField
                label="Typecheck command"
                value={typecheckCommand}
                onChange={setTypecheckCommand}
                placeholder="e.g. bun run typecheck"
              />
              <GateField
                label="Build command"
                value={buildCommand}
                onChange={setBuildCommand}
                placeholder="e.g. bun run build"
              />
            </div>
            <span className="max-w-2xl text-[11px] text-subtle">
              Each gate runs in the ticket&apos;s worktree in order (test → lint → typecheck →
              build). Empty = skipped. These are the operator-pinned backstop; the agent still
              self-verifies. The same gates run before review-fix pushes.
            </span>
          </section>
          )}

          {/* Pipeline variants — let the work's own labels pick the pipeline (anton-aa3m) */}
          {active === "variants" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Pipeline variants</h2>
              <span className="text-xs text-subtle">
                run a different formula for beads carrying a label · first match wins
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              {variantRows.length === 0 ? (
                <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[11.5px] text-subtle">
                  No variants — every run walks{" "}
                  <code className="font-mono text-[11px]">.beads/formulas/anton-run.formula.toml</code>.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {variantRows.map((row, i) => (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-2"
                    >
                      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-subtle">
                        {i + 1}
                      </span>
                      <input
                        type="text"
                        value={row.label}
                        onChange={(e) => patchVariant(row.id, { label: e.target.value })}
                        placeholder="risk:high"
                        maxLength={120}
                        aria-label={`Variant ${i + 1} label`}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                      />
                      <ArrowRightIcon className="size-3 shrink-0 text-subtle" aria-hidden="true" />
                      <input
                        type="text"
                        value={row.formula}
                        onChange={(e) => patchVariant(row.id, { formula: e.target.value })}
                        placeholder="anton-run-risk-high"
                        maxLength={120}
                        aria-label={`Variant ${i + 1} formula`}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => moveVariant(row.id, -1)}
                        disabled={i === 0}
                        aria-label={`Move variant ${i + 1} up`}
                      >
                        <ChevronUpIcon aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => moveVariant(row.id, 1)}
                        disabled={i === variantRows.length - 1}
                        aria-label={`Move variant ${i + 1} down`}
                      >
                        <ChevronDownIcon aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => setVariantRows((rows) => rows.filter((r) => r.id !== row.id))}
                        aria-label={`Remove variant ${i + 1}`}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() =>
                  setVariantRows((rows) => [
                    ...rows,
                    { id: `new-${nextVariantId.current++}`, label: "", formula: "" },
                  ])
                }
              >
                <PlusIcon aria-hidden="true" />
                Add variant
              </Button>
            </div>

            <span className="max-w-2xl text-[11px] text-subtle">
              A run target carrying a mapped label walks{" "}
              <code className="font-mono text-[11px]">.beads/formulas/&lt;formula&gt;.formula.toml</code>{" "}
              instead of the default — so <code className="font-mono text-[11px]">risk:high</code> can
              carry extra steps and a docs-only ticket can skip verify. Two mapped labels on one bead?
              The first row wins, which is why order is editable. Every variant is held to the same
              floor as the default (implement → commit → PR); a missing or floor-violating one parks
              the run instead of silently falling back.
            </span>
          </section>
          )}

          {/* Self-review — the pre-PR gate (anton-3apm): on by default, reviewer swappable for one
              of this project's agents or a raw prompt. */}
          {active === "review" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Self-review</h2>
              <span className="text-xs text-subtle">
                a fresh-context review of each run&apos;s diff, before the PR opens
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-card px-3 py-3">
              <div className="flex items-center gap-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px]">Review before opening the PR</span>
                  <span className="text-[10.5px] text-subtle">
                    findings are fixed in a bounded loop · on by default
                  </span>
                </div>
                <span className="ml-auto">
                  <Toggle
                    checked={reviewEnabled}
                    onChange={setReviewEnabled}
                    label="Review before opening the PR"
                  />
                </span>
              </div>

              <div
                className={cn(
                  "flex flex-col gap-3 transition-opacity",
                  !reviewEnabled && "opacity-50",
                )}
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ReviewerField
                    value={reviewAgent}
                    onChange={setReviewAgent}
                    agents={agents}
                    disabled={!reviewEnabled}
                  />
                  <CountField
                    label="Max review rounds"
                    value={reviewMaxRounds}
                    onChange={setReviewMaxRounds}
                    min={REVIEW_MAX_ROUNDS_MIN}
                    max={REVIEW_MAX_ROUNDS_MAX}
                    fallback={DEFAULT_REVIEW_MAX_ROUNDS}
                    disabled={!reviewEnabled}
                    hint={`review → fix → re-review · default ${DEFAULT_REVIEW_MAX_ROUNDS}`}
                  />
                </div>

                {/* Score-regression alarm (anton-i98r) — a policy of its own, not another rounds
                    knob: it decides when anton stops fixing and hands the run back. */}
                <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background/40 px-3 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-medium">Score-regression alarm</span>
                    {/* A streak longer than the round cap can never be reached — the loop stops at
                        the cap first — so the contradiction is named here, not left to the save's 400. */}
                    <span
                      className={cn(
                        "text-[11px]",
                        reviewMinScore !== REVIEW_MIN_SCORE_MIN && reviewLowScoreRounds > reviewMaxRounds
                          ? "text-risk-high"
                          : "text-subtle",
                      )}
                    >
                      {reviewMinScore === REVIEW_MIN_SCORE_MIN
                        ? "off · the loop runs to the round cap whatever it scores"
                        : reviewLowScoreRounds > reviewMaxRounds
                          ? `never fires · ${reviewLowScoreRounds} low rounds can't happen in ${reviewMaxRounds} review round${reviewMaxRounds === 1 ? "" : "s"}`
                          : `park after ${reviewLowScoreRounds} round${reviewLowScoreRounds === 1 ? "" : "s"} below ${reviewMinScore}/10`}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <CountField
                      label="Minimum score"
                      value={reviewMinScore}
                      onChange={setReviewMinScore}
                      min={REVIEW_MIN_SCORE_MIN}
                      max={REVIEW_MIN_SCORE_MAX}
                      fallback={DEFAULT_REVIEW_MIN_SCORE}
                      disabled={!reviewEnabled}
                      hint={`0 turns the alarm off · default ${DEFAULT_REVIEW_MIN_SCORE}`}
                    />
                    <CountField
                      label="Consecutive low rounds"
                      value={reviewLowScoreRounds}
                      onChange={setReviewLowScoreRounds}
                      min={REVIEW_LOW_SCORE_ROUNDS_MIN}
                      max={REVIEW_LOW_SCORE_ROUNDS_MAX}
                      fallback={DEFAULT_REVIEW_LOW_SCORE_ROUNDS}
                      disabled={!reviewEnabled || reviewMinScore === REVIEW_MIN_SCORE_MIN}
                      hint={`a round at or above the minimum resets the streak · default ${DEFAULT_REVIEW_LOW_SCORE_ROUNDS}`}
                    />
                  </div>
                  <span className="text-[11px] text-subtle">
                    Sustained low scores are a decision for you, not another fix round: when the
                    streak trips, anton stops the loop, opens no PR, and parks the run with the score
                    series attached.
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium">Review prompt</span>
                    <span className="text-[11px] text-subtle">
                      {reviewAgent ? "fallback · unused while a reviewer is named" : "editable · what to review for"}
                    </span>
                    {reviewPrompt.trim() !== (settings.reviewPrompt ?? "").trim() && (
                      <span className="font-mono text-[10px] text-primary">unsaved</span>
                    )}
                  </div>
                  <textarea
                    value={reviewPrompt}
                    onChange={(e) => setReviewPrompt(e.target.value)}
                    rows={5}
                    maxLength={8000}
                    disabled={!reviewEnabled}
                    placeholder="Override the default review contract. Empty = anton's shipped default (skills/review)."
                    aria-label="Review prompt"
                    className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60 disabled:cursor-not-allowed"
                  />
                  <span className="text-[11px] text-subtle">
                    The reasoning contract for the reviewer. anton appends the run&apos;s diff and
                    tickets beneath it.{" "}
                    {reviewAgent
                      ? `${reviewAgent} brings its own contract, so this runs only if that agent can't be loaded.`
                      : "Empty = shipped default (skills/review)."}{" "}
                    {reviewPrompt.length}/8000
                  </span>
                </div>
              </div>
            </div>
          </section>
          )}

          {/* Execution — concurrency, timeouts, retries and the budget policy. Its own panel now,
              not half a two-column grid shared with Automation. */}
          {active === "execution" && (
          <div className="grid max-w-3xl grid-cols-1 gap-7">
            <section className="flex flex-col gap-3.5">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[15px] font-semibold">Concurrency &amp; limits</h2>
                <span className="text-xs text-subtle">
                  how much runs at once, and when anton gives up on one
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between">
                  <span className="text-[12.5px] text-muted-foreground">Max concurrent runs</span>
                  <span className="font-mono text-[12.5px] text-primary">{concurrency}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={6}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  aria-label="Max concurrent runs"
                  className="accent-primary"
                />
                <span className="text-[11px] text-subtle">1 — 6 · worktrees run in parallel</span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted-foreground">Job timeout</span>
                  <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
                    <input
                      type="number"
                      min={5}
                      max={720}
                      value={jobTimeoutMinutes}
                      onChange={(e) => setJobTimeoutMinutes(Number(e.target.value))}
                      aria-label="Job timeout in minutes"
                      className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-9 font-mono text-[12.5px] text-foreground outline-none"
                    />
                    <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">
                      min
                    </span>
                  </div>
                  <span className="text-[11px] text-subtle">
                    without progress · default 120 (2h)
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted-foreground">Ticket timeout</span>
                  <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
                    <input
                      type="number"
                      min={5}
                      max={240}
                      value={ticketTimeoutMinutes}
                      onChange={(e) => setTicketTimeoutMinutes(Number(e.target.value))}
                      aria-label="Ticket timeout in minutes"
                      className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-9 font-mono text-[12.5px] text-foreground outline-none"
                    />
                    <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">
                      min
                    </span>
                  </div>
                  <span className="text-[11px] text-subtle">
                    per ticket · blocks it, run continues · default 45
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted-foreground">Retries</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                    aria-label="Max retries"
                    className="rounded-[10px] border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-primary/60"
                  />
                  <span className="text-[11px] text-subtle">attempts before parking · default 3</span>
                </label>
              </div>

              <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px]">Autonomous execution</span>
                  <span className="text-[10.5px] text-subtle">run approved epics without asking</span>
                </div>
                <span className="ml-auto">
                  <Toggle checked={autonomy} onChange={setAutonomy} label="Autonomous execution" />
                </span>
              </div>

              <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px]">Conventional-commit PR titles</span>
                  <span className="text-[10.5px] text-subtle">
                    prefix epic PR titles with feat/fix(scope)
                  </span>
                </div>
                <span className="ml-auto">
                  <Toggle
                    checked={conventionalCommits}
                    onChange={setConventionalCommits}
                    label="Conventional-commit PR titles"
                  />
                </span>
              </div>

              <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12.5px]">Budget-aware execution</span>
                    <span className="text-[10.5px] text-subtle">
                      use idle Claude capacity up to a weekly cap · off by default
                    </span>
                  </div>
                  <span className="ml-auto">
                    <Toggle
                      checked={budgetAware}
                      onChange={setBudgetAware}
                      label="Budget-aware execution"
                    />
                  </span>
                </div>
                <div
                  className={cn(
                    "grid grid-cols-2 gap-3 transition-opacity",
                    !budgetAware && "pointer-events-none opacity-50",
                  )}
                  aria-hidden={!budgetAware}
                >
                  <PctField
                    label="Daytime reserve"
                    value={daytimeReservePct}
                    onChange={setDaytimeReservePct}
                    hint="session held back for interactive daytime use"
                    disabled={!budgetAware}
                  />
                  <PctField
                    label="Weekly cap"
                    value={weeklyTargetPct}
                    onChange={setWeeklyTargetPct}
                    hint="run freely below this, then stop until reset"
                    disabled={!budgetAware}
                    // 0 would disable the weekly cap (no pace data), not cap at zero — server rejects it.
                    min={1}
                  />
                </div>
              </div>
            </section>
          </div>
          )}

          {/* Automation — full width, because seven schedules are records with identical fields and
              a table is how you compare them (anton-ue90.4). */}
          {active === "automation" && (
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Automation</h2>
              <span className="text-xs text-subtle">what anton does on its own, and how often</span>
            </div>
            <AutomationTable
              automations={AUTOMATIONS}
              state={automations}
              defaultCrons={defaultCrons}
              onCronChange={setAutomationCron}
              onToggle={toggleAutomation}
            />
          </section>
          )}

          {/* Danger zone */}
          {active === "danger" && (
          <section className="flex max-w-2xl flex-col gap-3.5">
            <h2 className="text-[15px] font-semibold text-risk-high">Danger zone</h2>
            <div className="flex items-center gap-3.5 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold text-risk-high">Delete project</span>
                <span className="text-xs text-muted-foreground">
                  Destroys anton&apos;s state — settings, runs, worktrees. Repo &amp; beads are
                  untouched.
                </span>
              </div>
              <span className="ml-auto">
                <DeleteProjectDialog project={project} />
              </span>
            </div>
            {/* Prune closed beads (anton-uobe): permanent deletion, gated behind preview + confirm */}
            <div className="flex flex-col gap-3 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold text-risk-high">Prune closed beads</span>
                <span className="text-xs text-muted-foreground">
                  Permanently deletes piled-up closed beads (they bloat the export and slow
                  queries). Open and in-progress beads are never touched.
                </span>
              </div>
              <PruneBeadsSection project={project} />
            </div>
          </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Order-insensitive id-set equality — the allowlist is a set, so a reorder is not an edit. */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}

/**
 * Variant equality, compared the way the save serializes: trimmed, and half-filled scaffolding rows
 * dropped. Order IS significant here — the list's order is the precedence an operator tunes, so
 * moving a row is a real edit even though the set is unchanged.
 */
function sameVariants(rows: VariantRow[], stored: FormulaVariant[]): boolean {
  const staged = rows
    .map((v) => ({ label: v.label.trim(), formula: v.formula.trim() }))
    .filter((v) => v.label && v.formula);
  if (staged.length !== stored.length) return false;
  return staged.every((v, i) => v.label === stored[i].label && v.formula === stored[i].formula);
}

function Field({
  label,
  value,
  mono = false,
  chevron = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  chevron?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <div
        className={cn(
          "flex items-center rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]",
          mono && "font-mono",
        )}
      >
        <span className="truncate" title={value}>
          {value}
        </span>
        {chevron && <span className="ml-auto text-subtle">▾</span>}
      </div>
    </div>
  );
}

/** Editable verify-gate command (anton-3oh8). Persists to settingsJson.*Command; "" clears it. */
function GateField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={1000}
        aria-label={label}
        className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </label>
  );
}

/** A min–100 integer percentage knob for the budget policy (anton-egrg). Clamps on change. */
function PctField({
  label,
  value,
  onChange,
  hint,
  disabled = false,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
  disabled?: boolean;
  min?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
        <input
          type="number"
          step={1}
          min={min}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? Math.min(100, Math.max(min, Math.round(n))) : min);
          }}
          aria-label={label}
          className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-8 font-mono text-[12.5px] text-foreground outline-none disabled:cursor-not-allowed"
        />
        <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">%</span>
      </div>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}

/**
 * A clamped integer knob for the self-review section — max rounds, and the two score-alarm
 * thresholds (anton-i98r). Clamps on change like {@link PctField}, so a typed-in 99 lands on the
 * bound the API would have rejected instead of round-tripping as a 400.
 */
function CountField({
  label,
  value,
  onChange,
  min,
  max,
  fallback,
  hint,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Where a cleared or unparseable input lands — the shipped default for this knob. */
  fallback: number;
  hint: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <input
        type="number"
        step={1}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(
            Number.isFinite(n) && e.target.value !== ""
              ? Math.min(max, Math.max(min, Math.round(n)))
              : fallback,
          );
        }}
        aria-label={label}
        className="rounded-[10px] border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-primary/60 disabled:cursor-not-allowed"
      />
      <span className="text-[11px] text-subtle">{hint}</span>
    </label>
  );
}

/** A stored reviewer id that no longer resolves to a discoverable agent — shown, never resubmitted. */
function reviewerMissing(value: string, agents: DiscoveredAgent[]): boolean {
  return value !== "" && !agents.some((a) => a.id === value);
}

/**
 * Reviewer selector for the self-review gate (anton-3apm). Persists to settingsJson.reviewAgent;
 * "" runs the shipped review contract. Any discoverable agent may review — bundled or the
 * operator's own — since the reviewer is deliberately swappable, not gated by the active-agents
 * allowlist. A persisted id that no longer resolves is kept as an option so the operator can see
 * what's stored (and that it's gone) instead of the field silently reading as "Default" — the save
 * omits it rather than resubmitting an id the API rejects (see {@link reviewerMissing}).
 */
function ReviewerField({
  value,
  onChange,
  agents,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  agents: DiscoveredAgent[];
  disabled?: boolean;
}) {
  const missing = reviewerMissing(value, agents);
  const hint = agents.find((a) => a.id === value)?.description;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">Reviewer</span>
      <div className="relative flex items-center rounded-[10px] border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Reviewer"
          className="w-full appearance-none rounded-[10px] bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none disabled:cursor-not-allowed"
        >
          <option value="">Default · anton&apos;s review contract</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} · {a.source}
            </option>
          ))}
          {missing && <option value={value}>{value} · missing</option>}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
      <span className="line-clamp-2 text-[11px] text-subtle" title={missing ? undefined : hint}>
        {missing
          ? "This agent no longer exists — review falls back to the shipped contract. Pick another to replace it."
          : (hint ?? "any agent this project can assign · runs in a fresh context")}
      </span>
    </div>
  );
}

/** Default-model selector. Persists to settingsJson.model; "" runs claude with no --model. */
function ModelField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const hint = MODELS.find((m) => m.value === value)?.hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">Default model</span>
      <div className="relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Default model"
          className="w-full appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none"
        >
          {MODELS.map((m) => (
            <option key={m.value || "default"} value={m.value}>
              {m.label}
              {m.value ? ` · ${m.value}` : ""}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </div>
  );
}

/** beads connection shown as a status pill, not an editable field. */
function BeadsStatus({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        connected
          ? "border-stage-done/30 bg-stage-done/10 text-stage-done"
          : "border-risk-high/30 bg-risk-high/10 text-risk-high",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", connected ? "bg-stage-done" : "bg-risk-high")}
        aria-hidden="true"
      />
      beads {connected ? "connected" : "missing"}
    </span>
  );
}

