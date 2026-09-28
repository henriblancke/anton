/**
 * The write path for the per-round review record (anton-z5e3g): what one review-fix round was handed
 * by GitHub's reviewers and how anton answered it, derived from values the job already holds — the
 * PR's fetched `ReviewThread[]` and the fixer's parsed `ThreadOutcome[]`. Nothing here fetches
 * anything.
 *
 * ONE ROW PER ROUND THAT DISPATCHED CLAUDE. The review-fix job runs far more often than it reviews:
 * most of its ticks are polls that find nothing actionable, and the resume fast path pushes an
 * operator's own commits without a claude session at all. Neither is review, so neither writes — the
 * absence of a row is what makes "no review happened" readable, and a row per job would drown the
 * rounds that did work under the poller.
 *
 * Best-effort by contract, the same rule the spend ledger states in `claude-invocations.ts`: NEITHER
 * exported function throws. A round that fixed the PR must not fail because a meter could not be
 * written, and a lost write costs one round's counts — never the fix. The counting itself sits inside
 * the same guard as the insert: the values come from a model-controlled report and a GitHub payload,
 * so a shape nobody anticipated must cost the row rather than the round (the rule `stampOf` applies
 * to a dimension one level in from the ledger's own swallow).
 *
 * db-injectable, like `run-attempts` and `claude-invocations`: the handler and its tests share one
 * connection.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, or } from "drizzle-orm";
import { schema } from "./db";
import { threadsNeedingAttention, type PrReview, type ReviewThread } from "./git/pr";
import { triageOutcomes, type ThreadOutcome } from "./jobs/review-fix-context";
import type { AntonDb, Clock } from "./jobs/queue";

export type ReviewRoundRow = typeof schema.reviewRounds.$inferSelect;

/** How a PR ended, in the vocabulary `review_rounds.pr_state` stores. */
export type PrTerminalState = "merged" | "closed";

/** Everything one round counted, ready to be a row. */
export interface RoundCounts {
  threadsSeen: number;
  threadsUnresolved: number;
  threadsOutdated: number;
  threadsActionable: number;
  outcomesFixed: number;
  outcomesLeft: number;
  outcomesNeedsHuman: number;
  /** Actionable threads per reviewer login — see {@link roundCounts}. */
  byAuthor: Record<string, number>;
  /**
   * Whether the `threads*` counts above are the PR's whole inline history (`pr.threadsComplete`,
   * git/pr.ts) rather than an understated prefix left by a failed GraphQL page. False on a round
   * whose GitHub thread read degraded — checked by a reader BEFORE trusting a low or zero
   * `threadsSeen`/`threadsUnresolved`/`threadsOutdated`/`threadsActionable` as the real count.
   */
  threadsComplete: boolean;
}

/** Whole-second, like every other timestamp anton writes — see `runs.ts`. */
function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

/**
 * What this round saw and did, as pure arithmetic over the two values the job holds.
 *
 * The outcome counts are the ones that SURVIVED triage — {@link triageOutcomes}, the very filter
 * `applyThreadOutcomes` replies through, shared rather than reimplemented. That is what makes the
 * counts reconcilable with the PR: a "fixed" claim with nothing pushed is a fabrication anton
 * answers no thread with, and an outcome naming a thread that is not waiting on anton (a stale id, a
 * thread a human resolved mid-round) was acted on nowhere either. Counting the raw report instead
 * would report fixes the PR has no record of.
 *
 * `byAuthor` counts the ACTIONABLE threads by the login that OPENED each one — the reviewer whose
 * finding it is, not whoever last commented on it. Actionable rather than seen, so the split
 * reconciles with the outcomes beside it (Σ byAuthor = `threadsActionable`) and so a reviewer's
 * volume summed over a PR's rounds counts each of their threads about once: a thread anton has
 * already answered drops out of `threadsNeedingAttention` and is not re-counted next round, while
 * `threads_seen` deliberately re-reports the PR's whole inline history every round.
 */
export function roundCounts(
  pr: PrReview,
  report: ThreadOutcome[],
  pushed: boolean,
): RoundCounts {
  const actionable = threadsNeedingAttention(pr);
  const triaged = triageOutcomes(pr, report, pushed);
  const outcomes = triaged.map((t) => t.item.outcome);
  return {
    threadsSeen: pr.threads.length,
    threadsUnresolved: pr.threads.filter((t) => !t.isResolved).length,
    threadsOutdated: pr.threads.filter((t) => t.isOutdated).length,
    threadsActionable: actionable.length,
    outcomesFixed: outcomes.filter((o) => o === "fixed").length,
    outcomesLeft: outcomes.filter((o) => o === "left").length,
    outcomesNeedsHuman: outcomes.filter((o) => o === "needs-human").length,
    byAuthor: threadsByAuthor(actionable),
    threadsComplete: pr.threadsComplete,
  };
}

