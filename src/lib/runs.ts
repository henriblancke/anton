/**
 * Read-only access to the machine-local `runs` table. Runs are execution plumbing (worktree,
 * lease, model, agent); stage/PR live in beads. See DESIGN.md §3.
 */
import { and, count, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { toEpoch } from "./db/epoch";
import type { AntonDb, Clock } from "./jobs/queue";
import {
  ACTIVE_RUN_STATUSES,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type RunWarmOutcome,
} from "@/components/runs/run-view-utils";

/**
 * The run vocabulary is declared once, in the client-safe module, and imported here — never the
 * reverse (anton-f3qj). Re-exported so server callers keep asking `@/lib/runs` for it.
 */
export type { RunDetail, RunStatus, RunSummary, RunWarmOutcome };

export type RunRow = typeof schema.runs.$inferSelect;

/**
 * What an unrouted run records for its endpoint (anton-oom5): the Anthropic direct host, stored
 * explicitly so an unrouted new row and a pre-column NULL row are never confusable.
 */
export const ANTHROPIC_DEFAULT_ENDPOINT_HOST = "api.anthropic.com";

/**
 * The endpoint host a run drove, derived from a routing base URL (anton-oom5). The HOST only —
 * `URL.host` carries hostname and port but never userinfo, so a base URL of the form
 * `https://user:token@gateway:20128/v1` yields `gateway:20128` and the stored provenance can never
 * leak the token. A missing or unparseable base URL is an unrouted run, which records the Anthropic
 * default; falling back to the default on a parse failure keeps a malformed config from ever
 * storing raw URL text (and its possible credentials).
 */
export function endpointHostFromBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl || !baseUrl.trim()) return ANTHROPIC_DEFAULT_ENDPOINT_HOST;
  try {
    return new URL(baseUrl).host || ANTHROPIC_DEFAULT_ENDPOINT_HOST;
  } catch {
    return ANTHROPIC_DEFAULT_ENDPOINT_HOST;
  }
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toSummary(row: typeof schema.runs.$inferSelect): RunSummary {
  return {
    id: row.id,
    epicBeadId: row.epicBeadId,
    ticketBeadId: row.ticketBeadId ?? undefined,
    worktreePath: row.worktreePath ?? undefined,
    branch: row.branch ?? undefined,
    model: row.model ?? undefined,
    agentTag: row.agentTag ?? undefined,
    endpointHost: row.endpointHost ?? undefined,
    status: row.status as RunStatus,
    attempts: row.attempts,
    startedAt: toEpoch(row.startedAt),
    endedAt: toEpoch(row.endedAt),
    updatedAt: toEpoch(row.updatedAt) ?? 0,
  };
}

export async function listRuns(projectId: string): Promise<RunSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.updatedAt));
  return rows.map(toSummary);
}

/** Total run rows for a project — for pagination. */
export async function countRuns(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId));
  return rows[0]?.n ?? 0;
}

/** One page of runs, newest activity first. */
export async function listRunsPaged(
  projectId: string,
  opts: { limit: number; offset: number },
): Promise<RunSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.updatedAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(toSummary);
}

function toDetail(row: typeof schema.runs.$inferSelect): RunDetail {
  return {
    ...toSummary(row),
    leaseExpiresAt: toEpoch(row.leaseExpiresAt),
    attemptStartedAt: toEpoch(row.attemptStartedAt),
    error: row.error ?? undefined,
    structuralError: row.structuralError ?? undefined,
    jobId: row.jobId ?? undefined,
    reviewScore: row.reviewScore ?? undefined,
    formula: row.formula ?? undefined,
    formulaVariant: row.formulaVariant ?? undefined,
    ...toWarm(row),
  };
}

/**
 * The warm columns as the detail view reads them (anton-rqwy8). The column is free text, so an
 * outcome this build doesn't know is dropped rather than narrowed by assertion — a stored value
 * from a newer writer must not make the view render a word it has no rule for. Null stays absent:
 * "never attempted" is not an outcome.
 */
function toWarm(row: typeof schema.runs.$inferSelect): Pick<RunDetail, "warmOutcome" | "warmCommand" | "warmError"> {
  const outcome = RUN_WARM_OUTCOMES.find((o) => o === row.warmOutcome);
  if (!outcome) return {};
  return {
    warmOutcome: outcome,
    warmCommand: row.warmCommand ?? undefined,
    warmError: row.warmError ?? undefined,
  };
}

/** The outcome vocabulary `warmOutcome` is validated against on read — see the column's own note. */
const RUN_WARM_OUTCOMES: readonly RunWarmOutcome[] = ["ok", "failed", "skipped", "disabled"];

export async function getRunDetail(
  projectId: string,
  runId: string,
): Promise<RunDetail | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)))
    .limit(1);
  const row = rows[0];
  return row ? toDetail(row) : undefined;
}

// ── Write path (anton-dzh.5): db-injectable so the runner/tests share one connection ──

