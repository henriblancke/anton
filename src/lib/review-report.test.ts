/**
 * Unit tests for replaying a run target's self-review off its comment thread (anton-4ocm). The
 * writer half (review-score.ts) is tested beside itself; what matters here is that a reader can get
 * the reviewer's own findings back out of the board — and that a foreign, malformed or older comment
 * never costs the rounds around it.
 */
import { describe, expect, it } from "vitest";
import type { Bead, BeadComment } from "./beads/bd";
import { formatReviewScoreComment } from "./jobs/review-score";
import { parseReviewScoreComment, reviewReportOf } from "./review-report";

const comment = (text: string, at?: string): BeadComment => ({ text, created_at: at });

const bead = (comments: BeadComment[]): Bead => ({
  id: "anton-t",
  title: "target",
  status: "open",
  comments,
});

const round = (over: Parameters<typeof formatReviewScoreComment>[0]) =>
  comment(formatReviewScoreComment(over));

describe("parseReviewScoreComment", () => {
  it("round-trips what review-score wrote, findings included", () => {
    const entry = {
      round: 2,
      score: 4,
      blocking: 1,
      advisory: 1,
      verdict: "unresolved" as const,
      rationale: "the API is untested",
      findings: [
        { severity: "blocking" as const, location: "src/a.ts:12", note: "no null guard" },
        { severity: "advisory" as const, location: "(general)", note: "naming drifts" },
      ],
    };
    expect(parseReviewScoreComment(round(entry))).toEqual({ ...entry });
  });

  it("ignores a comment that is not anton's score payload", () => {
    expect(parseReviewScoreComment(comment("just a human saying something"))).toBeUndefined();
    expect(
      parseReviewScoreComment(comment("```json\n{\"kind\":\"something.else\",\"round\":1}\n```")),
    ).toBeUndefined();
  });

  it("skips a fence that isn't JSON instead of throwing", () => {
    const text = "```json\nnot json at all\n```\n\n```json\n" +
      JSON.stringify({ kind: "anton.review-score", round: 1, blocking: 0, advisory: 0, verdict: "clean", score: 9 }) +
      "\n```";
    expect(parseReviewScoreComment(comment(text))?.score).toBe(9);
  });

  it("reads a round written before findings were recorded as one with none", () => {
    const text = "```json\n" +
      JSON.stringify({ kind: "anton.review-score", round: 1, score: 7, blocking: 0, advisory: 0, verdict: "clean" }) +
      "\n```";
    expect(parseReviewScoreComment(comment(text))?.findings).toEqual([]);
  });

  it("reads a score off the 0-10 scale as NO score — the surfaces size a bar by it", () => {
    const off = (score: unknown) =>
      comment(
        "```json\n" +
          JSON.stringify({
            kind: "anton.review-score",
            round: 1,
            score,
            blocking: 0,
            advisory: 0,
            verdict: "clean",
          }) +
          "\n```",
      );
    for (const bad of [99, -1, 4.5]) {
      const parsed = parseReviewScoreComment(off(bad));
      expect(parsed).toBeDefined(); // the round still replays; only its score is unusable
      expect(parsed?.score).toBeUndefined();
    }
    // The bounds themselves are real scores.
    expect(parseReviewScoreComment(off(0))?.score).toBe(0);
    expect(parseReviewScoreComment(off(10))?.score).toBe(10);
  });

  it("drops a finding with no note — it would render as an empty instruction", () => {
    const text = "```json\n" +
      JSON.stringify({
        kind: "anton.review-score",
        round: 1,
        score: 3,
        blocking: 1,
        advisory: 0,
        verdict: "unresolved",
        findings: [{ severity: "blocking", location: "x.ts" }, { note: "real one" }],
      }) +
      "\n```";
    expect(parseReviewScoreComment(comment(text))?.findings).toEqual([
      // A finding with no location still says something; one with no note says nothing.
      { severity: "advisory", location: "(general)", note: "real one" },
    ]);
  });

  it("carries bd's own timestamp so rounds can be shown in board order", () => {
    const at = "2026-07-30T10:00:00Z";
    expect(
      parseReviewScoreComment(
        comment(formatReviewScoreComment({ round: 1, score: 8, blocking: 0, advisory: 0, verdict: "clean" }), at),
      )?.at,
    ).toBe(at);
  });
});

describe("reviewReportOf", () => {
  it("replays every round in thread order, past unrelated comments", () => {
    const report = reviewReportOf(
      bead([
        comment("scan-triage left this here"),
        round({ round: 1, score: 4, blocking: 2, advisory: 0, verdict: "fixed" }),
        round({ round: 2, score: 8, blocking: 0, advisory: 1, verdict: "clean" }),
      ]),
    );
    expect(report.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(report.score).toBe(8);
  });

  it("offers the LAST round's findings — the earlier ones were fixed and re-reviewed", () => {
    const report = reviewReportOf(
      bead([
        round({
          round: 1,
          score: 4,
          blocking: 1,
          advisory: 0,
          verdict: "fixed",
          findings: [{ severity: "blocking", location: "a.ts", note: "stale" }],
        }),
        round({
          round: 2,
          score: 6,
          blocking: 0,
          advisory: 1,
          verdict: "clean",
          findings: [{ severity: "advisory", location: "b.ts", note: "current" }],
        }),
      ]),
    );
    expect(report.findings).toEqual([{ severity: "advisory", location: "b.ts", note: "current" }]);
  });

  it("falls back to the last round that reported anything, so a silent final round loses nothing", () => {
    const report = reviewReportOf(
      bead([
        round({
          round: 1,
          score: 3,
          blocking: 1,
          advisory: 0,
          verdict: "fixed",
          findings: [{ severity: "blocking", location: "a.ts", note: "still open" }],
        }),
        round({ round: 2, blocking: 0, advisory: 0, verdict: "protocol-violation" }),
      ]),
    );
    expect(report.findings).toEqual([{ severity: "blocking", location: "a.ts", note: "still open" }]);
    // The score is the last VALID one — a protocol violation must not erase what round 1 earned.
    expect(report.score).toBe(3);
  });

  it("reads a never-reviewed target as an empty report rather than failing", () => {
    expect(reviewReportOf(bead([]))).toEqual({ rounds: [], findings: [], score: undefined });
  });
});
