"use client";

import type { ReviewReport, ReviewReportRound, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/atoms";
import { ReviewScoreChip, ScoreSparkline, scoreBand } from "@/components/review-score";

/** What each round's verdict meant for the run, in the founder's words rather than the gate's. */
const VERDICT_LABELS: Record<string, string> = {
  fixed: "fixed and re-reviewed",
  clean: "cleared",
  unresolved: "parked on blocking findings",
  stalled: "stalled — the fix round left the tree unchanged",
  "protocol-violation": "no usable report — the review settled nothing",
  "score-regression": "parked — the score stopped moving",
  interrupted: "interrupted before it settled",
};

/** Only the verdicts that mean the run STOPPED are tinted; the rest are ordinary progress. */
const ALARMED_VERDICTS = new Set([
  "unresolved",
  "stalled",
  "protocol-violation",
  "score-regression",
]);

/**
 * A run target's self-review history (anton-tprv): every round anton recorded on the board, as a
 * trend plus the rounds themselves.
 *
 * The rounds are the point, not just the latest number. A target that scored 4 then 8 was fixed;
 * one that scored 8 then 4 regressed; one that scored 4 twice is why the regression alarm exists —
 * and all three carry the same "latest score" the board card shows. Read off the append-only bd
 * comments, so this survives the worktree the review ran in.
 */
export function ReviewScorePanel({
  report,
  stage,
  loading = false,
  error,
}: {
  report?: ReviewReport;
  /** The target's stage — a backlog target has simply never run, so it says nothing at all. */
  stage: Stage;
  loading?: boolean;
  /** Why the history couldn't be read, when it couldn't. */
  error?: string | null;
}) {
  const rounds = report?.rounds ?? [];

  if (stage === "backlog" && rounds.length === 0) return null;

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">
          Self-review
        </span>
        {rounds.length > 0 && (
          <span className="text-[11px] text-subtle">
            {rounds.length} {rounds.length === 1 ? "round" : "rounds"}
          </span>
        )}
        <span className="ml-auto">
          <ReviewScoreChip score={report?.score} />
        </span>
      </div>

      {loading ? (
        <span className="anton-shimmer h-9 w-full rounded" aria-label="Loading self-review history" />
      ) : rounds.length === 0 ? (
        // Honest zero-state: no score, and no 0. A run target can reach in-review without ever being
        // scored — the gate can be off, or the run can have died before its first round reported.
        <p className="text-[12px] text-subtle">
          {error ?? "No review round has scored this target yet."}
        </p>
      ) : (
        <>
          <ScoreSparkline
            points={rounds.map((r, i) => ({
              key: `${r.round}-${i}`,
              score: r.score,
              label: `round ${r.round}`,
            }))}
          />
          <ol className="flex flex-col divide-y divide-border/60">
            {rounds.map((round, i) => (
              <RoundRow key={`${round.round}-${i}`} round={round} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function RoundRow({ round }: { round: ReviewReportRound }) {
  const verdict = VERDICT_LABELS[round.verdict] ?? round.verdict;
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-subtle">round {round.round}</span>
        <span
          className={cn(
            "font-mono text-[12px]",
            round.score === undefined
              ? "text-subtle"
              : scoreBand(round.score) === "ships"
                ? "text-stage-done"
                : scoreBand(round.score) === "gaps"
                  ? "text-risk-med"
                  : "text-risk-high",
          )}
        >
          {round.score === undefined ? "no score" : `${round.score}/10`}
        </span>
        {round.at && (
          <RelativeTime iso={round.at} className="ml-auto text-[11px] text-subtle" />
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-muted-foreground">
        <span className={round.blocking > 0 ? "text-risk-high" : undefined}>
          {round.blocking} blocking
        </span>
        <span>·</span>
        <span>{round.advisory} advisory</span>
        <span>·</span>
        <span className={ALARMED_VERDICTS.has(round.verdict) ? "text-risk-med" : undefined}>
          {verdict}
        </span>
      </div>
      {round.rationale && (
        // The reviewer's own justification of the number — the only thing that makes a score
        // arguable rather than just a verdict.
        <p className="line-clamp-3 text-[11.5px] leading-snug text-foreground/75" title={round.rationale}>
          {round.rationale}
        </p>
      )}
    </li>
  );
}
