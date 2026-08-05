/**
 * The product-master protocol (anton-d2sx): what the pass is shown, what it is required to say back,
 * and — the half that actually protects the board — what anton refuses to file on its behalf.
 *
 * Three properties carry this module:
 *   • an EMPTY report is the healthy answer and a BROKEN one is a failure, and nothing may blur them;
 *   • every claim is checked against the board before it becomes a bead, because a language model
 *     naming a bead id is a guess until something looks;
 *   • the fingerprints come from the claim's content, so the same judgment reached twice is one ask.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import { detectionsFor, formatPmBoardContext, parsePmReport, type PmClaim } from "./context";

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", priority: 2, ...o };
}

const NOW = Date.parse("2026-08-04T12:00:00Z");

/** A report block exactly as the protocol demands it — the shape every parse case varies from. */
const report = (body: string): string => `Here is what I found.\n\n\`\`\`json\n${body}\n\`\`\``;

const claim = (o: Partial<PmClaim> = {}): PmClaim => ({
  kind: "kill",
  bead: "anton-a",
  summary: "nothing wants this any more",
  evidence: ["three reviews at 3, 2, 2"],
  ...o,
});

describe("formatPmBoardContext", () => {
  const board = [
    bead("anton-epic", { issue_type: "epic" }),
    bead("anton-feat", {
      issue_type: "feature",
      priority: 1,
      labels: ["size:L"],
      dependencies: [{ issue_id: "anton-feat", depends_on_id: "anton-other", type: "blocks" }],
    }),
    bead("anton-tick", {
      parent: "anton-feat",
      labels: ["size:S"],
      updated_at: "2026-07-05T12:00:00Z",
    }),
    bead("anton-other", { issue_type: "feature", priority: 0 }),
  ];

  it("carries the facts a ranking judgment rests on: tier, priority, size, age, ordering", () => {
    const text = formatPmBoardContext({ board, now: NOW });
    expect(text).toContain("anton-feat [feature] · P1 · size:L");
    expect(text).toContain("blocked by anton-other");
    // The ticket hangs under the feature, so it is rendered inside that card's block.
    expect(text).toMatch(/anton-feat[^\n]*\n {2}- anton-tick/);
    expect(text).toContain("30d since last write");
  });

  /** One `### ` block of the rendered context, so a section's CONTENTS can be asserted on. */
  const sectionOf = (text: string, heading: string): string =>
    text.split(`### ${heading}\n`)[1]?.split("\n### ")[0] ?? "";

  // The bug this guards: a parentless task/bug IS a run target (beads.isRunTarget, the approve
  // route's standalone branch), but it is not a board CARD — so splitting on cards filed the most
  // urgent thing on the board under "nothing will ship this", which is a kill proposal waiting to
  // happen against the work anton runs next.
  it("renders a standalone run target as its own block, not as work nothing will ship", () => {
    const text = formatPmBoardContext({
      board: [...board, bead("anton-bug", { issue_type: "bug", priority: 0 })],
      now: NOW,
    });
    expect(sectionOf(text, "Run targets")).toContain("- anton-bug [bug] · P0");
    expect(text).not.toContain("Work no run target carries");
  });

  it("carries a ticket under the run target that ships it, however deep it hangs", () => {
    const text = formatPmBoardContext({
      board: [...board, bead("anton-sub", { parent: "anton-tick" })],
      now: NOW,
    });
    expect(sectionOf(text, "Run targets")).toMatch(/anton-feat[^\n]*\n(?: {2}- anton-\w+\n)* {2}- anton-sub/);
  });

  it("still flags work a container epic holds — no run target carries it", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-cont", { issue_type: "epic" }),
        bead("anton-child", { issue_type: "feature", parent: "anton-cont" }),
        bead("anton-orphan", { parent: "anton-cont" }),
      ],
      now: NOW,
    });
    expect(sectionOf(text, "Run targets")).toContain("- anton-child [feature]");
    // The container itself is a grouping shell, so it is neither a run target nor loose work.
    expect(text).not.toContain("anton-cont ");
    expect(sectionOf(text, "Work no run target carries")).toContain("- anton-orphan");
  });

  it("carries the review-score SERIES, which no board read alone can produce", () => {
    const text = formatPmBoardContext({
      board,
      scores: new Map([["anton-feat", [7, 4, 3]]]),
      now: NOW,
    });
    expect(text).toContain("review scores 7,4,3");
  });

  it("names the asks already on the board, open and declined alike", () => {
    const text = formatPmBoardContext({
      board: [
        ...board,
        bead("anton-p1", { title: "an open ask", labels: ["pm:low-value:0123456789ab"] }),
        bead("anton-p2", {
          title: "an answered ask",
          status: "closed",
          labels: ["pm:oversized:0123456789ab", LABELS.abandoned],
        }),
      ],
      now: NOW,
    });
    expect(text).toContain("OPEN anton-p1 — an open ask");
    expect(text).toContain("DECLINED anton-p2 — an answered ask");
  });

  it("marks work a run owns, because proposing against it races the run", () => {
    const live = bead("anton-live", {
      issue_type: "feature",
      labels: [LABELS.runLease(NOW + 600_000, "abc")],
    });
    expect(formatPmBoardContext({ board: [live], now: NOW })).toContain("IN FLIGHT");
  });

  it("says what a cap dropped, so absence never reads as an empty board", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      bead(`anton-f${String(i).padStart(2, "0")}`, { issue_type: "feature" }),
    );
    const text = formatPmBoardContext({ board: many, now: NOW });
    expect(text).toMatch(/20 further run target\(s\) are NOT shown/);
  });
});

