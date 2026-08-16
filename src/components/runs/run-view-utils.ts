/**
 * The run view's shared vocabulary and pure helpers (anton-qbz.2/.3). Two jobs:
 *
 * 1. It is the single declaration of the run shape and its statuses. `src/lib/runs.ts` imports
 *    these rather than re-declaring them (anton-f3qj) — the dependency points server -> client-safe,
 *    never the reverse, so a client module can name a run without dragging better-sqlite3 into the
 *    browser bundle. Nothing here may import a node builtin or a db module — enforced by the
 *    `no-restricted-imports` override for this file in `eslint.config.mjs`.
 * 2. The terminal-attach rule and time formatting live here so they are unit-testable without a
 *    browser/jsdom (the view itself renders xterm).
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

/** A run as the list view and the runs API surface it. */
export interface RunSummary {
  id: string;
  epicBeadId: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  status: RunStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

/** Full run summary including its lease/error/pipeline, for the run meta grid. */
export interface RunDetail extends RunSummary {
  leaseExpiresAt?: number;
  error?: string;
  /** The pipeline this run walked — the formula file it was read from (anton-aa3m). */
  formula?: string;
  /** The bead label that selected that pipeline; absent ⇒ the project/bundled default. */
  formulaVariant?: string;
}

/**
 * Run statuses that are still in flight. One list, two readings that are the same predicate: the
 * view polls and labels the terminal "live" for these, and the runner treats exactly these as
 * resumable when it looks for an open run to rejoin rather than starting a duplicate.
 */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "parked"];

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