/**
 * The next value of the `runs.write_seq` counter, taken inside the statement that writes the row —
 * SQLite serializes writers, so MAX+1 is atomic there and needs no separate sequence table.
 *
 * Stamped by EVERY write path below, without exception: the column is only settlement order
 * (see its note in schema.ts) because a settled run's last write is its settlement, and a write
 * that skipped the stamp would leave that run ordered by the second-granular proxy instead.
 */
function nextWriteSeq() {
  return sql`(SELECT IFNULL(MAX(w.write_seq), 0) + 1 FROM runs w)`;
}

export interface CreateRunInput {
  id: string;
  projectId: string;
  epicBeadId: string;
  /** The execute-epic job starting this attempt (anton-rgso) — see the column's own note. */
  jobId?: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  /**
   * The endpoint host this run drove (anton-oom5). Already reduced to a host by
   * `endpointHostFromBaseUrl` — the write path never sees a token. Omitted ⇒ the Anthropic default,
   * so an unrouted run records the endpoint just as explicitly as a routed one.
   */
  endpointHost?: string;
  status?: RunStatus;
}

/** Record a run at the start of execution (status defaults to `running`, startedAt = now). */
export async function createRun(db: AntonDb, clock: Clock, input: CreateRunInput): Promise<string> {
  const nowMs = clock.now();
  await db.insert(schema.runs).values({
    id: input.id,
    projectId: input.projectId,
    epicBeadId: input.epicBeadId,
    jobId: input.jobId,
    ticketBeadId: input.ticketBeadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    model: input.model,
    agentTag: input.agentTag,
    endpointHost: input.endpointHost ?? ANTHROPIC_DEFAULT_ENDPOINT_HOST,
    status: input.status ?? "running",
    startedAt: secDate(nowMs),
    attemptStartedAt: secDate(nowMs),
    updatedAt: secDate(nowMs),
    writeSeq: nextWriteSeq(),
  });
  return input.id;
}

export type RunPatch = Partial<{
  status: RunStatus;
  /** Rewritten on every resume: the job behind the attempt is the one a cancel would name. */
  jobId: string | null;
  ticketBeadId: string | null;
  worktreePath: string | null;
  branch: string | null;
  model: string | null;
  agentTag: string | null;
  /**
   * The endpoint host this run drove (anton-oom5). Rewritten on resume: a parked run reopened after
   * its project's gateway setting changed drives the newly resolved endpoint, so the recorded
   * provenance must move with it rather than attribute resumed traffic to the old route.
   */
  endpointHost: string;
  /** The pipeline this run walked (anton-aa3m) — written once the formula is selected + validated. */
  formula: string | null;
  formulaVariant: string | null;
  /** The commit this run's branch forked from, pinned at worktree creation (anton-5bpd) — see schema. */
  baseForkSha: string | null;
  /** What refreshOntoBase did to a reused checkout at warm, and the base it settled on (anton-s55u) — see schema. */
  baseRefreshOutcome: string | null;
  baseRefreshSha: string | null;
  /** The branch's tip just before a still-pending refresh above was attempted (anton-s55u) — see schema. */
  pendingRefreshFromSha: string | null;
  /** The specific git operation a still-pending refresh above is mutating with (anton-s55u) — see schema. */
  pendingRefreshKind: string | null;
  /** This row's own last effective refresh boundary, snapshotted before it goes pending (anton-s55u) — see schema. */
  priorBaseRefreshSha: string | null;
  /**
   * What warming did to this run's checkout, and — on a failure — which command failed and the tail
   * of what it said (anton-jyrhf). Written once, right after warming returns, so the cause is
   * queryable at the moment it occurs rather than inferred from a later symptom. See the columns'
   * own notes for the vocabulary; nulls are meaningful (never attempted) and are never backfilled.
   */
  warmOutcome: string | null;
  warmCommand: string | null;
  warmError: string | null;
  attempts: number;
  error: string | null;
  /** Anton's own account of why the run stopped, held apart from `error` above (anton-4kvp) — see schema. */
  structuralError: string | null;
  /** The score this attempt's review gate reported (anton-cekf) — see the column's own note. */
  reviewScore: number | null;
  /** A clean verdict's resume key (anton-qmuyt) — see the column's own note. */
  reviewKey: string | null;
  /** The clean verdict's advisories, serialized — restored into the carry when a resume skips. */
  reviewKeyAdvisories: string | null;
  /** The score bound to `reviewKey` above — see the column's own note. */
  reviewKeyScore: number | null;
  /** The run's PR narrative, serialized — see the column's own note. */
  narrative: string | null;
  /** ms; converted to seconds. Rewritten by a resume — see the column's own note. */
  attemptStartedAt: number;
  endedAt: number; // ms; converted to seconds
  /** Whether a `done` settle actually published a pull request — see the column's own note. */
  delivered: boolean;
}>;

/** Patch a run row (touches updatedAt). Pass endedAt (ms) to close it out. */
export async function updateRun(
  db: AntonDb,
  clock: Clock,
  id: string,
  patch: RunPatch,
): Promise<void> {
  const set: Record<string, unknown> = {
    updatedAt: secDate(clock.now()),
    writeSeq: nextWriteSeq(),
  };
  for (const [k, v] of Object.entries(patch)) {
    if ((k === "endedAt" || k === "attemptStartedAt") && typeof v === "number") set[k] = secDate(v);
    else set[k] = v;
  }
  await db.update(schema.runs).set(set).where(eq(schema.runs.id, id));
}

