/**
 * One bead as the pass READS it (anton-mspj): which facts ride along, how each renders, and — just
 * as load-bearing — which are deliberately withheld.
 *
 * The prompt is the whole input to an unattended judgment, so every line here is evidence a claim
 * may rest on: a fact rendered wrongly is a proposal made about a board that does not exist, and a
 * fact silently dropped is one no proposal can ever cite.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { indexBoard } from "../gardener/board-index";
import { beadLines, MAX_GOAL_CHARS, MAX_SCORE_ROUNDS } from "./bead-line";
import { bead, NOW } from "./board.fixture";

const THIRTY_DAYS_AGO = "2026-07-05T12:00:00Z";

const card = bead("anton-card", { issue_type: "feature", title: "Charge retries" });
const ticket = bead("anton-t", {
  parent: card.id,
  priority: 1,
  labels: ["size:M"],
  updated_at: THIRTY_DAYS_AGO,
  dependencies: [{ issue_id: "anton-t", depends_on_id: "anton-b", type: "blocks" }],
});

const BOARD = [
  card,
  ticket,
  bead("anton-b", { title: "the API contract" }),
  // `feature → task → subtask`: the subtask ships in the CARD's run, not its parent's.
  bead("anton-sub", { parent: ticket.id }),
  bead("anton-orphan", { parent: "anton-gone" }),
];

const index = indexBoard(BOARD);

/** The facts line one bead of the fixture board renders, with its goal line (when any) dropped. */
const factsOf = (id: string, indent = "", extras: (string | undefined)[] = []): string =>
  beadLines(index.byId.get(id) as Bead, index, { now: NOW }, indent, extras)[0];

/** The same, for the facts a bead states about ITSELF — no board around it to change the answer. */
const aloneOf = (o: Partial<Bead>): string => {
  const subject = bead("anton-one", o);
  return beadLines(subject, indexBoard([subject]), { now: NOW }, "")[0];
};

describe("beadLines", () => {
  it("renders a bead's facts in one line, in a fixed order, followed by its title", () => {
    expect(factsOf("anton-t")).toBe(
      '- anton-t [task] · P1 · size:M · 30d since last write · under anton-card "Charge retries" · blocked by anton-b — anton-t',
    );
  });

  it("indents the line and folds the caller's own facts in ahead of the shared ones", () => {
    expect(factsOf("anton-b", "  ", ["oversized", undefined])).toBe(
      "  - anton-b [task] · P2 · under nothing (no home to be the wrong one) · oversized — the API contract",
    );
  });

  // `rehome` is a claim about a home that is WRONG, and anton refuses one about a bead that has
  // none — so silence here read as a home the pass had merely not been told.
  it("says a homeless bead has no home rather than rendering nothing", () => {
    expect(factsOf("anton-b")).toContain("under nothing (no home to be the wrong one)");
  });

  it("names a parent the board does not hold rather than hiding the dangling pointer", () => {
    expect(factsOf("anton-orphan")).toContain("under anton-gone (not on the board)");
  });

  // A subtask rides the CARD's run and its PR, so a line showing only its parent read as a ticket
  // hanging off a non-card — and the repair for that appearance is a proposal to flatten nesting
  // somebody meant.
  it("names the run target that will ship the bead when that is not its parent", () => {
    expect(factsOf("anton-sub")).toContain('shipped by anton-card "Charge retries"');
  });

  it("omits `shipped by` when the parent is the run target itself", () => {
    expect(factsOf("anton-t")).not.toContain("shipped by");
  });

  // "We can't measure this" must never read as "touched today".
  it("omits the age of a bead carrying no readable stamp", () => {
    expect(factsOf("anton-b")).not.toContain("since last write");
  });

  it("shows the review-score series, the one evidence a board read alone cannot produce", () => {
    const [line] = beadLines(
      ticket,
      index,
      { now: NOW, scores: new Map([[ticket.id, [7, 4, 3]]]) },
      "",
    );
    expect(line).toContain("review scores 7,4,3");
  });

  it("caps the series at the last rounds and marks that it was cut", () => {
    const series = Array.from({ length: MAX_SCORE_ROUNDS + 2 }, (_, i) => i);
    const [line] = beadLines(ticket, index, { now: NOW, scores: new Map([[ticket.id, series]]) }, "");
    expect(line).toContain(`review scores …,${series.slice(-MAX_SCORE_ROUNDS).join(",")}`);
  });

  it("omits the series for a bead nobody reviewed, which is not a bead that scored zero", () => {
    expect(factsOf("anton-t")).not.toContain("review scores");
  });

  // A proposal against either half is refused at filing time; a session that cannot see the claim
  // spends its judgment on asks the board will throw away.
  it("marks a bead a run is shipping", () => {
    expect(aloneOf({ labels: [LABELS.runLease(NOW + 600_000, "abc")] })).toContain(
      "IN FLIGHT — a run owns it, do not propose against it",
    );
  });

  it("marks a bead a run has claimed but not yet leased", () => {
    expect(aloneOf({ status: "in_progress", assignee: "runner-7" })).toContain(
      "CLAIMED by runner-7 — a run has picked it up, do not propose against it",
    );
  });

  // Rendered only when the label IS there: marking every unapproved bead would read as an
  // invitation to propose a start for each of them.
  it("marks the gate only where it is already granted", () => {
    expect(aloneOf({ labels: [LABELS.approved] })).toContain(
      "approved — the gate is already granted",
    );
    expect(factsOf("anton-t")).not.toContain("approved");
  });

  it("marks a bead a previous kill already deferred", () => {
    expect(aloneOf({ status: "deferred" })).toContain("· deferred");
  });

  describe("the goal line", () => {
    /** The bead's own second line — what it says it is FOR — or undefined when it states nothing. */
    const goalOf = (o: Partial<Bead>): string | undefined => {
      const subject = bead("anton-g", o);
      return beadLines(subject, indexBoard([subject]), { now: NOW }, "")[1];
    };

    it("quotes what the bead states it is for, on its own line", () => {
      expect(goalOf({ description: "## Goal\n\nRetry a charge the bank soft-declined.\n" })).toBe(
        "  goal: Retry a charge the bank soft-declined.",
      );
    });

    // An unshaped bead still says something about itself, and a reader that knew only the heading
    // rendered nothing at all for it.
    it("falls back to the description's opening prose when no section states a goal", () => {
      expect(goalOf({ description: "Retry a charge.\n\n## Context\n\nBilling." })).toBe(
        "  goal: Retry a charge.",
      );
    });

    // The line is quoted as the only evidence a home claim may rest on, so rendering the formula's
    // placeholder would let a home be proposed on words the approval gate treats as missing.
    it("omits the formula's TODO prompt, which the gate itself counts as unwritten", () => {
      expect(goalOf({ description: "## Goal\n\nTODO — what this is for\n" })).toBeUndefined();
    });

    it("omits the line entirely for a bead with no description", () => {
      expect(goalOf({})).toBeUndefined();
    });

    it("flattens a multi-line goal, so one fact stays one line", () => {
      expect(goalOf({ description: "## Goal\n\nRetry a charge\nthe bank soft-declined.\n" })).toBe(
        "  goal: Retry a charge the bank soft-declined.",
      );
    });

    it("cuts a long goal at the cap and marks the cut", () => {
      const long = "x".repeat(MAX_GOAL_CHARS + 40);
      expect(goalOf({ description: `## Goal\n\n${long}\n` })).toBe(
        `  goal: ${"x".repeat(MAX_GOAL_CHARS)}…`,
      );
    });
  });
});
