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
  };
}

/** Threads grouped by the author of their opening comment — an empty thread belongs to nobody. */
function threadsByAuthor(threads: readonly ReviewThread[]): Record<string, number> {
  const byAuthor: Record<string, number> = {};
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
 */
export async function recordPrTerminalState(
  db: AntonDb,
  clock: Clock,
  input: { projectId: string; prNumber: number; state: PrTerminalState },
): Promise<void> {
  try {
    await db
      .update(schema.reviewRounds)
      .set({ prState: input.state, prStateAt: secDate(clock.now()) })
      .where(
        and(
          eq(schema.reviewRounds.projectId, input.projectId),
          eq(schema.reviewRounds.prNumber, input.prNumber),
          input.state === "merged"
            ? or(isNull(schema.reviewRounds.prState), eq(schema.reviewRounds.prState, "closed"))
            : isNull(schema.reviewRounds.prState),
        ),
      );
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}
