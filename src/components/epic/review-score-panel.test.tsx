import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bead } from "@/lib/beads/types";
import { formatReviewScoreComment } from "@/lib/jobs/review-score";
import { reviewReportOf } from "@/lib/review-report";
import { ReviewScorePanel } from "@/components/epic/review-score-panel";

/**
 * The panel is rendered from a REPLAYED comment thread, not from hand-built rounds: what a run
 * writes (`formatReviewScoreComment`) and what the page shows have to stay one pipeline, and the
 * thread it reads is free text — a human's reply and a half-written fence sit in it too.
 */
const target = (comments: { text: string; created_at?: string }[]): Bead =>
  ({ id: "feat-1", title: "Target", status: "open", issue_type: "feature", comments }) as Bead;

const round = (
  text: Parameters<typeof formatReviewScoreComment>[0],
  created_at = "2026-08-02T12:00:00Z",
) => ({ text: formatReviewScoreComment(text), created_at });

const render = (bead: Bead, stage: "backlog" | "in-review" = "in-review") =>
  renderToStaticMarkup(<ReviewScorePanel report={reviewReportOf(bead)} stage={stage} />);

describe("ReviewScorePanel", () => {
  it("renders every round of the series: score, counts and verdict", () => {
    const html = render(
      target([
        round({ round: 1, score: 4, blocking: 2, advisory: 1, verdict: "fixed" }),
        round({ round: 2, score: 9, blocking: 0, advisory: 1, verdict: "clean" }),
      ]),
    );

    expect(html).toContain("round 1");
    expect(html).toContain("4/10");
    expect(html).toContain("2 blocking");
    expect(html).toContain("fixed and re-reviewed");
    expect(html).toContain("round 2");
    expect(html).toContain("9/10");
    expect(html).toContain("cleared");
    expect(html).toContain("2 rounds");
    // The header chip carries the LATEST score, not the first or the best.
    expect(html).toContain("review 9/10");
    expect(html).not.toContain("review 4/10");
  });

  it("plots the whole series as a trend, announced round by round", () => {
    const html = render(
      target([
        round({ round: 1, score: 3, blocking: 3, advisory: 0, verdict: "fixed" }),
        round({ round: 2, score: 8, blocking: 0, advisory: 0, verdict: "clean" }),
      ]),
    );

    expect(html).toContain('aria-label="round 1: 3 out of 10, round 2: 8 out of 10"');
    // Height by score, so a recovery reads as a shape and not just as two numbers.
    expect(html).toContain("height:30%");
    expect(html).toContain("height:80%");
  });

  it("shows the reviewer's rationale — the number alone is not arguable", () => {
    const html = render(
      target([
        round({
          round: 1,
          score: 5,
          blocking: 1,
          advisory: 0,
          verdict: "unresolved",
          rationale: "the retry path is untested",
        }),
      ]),
    );

    expect(html).toContain("the retry path is untested");
    expect(html).toContain("parked on blocking findings");
  });

  it("keeps the rounds around a malformed payload rather than losing the series", () => {
    const html = render(
      target([
        round({ round: 1, score: 6, blocking: 1, advisory: 0, verdict: "fixed" }),
        { text: "Nice work — merging after CI." }, // a human's reply
        { text: '```json\n{"kind":"anton.review-score","round":\n```' }, // truncated fence
        { text: '```json\n{"kind":"something.else","round":9,"score":0}\n```' }, // not anton's
        round({ round: 2, score: 8, blocking: 0, advisory: 0, verdict: "clean" }),
      ]),
    );

    expect(html).toContain("2 rounds");
    expect(html).toContain("6/10");
    expect(html).toContain("8/10");
    expect(html).not.toContain("round 9");
  });

  it("marks a round that reported no usable score as no score, never as a zero", () => {
    const html = render(
      target([round({ round: 1, blocking: 0, advisory: 0, verdict: "protocol-violation" })]),
    );

    expect(html).toContain("no score");
    expect(html).not.toContain("0/10");
    expect(html).toContain("no usable report");
    // …and the header chip stays empty: nothing scored this target.
    expect(html).not.toMatch(/review \d+\/10/);
  });

  it("says a target that ran was never scored, and shows a backlog target nothing at all", () => {
    const unscored = render(target([]));
    expect(unscored).toContain("No review round has scored this target yet.");
    expect(unscored).not.toContain("0/10");

    // A backlog target has never run — there is nothing to report, so the section doesn't exist.
    expect(render(target([]), "backlog")).toBe("");
  });

  it("reports a history it couldn't read as unread, not as unscored", () => {
    const html = renderToStaticMarkup(
      <ReviewScorePanel stage="done" error="Review history unavailable (500)" />,
    );

    expect(html).toContain("Review history unavailable (500)");
    expect(html).not.toContain("0/10");
  });
});