/**
 * The fork commit a prior attempt on this run pinned at worktree creation (anton-5bpd), or undefined
 * when none did — a first attempt, or a row written before the column existed. Read on resume so the
 * fork point is the one the branch was actually cut from, never recomputed against a base ref a
 * sibling run's fetch may have rewound since (see the column's own note).
 */
export async function getRunBaseForkSha(db: AntonDb, runId: string): Promise<string | undefined> {
  const rows = await db
    .select({ baseForkSha: schema.runs.baseForkSha })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1);
  return rows[0]?.baseForkSha ?? undefined;
}

/**
 * The fork commit the most recent attempt on this epic's BRANCH pinned, whatever became of that run
 * (PR #238 review) — the branch-scoped half of {@link getRunBaseForkSha}, and the same continuity
 * {@link findRunFormulaForBranch} exists for.
 *
 * Attempts do not all share a run row: an ordinary handler failure settles the row `failed`, so
 * `findOpenRunForEpic` returns nothing and the runner's retry opens a FRESH row while deliberately
 * reusing the prior attempt's branch and worktree. Keyed by run id alone, that retry finds no pin and
 * recomputes `merge-base <base> HEAD` against a base ref a sibling run's fetch can have rewound
 * meanwhile — widening the delta back into pre-fork history, where an old `<id>:` commit reads as
 * this run's delivery. So the pin follows the CHECKOUT, which is what it describes.
 */
export async function findRunBaseForkShaForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ baseForkSha: schema.runs.baseForkSha })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.baseForkSha),
      ),
    )
    // Ordered exactly as findRunFormulaForBranch is, and for its reason: `updatedAt` is
    // second-granular, so `writeSeq` breaks a tie by which attempt settled last.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt))
    .limit(1);
  return rows[0]?.baseForkSha ?? undefined;
}

/**
 * Written onto a row's `baseRefreshOutcome` in place of a plain null when its checkout's branch was
 * DELETED and RECREATED (anton-nyz1v, PR #279 review, fifth round) — `execute-epic-claim.ts` writes
 * this whenever `createWorktree` reports `createdBranch: true`, instead of leaving the column at its
 * default null. A plain null cannot serve as that marker: it's also what the CURRENT attempt's own
 * row carries before ITS refresh has run (every row is inserted, and is therefore already the
 * newest row for its branch, well before `warmRunWorktree` gets far enough to populate this column),
 * so a query that just took "the newest null row" as a stop signal would stop on its own
 * not-yet-written row on every single call and never see a real boundary at all. This sentinel is
 * unambiguous: only a deliberate recreation writes it, never an unwritten column.
 */
export const BRANCH_RECREATED_REFRESH_TOMBSTONE = "branch_recreated";

/**
 * The base sha the most recent EFFECTIVE (non-`skipped_dirty`) refresh on this epic's BRANCH
 * settled on, from whichever row recorded it, whatever became of that row (PR #279 review) — the
 * refresh half of {@link findRunBaseForkShaForBranch}, needed for the same reason: an ordinary
 * handler failure settles its row `failed`, and the retry opens a FRESH row while reusing the same
 * branch and worktree, so a lookup scoped to that one row alone never sees a refresh an earlier,
 * now-dead row on this branch already recorded.
 *
 * Also doubles as the `--onto` rebase boundary a later refresh should pass as `forkSha`, in
 * preference to the branch's original fork point: after one successful `--onto` refresh, that
 * original fork point is no longer reachable on the branch at all (the rebase replayed only what
 * came after it, onto the new base), so `refreshOntoBase` would silently fall back to the plain,
 * unsafe form of `rebase` on a later refresh. The most recently applied base IS still on the branch
 * — it's what everything got rebased onto — and describes the same boundary a second `--onto` needs.
 *
 * Walked in recency order rather than filtered to one row in SQL (anton-nyz1v, PR #279 review, fifth
 * round): a row recording an OLDER effective refresh can outlive the branch it describes — a later
 * attempt deletes and recreates the branch, records {@link BRANCH_RECREATED_REFRESH_TOMBSTONE} on
 * its own row, and dies before ever running its own refresh. Filtering straight to
 * `isNotNull(baseRefreshSha)` skips that tombstone row (its `baseRefreshSha` stays null) and returns
 * the older row's boundary as if the recreation never happened — replaying whatever the deletion
 * dropped back onto the recreated branch. Walking newest-first and stopping at the first tombstone
 * makes that row the wall it's meant to be; a `skipped_dirty` row in between is skipped, never
 * mistaken for a wall or a boundary, exactly as the old `ne(...)` filter treated it.
 */
export async function findRunBaseRefreshShaForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      baseRefreshOutcome: schema.runs.baseRefreshOutcome,
      baseRefreshSha: schema.runs.baseRefreshSha,
      priorBaseRefreshSha: schema.runs.priorBaseRefreshSha,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.baseRefreshOutcome),
      ),
    )
    // Ordered exactly as findRunBaseForkShaForBranch is, and for its reason: `updatedAt` is
    // second-granular, so `writeSeq` breaks a tie by which attempt settled last.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt));
  for (const row of rows) {
    if (row.baseRefreshOutcome === BRANCH_RECREATED_REFRESH_TOMBSTONE) return undefined;
    if (row.baseRefreshOutcome === "skipped_dirty") {
      // A dirty attempt is a barrier only for pending-mutation reconciliation: its branch may have
      // advanced through ordinary agent work. Its own snapshotted prior boundary, however, remains
      // a confirmed refresh and is safe to recover for a later `--onto` refresh.
      if (row.priorBaseRefreshSha) return row.priorBaseRefreshSha;
      continue;
    }
    // A still-PENDING row (see PENDING_REFRESH_OUTCOME below) records what a dead attempt INTENDED,
    // not a confirmed outcome — trusting its sha here as if it were a settled boundary would recreate
    // exactly the unsafe blind trust this whole mechanism exists to avoid, just via a new sentinel
    // instead of stale data. Its OWN `priorBaseRefreshSha`, when recorded, is different: it's this
    // same row's last EFFECTIVE boundary, snapshotted the instant this pending write overwrote it (PR
    // #279 review, P1) — trusting that is not a new blind trust, it's recovering what this row itself
    // already confirmed before starting a refresh a crash then left unresolved. Only when neither is
    // available (a legacy pending row, or one written before this attempt ever had a boundary of its
    // own) does the walk fall through to an OLDER row's genuinely confirmed boundary, same as before.
    if (row.baseRefreshOutcome === PENDING_REFRESH_OUTCOME) {
      if (row.priorBaseRefreshSha) return row.priorBaseRefreshSha;
      continue;
    }
    if (row.baseRefreshSha) return row.baseRefreshSha;
  }
  return undefined;
}

/**
 * Written onto a row's `baseRefreshOutcome`, in place of a real outcome, the instant
 * execute-epic-claim.ts is about to hand a reused checkout's branch to a mutating merge/rebase
 * (anton-s55u, PR #279 review, P1) — BEFORE that git call runs, not after. Without it, a process
 * killed between the mutation actually landing and the normal finalize write (`refreshFields`)
 * leaves nothing durable behind: the catch-based best-effort retry that recovers from a thrown
 * exception never runs for a hard kill, so a later resume would derive its `--onto` boundary from
 * the older, now-stale `findRunBaseRefreshShaForBranch` result and could replay commits the
 * unrecorded mutation already folded into the branch as if they were still-unapplied base history.
 * This sentinel is what that resume finds instead — see {@link findPendingRefreshShaForBranch} for
 * how it turns this into a trustworthy boundary.
 */
export const PENDING_REFRESH_OUTCOME = "pending";

/** A still-pending refresh's write-ahead record, as {@link findPendingRefreshShaForBranch} recovers it. */
export interface PendingRefresh {
  /** The base commit the dead attempt was mutating the branch onto. */
  sha: string;
  /**
   * The branch's own tip the instant before that mutation was attempted — the only evidence that
   * can tell "the mutation actually landed" apart from "`sha` was already reachable from the branch
   * before the mutation ever ran" (see the column's own note on schema.ts). Undefined for a pending
   * row written before this field existed; the caller must then refuse to trust the pending sha
   * rather than reconcile it against nothing.
   */
  fromSha: string | undefined;
  /**
   * The specific git operation (`fast_forwarded` | `merged` | `rebased`) the dead attempt was
   * mutating the branch with — see the column's own note on schema.ts for why reachability of `sha`
   * alone, even reconciled against `fromSha`, still isn't proof: it needs THIS to know what shape of
   * evidence would actually confirm it. Undefined for a pending row written before this field
   * existed, or one whose `beforeMutate` call predates it; the caller must then refuse to trust the
   * pending sha rather than guess which confirmation shape applies.
   */
  kind: string | undefined;
}

/**
 * The write-ahead record a still-PENDING refresh (see {@link PENDING_REFRESH_OUTCOME}) left for this
 * branch — some attempt began a merge/rebase/fast-forward onto `sha` and never lived to finalize its
 * row with a real outcome. Undefined once a NEWER row on this branch recorded a real outcome (an
 * attempt that finished its own refresh cleanly, whether or not it's the same one that went pending)
 * or the recreation tombstone (the branch the pending sha describes is gone).
 *
 * Unlike {@link findRunBaseRefreshShaForBranch}, a NEWER `skipped_dirty` row is a barrier here, not a
 * row to skip past (anton-s55u, PR #279 review, fourth re-review): that function's boundary stays
 * true regardless of what a later dirty attempt does, but `skipped_dirty` only means the REFRESH was
 * skipped — the attempt can still dispatch and commit real work onto the branch, moving its tip for
 * reasons that have nothing to do with whether an OLDER pending write-ahead record's mutation ever
 * landed. Walking through to that older row would hand the caller a `fromSha` reconciliation baseline
 * those intervening commits already invalidated: the branch no longer equals `fromSha` because of the
 * dirty attempt's own unrelated work, not because the pending mutation ran, so the caller's ancestry
 * check could mistake a rewind target that was always an ancestor of the branch for a just-landed
 * rebase and confirm a mutation that never actually happened. Returning undefined here is not itself
 * proof nothing is pending — it means the newest row that actually settled something (including a
 * dirty skip) settled it for real, so whatever this function would have found further back is already
 * superseded or no longer safely reconcilable.
 *
 * Neither field this returns is trustworthy on its own: `sha` describes what a dead attempt
 * INTENDED, not what it necessarily achieved. The caller (execute-epic-claim.ts) is the one with git
 * access to check whether it actually landed on the branch, reconciled against `fromSha`, before
 * treating it as a boundary.
 */
