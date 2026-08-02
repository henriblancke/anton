/**
 * Pure helpers for the run-detail view (anton-qbz.2/.3). Extracted so the terminal-attach rule and
 * time formatting are unit-testable without a browser/jsdom (the view itself renders xterm).
 */

export type RunStatus = "queued" | "running" | "parked" | "done" | "failed";
export type SessionStatus = "running" | "done" | "failed";
/** Mirrors the `SessionKind` union in `src/lib/sessions.ts` for the kinds a run can surface. */
export type SessionKind = "shape" | "execute" | "review" | "review-fix" | "interactive";

export interface SessionSummary {
  id: string;
  runId?: string;
  kind: SessionKind;
  beadId?: string;
  status: SessionStatus;
  startedAt?: number;
  endedAt?: number;
}

/** Run statuses that are still in flight — drives polling + the "live" terminal label. */
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "running", "parked"];

export function isActiveRun(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * Which session the terminal attaches to. An explicit user selection wins (if still present);
 * otherwise the running session (there's at most one live at a time), else the most recent.
 * `sessions` is newest-first (as listSessions returns), so [0] is the latest. Returns null for a
 * run with no sessions yet.
 */
export function pickAttachSession(
  sessions: SessionSummary[],
  selectedId: string | null,
): string | null {
  if (sessions.length === 0) return null;
  if (selectedId && sessions.some((s) => s.id === selectedId)) return selectedId;
  const running = sessions.find((s) => s.status === "running");
  return (running ?? sessions[0]).id;
}

/** Sessions in chronological (oldest-first) order for the timeline. Non-mutating. */
export function timelineOrder(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/**
 * What a run records instead of anton's install-absolute bundled path (`BUNDLED_FORMULA_SOURCE` in
 * `lib/jobs/run-formula.ts`). Duplicated as a literal so this module stays free of node-only imports;
 * `run-view-utils.test.ts` pins the two in sync.
 */
const BUNDLED_FORMULA_SOURCE = "bundled:anton-run";

/**
 * How the meta grid names the pipeline a run walked (anton-aa3m): the formula file, and — when a
 * per-label variant selected it — the bead label that did. The full path rides in the row's title,
 * so this stays the glanceable form. No formula recorded (a run from before this was tracked, or one
 * that parked before selection) reads as "—" rather than pretending the default was used.
 */
export function formatRunPipeline(formula?: string, variant?: string): string {
  if (!formula) return "—";
  // The sentinel is a durable identity, not a path — name the default in the operator's words.
  const file =
    formula === BUNDLED_FORMULA_SOURCE
      ? "anton-run.formula.toml (anton's default)"
      : formula.split("/").pop() || formula;
  return variant ? `${file} · ${variant}` : file;
}

export function fmtDuration(from?: number, to?: number, nowMs: number = Date.now()): string {
  if (from == null) return "—";
  const end = to ?? Math.floor(nowMs / 1000);
  const s = Math.max(0, end - from);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