describe("parsePmReport", () => {
  it("reads the claims out of the last report block", () => {
    const result = parsePmReport(
      report(`{"proposals":[{"kind":"kill","bead":"anton-a","summary":"s","evidence":["e"]}]}`),
    );
    expect(result).toEqual({
      ok: true,
      claims: [{ kind: "kill", bead: "anton-a", summary: "s", evidence: ["e"] }],
    });
  });

  it("reads an EMPTY list as the healthy answer, not as a failure", () => {
    expect(parsePmReport(report(`{"proposals":[]}`))).toEqual({ ok: true, claims: [] });
  });

  // The one confusion the whole protocol exists to prevent: a pass that said nothing anton could
  // read must never be recorded as a board with nothing to say.
  it.each([
    ["no report at all", "I looked at the board and it seems fine."],
    ["a null list", report(`{"proposals":null}`)],
    ["one garbled entry", report(`{"proposals":[{"kind":"kill","bead":"anton-a"}]}`)],
    ["an unknown kind", report(`{"proposals":[{"kind":"rewrite","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a reprioritize with no priority", report(`{"proposals":[{"kind":"reprioritize","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a reprioritize with a bogus priority", report(`{"proposals":[{"kind":"reprioritize","bead":"a","priority":"P9","summary":"s","evidence":["e"]}]}`)],
    ["a split with a single piece", report(`{"proposals":[{"kind":"split","bead":"a","pieces":["one"],"summary":"s","evidence":["e"]}]}`)],
    ["evidence-free judgment", report(`{"proposals":[{"kind":"kill","bead":"a","summary":"s","evidence":[]}]}`)],
  ])("refuses %s rather than reading it as a healthy board", (_label, text) => {
    const result = parsePmReport(text);
    expect(result.ok).toBe(false);
    expect((result as { claims?: unknown }).claims).toBeUndefined();
  });

  it("refuses trailing prose, which is where a session takes a report back", () => {
    const text = `${report(`{"proposals":[]}`)}\n\nCorrection: anton-a should actually be killed.`;
    expect(parsePmReport(text)).toEqual({ ok: false, violation: "trailing-content" });
  });

  it("skips an unrelated json block on the way to the report", () => {
    const text = `\`\`\`json\n{"some":"bead body"}\n\`\`\`\n\n${report(`{"proposals":[]}`)}`;
    expect(parsePmReport(text)).toEqual({ ok: true, claims: [] });
  });

  it("does not fall back to an earlier draft when the final block is broken", () => {
    const text = `${report(`{"proposals":[]}`)}\n\n${report(`{"proposals":[{`)}`;
    expect(parsePmReport(text).ok).toBe(false);
  });
});

describe("detectionsFor", () => {
  const subject = bead("anton-a", { priority: 3 });
  const blocker = bead("anton-b");

  it("turns each accepted claim into the detection its move needs, fingerprinted by content", () => {
    const { detections, rejected } = detectionsFor(
      [
        claim({ kind: "reprioritize", priority: "P1" }),
        claim({ kind: "order", blockedBy: "anton-b" }),
        claim({ kind: "split", pieces: ["the API half", "the UI half"] }),
        claim({ kind: "kill" }),
      ],
      [subject, blocker],
      NOW,
    );
    expect(rejected).toEqual([]);
    expect(detections.map((d) => [d.kind, d.move, d.fingerprint.split(":")[0]])).toEqual([
      ["mispriority", "reprioritize", "pm"],
      ["missing-order", "link", "pm"],
      ["oversized", "split", "pm"],
      ["low-value", "retire", "pm"],
    ]);
    // The priority is part of the claim's identity — two priorities for one bead are two asks.
    expect(detections[0].detail).toBe("P1");
    expect(detections[0].subjectKey).toBe("mispriority:anton-a#P1");
    expect(detections[1].target).toBe("anton-b");
    expect(detections[3].retireAs).toBe("defer");
  });

  it("carries the decomposition sketch onto the split proposal — an ask without it is not actionable", () => {
    const { detections } = detectionsFor(
      [claim({ kind: "split", pieces: ["the API half", "the UI half"] })],
      [subject],
      NOW,
    );
    expect(detections[0].evidence).toEqual([
      "three reviews at 3, 2, 2",
      "proposed ticket 1: the API half",
      "proposed ticket 2: the UI half",
    ]);
  });

  it("reaches the same fingerprint for the same judgment made twice", () => {
    const once = detectionsFor([claim()], [subject], NOW).detections[0];
    const again = detectionsFor([claim({ summary: "worded differently" })], [subject], NOW)
      .detections[0];
    expect(again.fingerprint).toBe(once.fingerprint);
  });

  it.each([
    ["a bead that is not on the board", claim({ bead: "anton-ghost" }), /not on the board/],
    [
      "a bead that already settled",
      claim({ bead: "anton-done" }),
      /already settled/,
    ],
    ["a bead a run owns", claim({ bead: "anton-live" }), /mid-run/],
    ["a proposal bead", claim({ bead: "anton-prop" }), /itself a proposal/],
    [
      "a priority the bead already carries",
      claim({ kind: "reprioritize", priority: "P3" }),
      /already at P3/,
    ],
    [
      "an ordering the graph already records",
      claim({ kind: "order", bead: "anton-linked", blockedBy: "anton-b" }),
      /already records an ordering/,
    ],
    [
      "an ordering that would close a cycle",
      claim({ kind: "order", bead: "anton-a", blockedBy: "anton-waits" }),
      /close a cycle/,
    ],
    [
      "a bead blocking itself",
      claim({ kind: "order", blockedBy: "anton-a" }),
      /cannot block itself/,
    ],
    [
      // A deferred bead is still OPEN work, so nothing above this catches it — and a kill applies as
      // `defer`, which apply settles as a no-op. The ask would cost a founder a decision and write
      // nothing at all.
      "a kill on a bead a previous kill already deferred",
      claim({ kind: "kill", bead: "anton-parked" }),
      /already deferred/,
    ],
  ])("refuses %s, and says why rather than dropping it", (_label, bad, reason) => {
    const board = [
      subject,
      blocker,
      bead("anton-done", { status: "closed" }),
      bead("anton-parked", { status: "deferred" }),
      bead("anton-live", { labels: [LABELS.runLease(NOW + 600_000, "abc")] }),
      bead("anton-prop", { labels: ["pm:low-value:0123456789ab"] }),
      bead("anton-linked", {
        dependencies: [{ issue_id: "anton-linked", depends_on_id: "anton-b", type: "blocks" }],
      }),
      // anton-waits ← anton-mid ← anton-a: no direct pair, but the edge would close the loop.
      bead("anton-waits", {
        dependencies: [{ issue_id: "anton-waits", depends_on_id: "anton-mid", type: "blocks" }],
      }),
      bead("anton-mid", {
        dependencies: [{ issue_id: "anton-mid", depends_on_id: "anton-a", type: "blocks" }],
      }),
    ];
    const { detections, rejected } = detectionsFor([bad], board, NOW);
    expect(detections).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(reason);
  });

  it("keeps the good claims when one in the batch is refused", () => {
    const { detections, rejected } = detectionsFor(
      [claim({ bead: "anton-ghost" }), claim()],
      [subject],
      NOW,
    );
    expect(detections.map((d) => d.subjects)).toEqual([["anton-a"]]);
    expect(rejected).toHaveLength(1);
  });
});