export async function findPendingRefreshShaForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
): Promise<PendingRefresh | undefined> {
  const rows = await db
    .select({
      baseRefreshOutcome: schema.runs.baseRefreshOutcome,
      baseRefreshSha: schema.runs.baseRefreshSha,
      pendingRefreshFromSha: schema.runs.pendingRefreshFromSha,
      pendingRefreshKind: schema.runs.pendingRefreshKind,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.baseRefreshOutcome),
      ),
    )
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt));
  for (const row of rows) {
    if (row.baseRefreshOutcome === BRANCH_RECREATED_REFRESH_TOMBSTONE) return undefined;
    if (row.baseRefreshOutcome === "skipped_dirty") return undefined;
    if (row.baseRefreshOutcome !== PENDING_REFRESH_OUTCOME) return undefined;
    return row.baseRefreshSha
      ? {
          sha: row.baseRefreshSha,
          fromSha: row.pendingRefreshFromSha ?? undefined,
          kind: row.pendingRefreshKind ?? undefined,
        }
      : undefined;
  }
  return undefined;
}

/** A clean verdict's resume key, as {@link findRunReviewKeyForBranch} recovers it for a fresh row. */
export interface RecordedReviewKey {
  reviewKey: string;
  reviewKeyAdvisories: string | null;
  /** The score that verdict earned — restored onto the skipping row so it reads as reviewed, not a gap. */
  reviewScore: number | null;
  /** The narrative `describe` wrote for that same attempt (anton-fpkk8) — see the column's own note. */
  narrative: string | null;
}

/**
 * The clean-verdict resume key the most recent OTHER attempt on this epic's BRANCH recorded,
 * whatever became of that run (anton-nyz1v) — the review-key half of
 * {@link findRunBaseForkShaForBranch}.
 *
 * A git fault at step:pr is an ordinary Error: execute-epic-settle's catch-all settles the row
 * `failed`, which `findOpenRunForEpic` excludes (`ACTIVE_RUN_STATUSES` has no `failed`). The
 * runner's automatic retry then opens a FRESH row while deliberately reusing this branch and
 * worktree — so a resume-key check keyed to `existing` alone never fires on exactly the fault this
 * key exists to make cheap. Scoped by branch instead, for the same reason `findRunFormulaForBranch`
 * and `findRunBaseForkShaForBranch` are: attempts do not all share a row, but they do share a branch.
 *
 * `excludeRunId` MUST be this call's own run id: a formula may run `step:review` more than once in
 * ONE attempt (the floor constrains omission and order, never extension), and the first step's
 * clean verdict writes ITS key onto this very row before the second step ever runs. Without the
 * exclusion, the second step's lookup would find its own attempt's row and skip itself against a
 * verdict that never actually judged the (possibly still-open) advisories a second gate exists to
 * re-check — turning a two-gate formula into a one-gate one. A genuine cross-attempt retry is
 * unaffected: its fresh row carries a DIFFERENT id than the failed one it is meant to recover.
 *
 * That exclusion alone does not stop a DIFFERENT cross-step mixup: a failed attempt's row still
 * carries whichever step's key was written onto it LAST, and a retry's second `step:review` could
 * otherwise find that recovered row (excluded is only the retry's OWN id) and treat a verdict the
 * FIRST gate produced as its own. `computeReviewKey`'s fingerprint is bound to the step's id for
 * exactly this reason (anton-nyz1v) — a token computed for one step's occurrence cannot equal one
 * computed for another's, so a mismatched recovery falls through to a real review, same as no key
 * at all.
 *
 * Otherwise safe to consult unconditionally — a stale key from an unrelated earlier attempt on this
 * branch simply fails the token comparison in `runReviewStep` and the gate reviews in full, exactly
 * as a row with no key at all does.
 */
export async function findRunReviewKeyForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
  excludeRunId: string,
): Promise<RecordedReviewKey | undefined> {
  const rows = await db
    .select({
      reviewKey: schema.runs.reviewKey,
      reviewKeyAdvisories: schema.runs.reviewKeyAdvisories,
      reviewKeyScore: schema.runs.reviewKeyScore,
      narrative: schema.runs.narrative,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.reviewKey),
        ne(schema.runs.id, excludeRunId),
      ),
    )
    // Ordered exactly as findRunFormulaForBranch is, and for its reason: `updatedAt` is
    // second-granular, so `writeSeq` breaks a tie by which attempt settled last.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.reviewKey) return undefined;
  return {
    reviewKey: row.reviewKey,
    reviewKeyAdvisories: row.reviewKeyAdvisories,
    reviewScore: row.reviewKeyScore,
    narrative: row.narrative,
  };
}