/** Threads grouped by the author of their opening comment — an empty thread belongs to nobody. */
function threadsByAuthor(threads: readonly ReviewThread[]): Record<string, number> {
  // Object.create(null): a login like "constructor" or "toString" must not read back an
  // inherited Object.prototype member instead of a missing count.
  const byAuthor: Record<string, number> = Object.create(null);
  for (const thread of threads) {
    const opener = thread.comments[0]?.author;
    if (!opener) continue;
    byAuthor[opener] = (byAuthor[opener] ?? 0) + 1;
  }
  return byAuthor;
}

/**
 * Record one round: the threads the PR carried, who left them, and how anton answered.
 *
 * `input.report` must already be `applyThreadOutcomes`'s return value, not the raw model report —
 * i.e. only the outcomes whose reply actually posted to GitHub (PR #335 review). Passing the raw
 * report here would count a thread as fixed/left/needs-human when the reply that was meant to say
 * so never reached the PR, leaving the row claiming a response GitHub has no record of.
 *
 * Best-effort by contract — it NEVER throws. Call it only from a round that actually dispatched
 * claude and applied its outcomes: a session that FAILED replied to no thread, so its threads are
 * still waiting on anton and the retry's own row carries them. Recording both would count the same
 * findings twice.
 *
 * The ordinal is derived from the rows already recorded for this PR rather than read off the PR
 * body's rounds region: that region is capped and drops its oldest entries (`MAX_ROUNDS`,
 * review-fix-body.ts), so it stops being a counter once a long-running PR passes the cap. SQLite
 * serializes writers, so the count-then-insert is atomic enough for a per-PR sequence — and a
 * duplicate ordinal would cost only the ordering of two rows whose counts still sum correctly.
 */
