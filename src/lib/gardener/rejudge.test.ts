/**
 * Re-judgement of deferred work (anton-c009), driven over fixture boards.
 *
 * The threshold is the whole detector, so both sides of it are asserted on every axis that can move
 * it: the day before, the day of, an override in either direction, and an undated bead that can be
 * measured at all. The rest is the bar for what may be re-asked — a parked subtree is one question,
 * and an answer already recorded is not one.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { indexBoard } from "./board-index";
import { KINDS, REASK_AFTER_DAYS } from "./detections";
import {
  detectDeferredRejudgement,
  detectDeferredRejudgements,
  REJUDGE_DEFERRED_DAYS,
  type RejudgeOptions,
} from "./rejudge";

const NOW = Date.parse("2026-09-06T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const bead = (id: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  updated_at: daysAgo(1),
  ...over,
});

/** A bead parked `days` ago and untouched since — the shape this detector exists to find. */
const parked = (id: string, days: number, over: Partial<Bead> = {}): Bead =>
  bead(id, { status: "deferred", updated_at: daysAgo(days), ...over });

const rejudge = (board: Bead[], options?: RejudgeOptions) =>
  detectDeferredRejudgement(indexBoard(board), NOW, options);

const subjects = (board: Bead[], options?: RejudgeOptions) =>
  rejudge(board, options).map((r) => r.subject);

describe("the threshold", () => {
  it("stays silent on a bead parked one day short of the window", () => {
    expect(subjects([parked("anton-a", REJUDGE_DEFERRED_DAYS - 1)])).toEqual([]);
  });

  it("fires on the day the bead reaches the window", () => {
    const found = rejudge([parked("anton-a", REJUDGE_DEFERRED_DAYS)]);

    expect(found).toHaveLength(1);
    expect(found[0].subject).toBe("anton-a");
    expect(found[0].subjects).toEqual(["anton-a"]);
    expect(found[0].ageDays).toBe(REJUDGE_DEFERRED_DAYS);
    expect(found[0].summary).toContain(`${REJUDGE_DEFERRED_DAYS} days`);
  });

  it("carries no move — the verb is the caller's decision, not the detector's", () => {
    const [found] = rejudge([parked("anton-a", REJUDGE_DEFERRED_DAYS)]);

    expect(found).not.toHaveProperty("move");
    expect(found).not.toHaveProperty("kind");
    expect(found).not.toHaveProperty("retireAs");
  });

  it("honours a shorter configured window, and states it in the evidence", () => {
    const board = [parked("anton-a", 30)];

    expect(subjects(board)).toEqual([]);
    expect(subjects(board, { afterDays: 30 })).toEqual(["anton-a"]);
    expect(rejudge(board, { afterDays: 30 })[0].evidence.join("\n")).toContain(
      "past the 30-day re-judgement window",
    );
  });

  it("honours a longer configured window", () => {
    expect(subjects([parked("anton-a", 100)], { afterDays: 180 })).toEqual([]);
  });

  it("falls back to the stated window when the override is not a usable number", () => {
    const board = [parked("anton-a", REJUDGE_DEFERRED_DAYS)];

    for (const afterDays of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(subjects(board, { afterDays })).toEqual(["anton-a"]);
    }
    expect(subjects([parked("anton-b", 10)], { afterDays: Number.NaN })).toEqual([]);
  });

  it("says nothing about a bead carrying no readable stamp", () => {
    expect(
      subjects([bead("anton-a", { status: "deferred", updated_at: undefined })]),
    ).toEqual([]);
  });

  it("dates an undated-but-created bead from its creation", () => {
    expect(
      subjects([
        bead("anton-a", {
          status: "deferred",
          updated_at: undefined,
          created_at: daysAgo(REJUDGE_DEFERRED_DAYS + 5),
        }),
      ]),
    ).toEqual(["anton-a"]);
  });
});

describe("what may be re-asked", () => {
  it("ignores every status that is not deferred, however old", () => {
    expect(
      subjects([
        bead("anton-open", { updated_at: daysAgo(400) }),
        bead("anton-blocked", { status: "blocked", updated_at: daysAgo(400) }),
        bead("anton-running", { status: "in_progress", updated_at: daysAgo(400) }),
        bead("anton-done", { status: "closed", updated_at: daysAgo(400) }),
      ]),
    ).toEqual([]);
  });

  it("leaves an abandoned bead alone — the won't-do is the answer this asks for", () => {
    expect(
      subjects([parked("anton-a", 400, { labels: [LABELS.abandoned] })]),
    ).toEqual([]);
  });

  it("asks once per parked subtree, at the top", () => {
    expect(
      subjects([
        parked("anton-card", 200, { issue_type: "feature" }),
        parked("anton-t1", 200, { parent: "anton-card" }),
        parked("anton-t2", 200, { parent: "anton-card" }),
        bead("anton-t3", { parent: "anton-card" }),
      ]),
    ).toEqual(["anton-card"]);
  });

  it("asks about a parked ticket whose home is still live", () => {
    expect(
      subjects([
        bead("anton-card", { issue_type: "feature" }),
        parked("anton-t1", 200, { parent: "anton-card" }),
      ]),
    ).toEqual(["anton-t1"]);
  });

  it("survives a parent cycle rather than spinning on it", () => {
    expect(
      subjects([
        parked("anton-a", 200, { parent: "anton-b" }),
        parked("anton-b", 200, { parent: "anton-a" }),
      ]),
    ).toEqual([]);
  });

  it("files nothing on a board with nothing parked", () => {
    expect(rejudge([bead("anton-a"), bead("anton-b", { issue_type: "feature" })])).toEqual([]);
  });
});