/**
 * Settle a still-PARKED run as `failed` — the run-row half of abandoning the work it was executing
 * (anton-wvcy). Nothing re-dispatches a parked run, so one whose bead has just been abandoned would
 * otherwise sit exactly as `detectParkedRuns` sees it and be escalated again on every sweep, now
 * against a closed target. Both the project and the `parked` status are re-asserted in the WHERE, so
 * this is a CAS: a run an operator resumed since the decision keeps running, and no other project's
 * run can be settled by id. Returns whether it settled one.
 */
export async function settleParkedRun(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  runId: string,
  reason: string,
): Promise<boolean> {
  const nowMs = clock.now();
  const settled = await db
    .update(schema.runs)
    .set({
      status: "failed",
      error: reason,
      endedAt: secDate(nowMs),
      updatedAt: secDate(nowMs),
      writeSeq: nextWriteSeq(),
    })
    .where(
      and(
        eq(schema.runs.id, runId),
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.status, "parked"),
      ),
    )
    .returning({ id: schema.runs.id });
  return settled.length > 0;
}

export async function getRunById(db: AntonDb, id: string): Promise<RunRow | undefined> {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, id)).limit(1);
  return rows[0];
}

/**
 * Boot reconciliation (anton-nbd): a `runs` row left in `running` after a crash is only genuinely
 * orphaned if no execute-epic job will resume it. `activeKeys` holds `${projectId}::${epicBeadId}`
 * for every still-active job (see `activeExecuteEpicKeys`); a running run whose key is present is
 * about to be re-dispatched and MUST be left alone (touching it would break the idempotent resume —
 * `findOpenRunForEpic` reuses the same row). Any other running run has no job coming back, so mark
 * it `failed` (`interrupted`) — that clears the stale "running" from the UI. Returns the count
 * reconciled. Runs that are already `parked` are left as-is (their job resumes or a human un-parks).
 */
export async function reconcileInterruptedRuns(
  db: AntonDb,
  clock: Clock,
  activeKeys: Set<string>,
): Promise<number> {
  const running = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.status, "running"));
  const orphaned = running.filter(
    (r) => !activeKeys.has(`${r.projectId ?? ""}::${r.epicBeadId}`),
  );
  const nowMs = clock.now();
  for (const run of orphaned) {
    await updateRun(db, clock, run.id, {
      status: "failed",
      error: "interrupted by server restart",
      endedAt: nowMs,
    });
  }
  return orphaned.length;
}

/**
 * A project's most recently active runs, newest first (anton-d2sx). db-injectable and strictly
 * read-only, unlike {@link listRuns}, which reads the shared anton.db for the UI — this one is asked
 * by a background job, which must see the connection its caller injected.
 *
 * "How did the last few attempts go" is the one input a ranking judgment cannot get from the board:
 * a bead looks identical whether the runs against it landed or parked.
 */
export async function listRecentRuns(
  db: AntonDb,
  projectId: string,
  limit: number,
): Promise<RunSummary[]> {
  return (await recentRunRows(db, projectId, limit)).map(toSummary);
}

/**
 * The newest `limit` runs of a project, in a TOTAL order (anton-rgso).
 *
 * `updatedAt` is stored whole-second, so runs settling in the same second tie on it — and with
 * concurrent execution that is ordinary, not exotic. Left as the only key, SQLite is free to return
 * such a tie either way round, and the autopilot breakers read this list as a sequence: one
 * delivered run placed before rather than after two same-second failures resets a streak instead of
 * latching it, and at the boundary the `limit` itself would take different rows on different reads.
 *
 * `writeSeq` breaks it, and breaks it CORRECTLY: it is a global counter stamped on every write to a
 * run row, so a settled run's stamp is the instant it settled, ordered against every other run's at
 * a granularity the second-wide timestamps cannot express. Start order would only be a proxy, and a
 * proxy that inverts exactly where it is needed — a run started first can finish after one started
 * later — so a later-started delivery would sort newest and reset a streak that the failure it
 * actually settled before should have kept.
 *
 * `startedAt` and `rowid` remain behind it for the rows written before the column existed, whose
 * `writeSeq` is null: deterministic, which is the weaker property those rows can still have.
 */
function recentRunRows(
  db: AntonDb,
  projectId: string,
  limit: number,
  offset = 0,
): Promise<(typeof schema.runs.$inferSelect)[]> {
  return db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(
      desc(schema.runs.updatedAt),
      desc(schema.runs.writeSeq),
      desc(schema.runs.startedAt),
      sql`rowid desc`,
    )
    .limit(limit)
    .offset(offset);
}

/**
 * {@link listRecentRuns} with each run's ERROR and review SCORE attached (anton-rgso, anton-cekf).
 * Both autopilot breakers read a column the list view has no use for: the consecutive-failure one
 * compares failures BY their message — that is how it tells one broken environment from several hard
 * tickets — and the score-regression one judges each attempt on the score that attempt earned.
 * db-injectable and read-only, like its sibling.
 *
 * `offset` pages further back in that same total order. The score breaker needs it because it
 * collapses a target's repeat attempts onto one entry, so how many ROWS its window costs is not
 * knowable before the read (see `jobs/picker-score-breaker.ts`).
 */