export async function recordReviewRound(
  db: AntonDb,
  clock: Clock,
  input: {
    projectId: string;
    /** The run target the PR belongs to, so a feature rolls up its rounds with its invocations. */
    beadId?: string;
    /** The review-fix job that ran the round — the join to its own spend in `claude_invocations`. */
    jobId?: string;
    prNumber: number;
    pr: PrReview;
    report: ThreadOutcome[];
    /** Whether the round pushed — what tells a real fix from a fabricated claim. */
    pushed: boolean;
  },
): Promise<void> {
  try {
    const counts = roundCounts(input.pr, input.report, input.pushed);
    const prior = await db
      .select({ n: count() })
      .from(schema.reviewRounds)
      .where(
        and(
          eq(schema.reviewRounds.projectId, input.projectId),
          eq(schema.reviewRounds.prNumber, input.prNumber),
        ),
      );
    await db.insert(schema.reviewRounds).values({
      id: randomUUID(),
      projectId: input.projectId,
      beadId: input.beadId ?? null,
      jobId: input.jobId ?? null,
      prNumber: input.prNumber,
      round: (prior[0]?.n ?? 0) + 1,
      threadsSeen: counts.threadsSeen,
      threadsUnresolved: counts.threadsUnresolved,
      threadsOutdated: counts.threadsOutdated,
      threadsActionable: counts.threadsActionable,
      outcomesFixed: counts.outcomesFixed,
      outcomesLeft: counts.outcomesLeft,
      outcomesNeedsHuman: counts.outcomesNeedsHuman,
      byAuthorJson: JSON.stringify(counts.byAuthor),
      threadsComplete: counts.threadsComplete,
      recordedAt: secDate(clock.now()),
    });
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/**
 * Stamp how the PR ENDED across every round recorded for it — the one write on this table that is
 * not append-only, and the reason `pr_state` lives on the round rather than in a second table keyed
 * by PR: a round cannot know its PR's fate while it is still running.
 *
 * Best-effort by contract — it NEVER throws. `merged` is the only truly final state GitHub reports —
 * a `closed` PR can still be reopened and later merged — so a later `merged` observation is allowed
 * to supersede an earlier `closed` stamp. Every other transition is a no-op: `merged` is never
 * overwritten (by `closed` or by a repeated `merged`), and a `closed` stamped once stays until a
 * `merged` supersedes it. That keeps a finalization that runs twice (it is deliberately resumable)
 * from revising a fact already recorded.
 *
 * Writes nothing when the PR has no rows — a PR whose every round predates this table, or one anton
 * only ever polled. That is the intended gap: a reader reports the rounds it has, and a synthesized
 * row would report a PR nobody reviewed.
 *
 * A `closed` PR can also be REOPENED and closed again without merging — a round dispatched in
 * between leaves a fresh null-`prState` row alongside the earlier round's `closed` stamp from the
 * first close. Restamping only that null row (the naive fix) would leave the two rows disagreeing
 * about when the PR ended. So a `closed` call first checks for a null row: finding one means a round
 * actually ran since the last close (real reopen evidence), and every row for the PR — the stale
 * `closed` ones included — is restamped to the new close together. Finding none means this is just a
 * repeated poll of an already-settled close, and the call is a no-op so it never bumps `prStateAt`
 * on a fact already recorded.
 *
 * That null-row heuristic only sees a reopen that produced another recorded round — a PR that
 * reopens, stays clean (so no round ever writes a fresh row), and closes again leaves no null row for
 * the second close to find, and the stale first-close stamp would stand forever. {@link
 * recordPrReopened} is the counterpart observation that covers this: called wherever anton reads the
 * PR as OPEN, it unsettles the PR's already-`closed` rows back to null so this function's null-row
 * check finds real reopen evidence even when no round ran in between.
 */
export async function recordPrTerminalState(
  db: AntonDb,
  clock: Clock,
  input: { projectId: string; prNumber: number; state: PrTerminalState },
): Promise<void> {
  try {
    const forPr = and(
      eq(schema.reviewRounds.projectId, input.projectId),
      eq(schema.reviewRounds.prNumber, input.prNumber),
    );

    if (input.state === "merged") {
      await db
        .update(schema.reviewRounds)
        .set({ prState: "merged", prStateAt: secDate(clock.now()) })
        .where(and(forPr, or(isNull(schema.reviewRounds.prState), eq(schema.reviewRounds.prState, "closed"))));
      return;
    }

    const unsettled = await db
      .select({ n: count() })
      .from(schema.reviewRounds)
      .where(and(forPr, isNull(schema.reviewRounds.prState)));
    if ((unsettled[0]?.n ?? 0) === 0) return;

    await db
      .update(schema.reviewRounds)
      .set({ prState: "closed", prStateAt: secDate(clock.now()) })
      .where(and(forPr, or(isNull(schema.reviewRounds.prState), eq(schema.reviewRounds.prState, "closed"))));
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/**
 * Every PR this project has an UNSETTLED round for (`pr_state IS NULL`) — regardless of whether its
 * target is still on the board. A target that leaves the board (another instance's
 * `finalizeMergedTarget` closes the epic and clears `stage:in-review`) drops out of `inReviewEpics`
 * for good, so a null row a race left behind (PR #335 review: `getPrReview`'s own state read can
 * still be stale by the time it resolves, even on the post-insert freshness check) would otherwise
 * never be revisited by the per-target triage loop. A caller reconciles these independently of board
 * membership — orphaned or not, restamping is idempotent (`recordPrTerminalState`).
 */
export async function unsettledPrNumbers(db: AntonDb, projectId: string): Promise<number[]> {
  const rows = await db
    .selectDistinct({ prNumber: schema.reviewRounds.prNumber })
    .from(schema.reviewRounds)
    .where(and(eq(schema.reviewRounds.projectId, projectId), isNull(schema.reviewRounds.prState)));
  return rows.map((r) => r.prNumber);
}

/**
 * Observe that a PR is OPEN — the counterpart read to `recordPrTerminalState`'s `closed` branch,
 * called from the same triage that reads PR state every pass (PR #335 review). A PR that closes,
 * reopens, stays clean (so no round ever writes a fresh row), and closes again would otherwise leave
 * `recordPrTerminalState`'s null-row check with no evidence of the reopen: it finds no unsettled row,
 * reads the second close as a repeated poll of the first, and the stale first-close stamp stands.
 *
 * Unsettles every row this PR has already stamped `closed` back to null — the same "not yet settled"
 * state a round's own insert starts from — so the next close finds real reopen evidence and restamps
 * them all together. A no-op once the rows are already unsettled or the PR was never closed, so
 * calling this on every OPEN observation (most of them, since OPEN is the common case) costs nothing.
 * `merged` rows are never touched: GitHub does not allow reopening a merged PR.
 *
 * Best-effort by contract, the same rule every write on this table follows — never throws.
 */
export async function recordPrReopened(
  db: AntonDb,
  input: { projectId: string; prNumber: number },
): Promise<void> {
  try {
    await db
      .update(schema.reviewRounds)
      .set({ prState: null, prStateAt: null })
      .where(
        and(
          eq(schema.reviewRounds.projectId, input.projectId),
          eq(schema.reviewRounds.prNumber, input.prNumber),
          eq(schema.reviewRounds.prState, "closed"),
        ),
      );
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}