describe("the evidence a human decides on", () => {
  it("names the silence, the bead, its home and its blast radius", () => {
    const [found] = rejudge([
      parked("anton-card", 120, { issue_type: "feature", title: "The parked card" }),
      bead("anton-t1", { parent: "anton-card", updated_at: daysAgo(120) }),
    ]);
    const evidence = found.evidence.join("\n");

    expect(evidence).toContain("120 days ago");
    expect(evidence).toContain(`past the ${REJUDGE_DEFERRED_DAYS}-day re-judgement window`);
    expect(evidence).toContain('feature P? "The parked card"');
    expect(evidence).toContain("parented to nothing");
    expect(evidence).toContain("anton-t1");
    expect(evidence).toContain("decides the whole subtree");
  });

  it("names the home a parked ticket hangs under", () => {
    const [found] = rejudge([
      bead("anton-card", { issue_type: "feature", title: "Live card" }),
      parked("anton-t1", 120, { parent: "anton-card", priority: 2 }),
    ]);

    expect(found.evidence.join("\n")).toContain('parked under anton-card ("Live card")');
    expect(found.evidence.join("\n")).toContain("task P2");
    expect(found.evidence.join("\n")).toContain("decides this bead alone");
  });

  it("warns when returning the bead would put it straight into the claimable pool", () => {
    const [approved] = rejudge([parked("anton-a", 120, { labels: [LABELS.approved] })]);
    const [unapproved] = rejudge([parked("anton-b", 120)]);

    expect(approved.evidence.join("\n")).toContain("the answer starts a run");
    expect(unapproved.evidence.join("\n")).toContain("queues a decision rather than a run");
  });
});

describe("order", () => {
  it("puts the longest silence first, and is stable across passes", () => {
    const board = [
      parked("anton-b", 100),
      parked("anton-c", 300),
      parked("anton-a", 100),
    ];

    expect(subjects(board)).toEqual(["anton-c", "anton-a", "anton-b"]);
    expect(subjects(board)).toEqual(subjects([...board].reverse()));
  });
});

/**
 * The verb (anton-rozm). The detector states the question; this is the one answer anton is entitled
 * to make into a move, and it travels as an ordinary detection so emission, dedup and apply need to
 * know nothing about re-judgement at all.
 */
describe("the move the pass attaches", () => {
  const proposed = (board: Bead[]) => detectDeferredRejudgements(indexBoard(board), NOW);

  it("asks to UNDEFER — the reversible half; the permanent won't-do has no move here", () => {
    const [detection] = proposed([parked("anton-a", 120)]);

    expect(detection.kind).toBe("aged-defer");
    expect(detection.move).toBe("undefer");
    expect(detection.retireAs).toBeUndefined();
    expect(detection.subjects).toEqual(["anton-a"]);
  });

  it("keeps the claim's evidence and summary intact, and its ordering", () => {
    const board = [parked("anton-b", 100), parked("anton-c", 300)];
    const [first, second] = proposed(board);

    expect([first.subjects[0], second.subjects[0]]).toEqual(["anton-c", "anton-b"]);
    expect(first.evidence).toEqual(rejudge(board)[0].evidence);
    expect(first.summary).toBe(rejudge(board)[0].summary);
  });

  it("fingerprints one claim per parked bead, stably across passes", () => {
    const board = [parked("anton-a", 120), parked("anton-b", 120)];
    const [a, b] = proposed(board);

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(proposed(board).map((d) => d.fingerprint)).toEqual([a.fingerprint, b.fingerprint]);
  });

  it("says nothing at all on a board with no aged parking", () => {
    expect(proposed([parked("anton-a", REJUDGE_DEFERRED_DAYS - 1), bead("anton-b")])).toEqual([]);
  });

  // Two windows, one silence: the detector waits a quarter before asking, and a decline buys the
  // same quarter before it asks again. Stated in two modules because they answer different
  // questions; bound here so neither can drift into promising a silence the other does not keep.
  it("re-asks a declined proposal after the same silence it waited for in the first place", () => {
    expect(KINDS["aged-defer"].reask).toBe(REASK_AFTER_DAYS);
    expect(REASK_AFTER_DAYS).toBe(REJUDGE_DEFERRED_DAYS);
  });
});