export async function listRecentRunOutcomes(
  db: AntonDb,
  projectId: string,
  limit: number,
  offset = 0,
): Promise<RunDetail[]> {
  return (await recentRunRows(db, projectId, limit, offset)).map(toDetail);
}

/**
 * When work carrying each of these beads DELIVERED — in unix SECONDS, unordered.
 *
 * Read for the repair weigher (gardener/repair.ts) and the feature ledger (feature-ledger-read.ts
 * `lastDeliveryMs`): a repair's double weight lasts only until the repaired bead next delivers, and
 * a delivery that old is behind the streak the breaker walks — it is not in the run window and no
 * board read remembers it; the ledger needs the same evidence to know when a feature's `leadMs` span
 * actually ends.
 *
 * THREE sources, because the run row cannot name every bead a run delivered (PR #223 review). It
 * carries one `ticketBeadId`, and a grouped run OVERWRITES it per child
 * (jobs/execute-epic-ticket-bookends.ts `openTicketSession`) — so on the rows alone a repaired
 * child that succeeded, followed by any other child, leaves no delivery at all, and its stamp goes
 * on weighing later unrelated failures double until the breaker disarms the picker early. So the
 * rows answer for the run's TARGET and its final ticket, each ticket's own `execute` session —
 * opened per child and settled `done` only once that child's work committed — answers for the rest,
 * and a `review-fix` session that actually pushed a correction (`sessions.pushed`, PR #320 review)
 * answers for a delivery that lands AFTER the PR opened — a review-fix session settles `done` the
 * same way whether or not it pushed anything, so an unpushed one (nothing but an answered thread)
 * must not count.
 *
 * A ticket session settles `done` on its own commit, whatever becomes of the run around it: the
 * repair the child carried was PROVEN by that landing, which is the whole test this evidence exists
 * to apply.
 *
 * Bounded by the ids handed in — the beads that actually carry a repair stamp, or a ledger's scope —
 * so an unrepaired board costs no query at all.
 *
 * `includeLocalCommits` (default true) gates the `execute`-session arm above, but only for a
 * session whose CONTAINING RUN never delivered — not every local commit. The repair weigher wants
 * every one of them: a child's own commit proves ITS repair regardless of what the run around it
 * does next. The feature ledger (`feature-ledger-read.ts`) must exclude the ones whose run parked or
 * failed before ever pushing — that local commit is not a feature delivery — yet the run-row arm
 * above is not enough on its own: a grouped run overwrites `ticketBeadId` per child, so a non-final
 * child later reparented onto a different feature has no run-row evidence of its own (the row still
 * names the OLD epic and the LAST child, neither of which is in the new feature's scope) — only its
 * `execute` session is. Gating that session on its run's `status: "done"` AND `delivered` flag,
 * instead of dropping the whole arm, keeps crediting a child that genuinely published while still
 * excluding one whose run parked or failed (P2, PR #320 review).
 *
 * The run-row arm is further filtered on `delivered` (PR #320 review): a verified already-shipped
 * retirement settles the row `done` too, but opens no pull request, so a `done` status alone is not
 * publication evidence — counting it would hand a feature (or a repair) credit for a settle that
 * shipped nothing.
 */
