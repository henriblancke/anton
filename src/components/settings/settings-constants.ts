import type { AutomationSpec } from "@/components/settings/automation-table";

// Defaults mirror the server (src/lib/projects.ts DEFAULT_*); duplicated so this client module
// stays server-import-free. Keep in sync.
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2h without progress
export const DEFAULT_TICKET_TIMEOUT_MINUTES = 45;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_REVIEW_MAX_ROUNDS = 2;
export const REVIEW_MAX_ROUNDS_MIN = 1;
export const REVIEW_MAX_ROUNDS_MAX = 5;
// Score-regression alarm (anton-i98r). A min score of 0 is the off switch — no review can score
// below zero — which is why the min of the range is 0 rather than 1.
export const DEFAULT_REVIEW_MIN_SCORE = 5;
export const REVIEW_MIN_SCORE_MIN = 0;
export const REVIEW_MIN_SCORE_MAX = 10;
export const DEFAULT_REVIEW_LOW_SCORE_ROUNDS = 2;
export const REVIEW_LOW_SCORE_ROUNDS_MIN = 1;
export const REVIEW_LOW_SCORE_ROUNDS_MAX = 5;
// Autopilot brakes (anton-nmy7). 0 is the OFF switch on three of the four — a limit, a streak or a
// floor of zero can never be reached — which is why those ranges start at 0 rather than 1.
export const DEFAULT_AUTOPILOT_WIP_LIMIT = 3;
export const AUTOPILOT_WIP_LIMIT_MIN = 0;
export const AUTOPILOT_WIP_LIMIT_MAX = 20;
export const DEFAULT_AUTOPILOT_FAILURE_STREAK = 3;
export const AUTOPILOT_FAILURE_STREAK_MIN = 0;
export const AUTOPILOT_FAILURE_STREAK_MAX = 10;
export const DEFAULT_AUTOPILOT_SCORE_FLOOR = 7;
export const AUTOPILOT_SCORE_FLOOR_MIN = 0;
export const AUTOPILOT_SCORE_FLOOR_MAX = 10;
export const DEFAULT_AUTOPILOT_SCORE_WINDOW = 3;
export const AUTOPILOT_SCORE_WINDOW_MIN = 1;
export const AUTOPILOT_SCORE_WINDOW_MAX = 10;
// Mirror DEFAULT_PROJECT_BUDGET_POLICY (src/lib/projects.ts) for the two operator-facing knobs.
export const DEFAULT_DAYTIME_RESERVE_PCT = 15;
export const DEFAULT_WEEKLY_TARGET_PCT = 90;

/** Default model options for the headless claude driver. Empty value = the CLI's own default. */
export const MODELS: { value: string; label: string; hint?: string }[] = [
  { value: "", label: "Default", hint: "use claude's configured model" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "most capable" },
  { value: "claude-sonnet-5", label: "Sonnet 5", hint: "balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest" },
  { value: "claude-fable-5", label: "Fable 5", hint: "frontier" },
];

// What each scheduled automation DOES, and what makes it idle. Ids match the schedule row `type`.
// Cadence, next-run time, last-run time and enabled state all come from the schedules row — never
// from copy here, which could disagree with the row that actually fires.
export const AUTOMATIONS: AutomationSpec[] = [
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
    description: "hygiene patrol · closes done epics · proposes the rest, applies what you armed",
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
    id: "board-picker",
    label: "board-picker",
    description: "ranks what could run next · records the plan · starts nothing yet",
    group: "Board maintenance",
  },
  {
    id: "product-master",
    label: "product-master",
    description: "product judgment · proposes reprioritize / split / kill · applies what you armed",
    group: "Board maintenance",
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
export const SCHEDULE_POLL_MS = 30_000;