export async function listDeliveriesByBead(
  db: AntonDb,
  projectId: string,
  beadIds: readonly string[],
  options?: { includeLocalCommits?: boolean },
): Promise<Map<string, number[]>> {
  const includeLocalCommits = options?.includeLocalCommits ?? true;
  const out = new Map<string, number[]>();
  if (beadIds.length === 0) return out;
  const ids = [...new Set(beadIds)];
  const wanted = new Set(ids);
  const record = (id: string, at: number) => out.set(id, [...(out.get(id) ?? []), at]);
  const rows = await db
    .select({
      epicBeadId: schema.runs.epicBeadId,
      ticketBeadId: schema.runs.ticketBeadId,
      endedAt: schema.runs.endedAt,
      updatedAt: schema.runs.updatedAt,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.status, "done"),
        // A verified already-shipped retirement settles `done` too, but opens no pull request —
        // `delivered` is false only there (PR #320 review). Excluding it here serves both callers:
        // neither the ledger's `leadMs` nor the repair weigher's double-weight should read a no-op
        // settle as proof anything landed.
        eq(schema.runs.delivered, true),
        or(inArray(schema.runs.epicBeadId, ids), inArray(schema.runs.ticketBeadId, ids)),
      ),
    );
  for (const row of rows) {
    // A settled row's `updatedAt` is when it settled — the fallback for rows written before
    // `endedAt` was recorded, exactly as the breakers' own fence reads them.
    const at = toEpoch(row.endedAt) ?? toEpoch(row.updatedAt);
    if (at === undefined) continue;
    for (const id of [row.epicBeadId, row.ticketBeadId]) {
      if (id === null || !wanted.has(id)) continue;
      record(id, at);
    }
  }

  // `execute` always delivers (its own commit) once settled `done`; `review-fix` settles `done`
  // whether or not it pushed anything, so it only counts when `pushed` says it did. With
  // `includeLocalCommits: false`, an execute session only counts when ITS OWN run settled `done`
  // AND delivered — the same two conditions the run-row arm above applies, read here off the run
  // the session was opened inside via the left join. `delivered` defaults `true` at row creation and
  // is only ever written when a run finishes `done` (see the column's own note above), so a run that
  // parked or failed before pushing still needs the `status: "done"` check — it is never rewritten
  // to `false` on its own. A session with no matching run is excluded the same way.
  const executeCondition = includeLocalCommits
    ? eq(schema.sessions.kind, "execute")
    : and(
        eq(schema.sessions.kind, "execute"),
        eq(schema.runs.status, "done"),
        eq(schema.runs.delivered, true),
      );
  const ticketRows = await db
    .select({
      beadId: schema.sessions.beadId,
      kind: schema.sessions.kind,
      endedAt: schema.sessions.endedAt,
      runEndedAt: schema.runs.endedAt,
      runUpdatedAt: schema.runs.updatedAt,
    })
    .from(schema.sessions)
    .leftJoin(schema.runs, eq(schema.sessions.runId, schema.runs.id))
    .where(
      and(
        eq(schema.sessions.projectId, projectId),
        eq(schema.sessions.status, "done"),
        inArray(schema.sessions.beadId, ids),
        or(and(eq(schema.sessions.kind, "review-fix"), eq(schema.sessions.pushed, true)), executeCondition),
      ),
    );
  for (const row of ticketRows) {
    // A gated execute session (`includeLocalCommits: false`) is only reached here because its
    // CONTAINING RUN delivered — a reparented non-final child whose own run-row evidence names
    // neither its new feature nor itself (see the run-row arm's own note above). The session's own
    // `endedAt` is that child's local commit, stamped before the run's later PR publication; reading
    // it as the delivery time would end `leadMs` at the commit instead of the publish it actually
    // waited for (PR #320 review, P2). The run's own `endedAt` (falling back to `updatedAt`, exactly
    // as the run-row arm above reads it) is the publication time for this arm.
    const at =
      !includeLocalCommits && row.kind === "execute"
        ? toEpoch(row.runEndedAt) ?? toEpoch(row.runUpdatedAt)
        : toEpoch(row.endedAt);
    if (at === undefined || row.beadId === null) continue;
    record(row.beadId, at);
  }
  return out;
}

/**
 * Every run of a project in the given statuses, oldest activity first (anton-4ks0). The read the
 * run-health sweep detects over — `updatedAt` on a settled run is when it settled, so ordering by
 * it puts the most-stalled work first. db-injectable; strictly read-only.
 */
export async function listRunsByStatus(
  db: AntonDb,
  projectId: string,
  statuses: readonly RunStatus[],
): Promise<RunRow[]> {
  if (statuses.length === 0) return [];
  return db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), inArray(schema.runs.status, [...statuses])))
    .orderBy(schema.runs.updatedAt);
}

/** The pipeline choice a run recorded (anton-aa3m) — what a later attempt on the same branch pins to. */
export interface RecordedFormula {
  /**
   * The formula that run walked: an absolute path for a project-local pipeline, or the
   * `bundled:` sentinel for anton's own asset (whose path belongs to the install, not the project —
   * see `BUNDLED_FORMULA_SOURCE`).
   */
  source: string;
  /** The bead label that selected it; absent ⇒ the project/bundled default. */
  variant?: string;
}

/**
 * The pipeline the most recent attempt on this epic's BRANCH recorded, whatever became of that run.
 *
 * A run's pipeline is chosen once and honored for the life of the work, not re-selected per attempt
 * — but attempts do not all share a run row. An ordinary handler error settles the row `failed`, and
 * `findOpenRunForEpic` returns only open ones, so the runner's automatic retry gets a FRESH row while
 * reusing the prior attempt's worktree and skipping the tickets it already committed. Selecting again
 * there would let a label or a variant mapping edited during the retry backoff switch pipelines
 * mid-branch: the committed tickets walked one formula, the rest walk another.
 *
 * So the branch is the unit of continuity — the same thing the retry itself resumes by. A run on a
 * branch no prior run recorded a formula for (a first run, or a new branch prefix) selects normally.
 */
export async function findRunFormulaForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
): Promise<RecordedFormula | undefined> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.formula),
      ),
    )
    // `updatedAt` is second-granular, so two attempts inside one second can tie; `writeSeq` — the
    // per-write counter — breaks it by which attempt actually settled last, with `startedAt` behind
    // it for rows written before that column existed.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.formula) return undefined;
  return { source: row.formula, variant: row.formulaVariant ?? undefined };
}

/** The most-recent still-open run for an epic — used to resume rather than start a duplicate. */
export async function findOpenRunForEpic(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
): Promise<RunRow | undefined> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        inArray(schema.runs.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .orderBy(desc(schema.runs.updatedAt))
    .limit(1);
  return rows[0];
}
