/**
 * What the pass is SHOWN (anton-d2sx): the board rendered as the only read of it a session ever
 * gets. The prompt is the whole input to an unattended judgment, so a fact this section omits is a
 * fact no proposal can rest on — and one it renders wrongly is a proposal made about a board that
 * does not exist.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import { MAX_GOAL_CHARS } from "./bead-line";
import { formatPmBoardContext } from "./board-context";

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", priority: 2, ...o };
}

const NOW = Date.parse("2026-08-04T12:00:00Z");

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
    // The container groups run targets rather than being one, so it is neither a target nor work.
    expect(sectionOf(text, "Run targets")).not.toContain("- anton-cont ");
    expect(sectionOf(text, "Work no run target carries")).toContain("- anton-orphan");
  });

  // A home claim the pass cannot see is a home claim it cannot make: grouped rendering alone says
  // WHERE a bead sits in this prompt, never where it sits on the board.
  it("names the epic a run target hangs off, id and title both", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-home", { issue_type: "epic", title: "Payments rails" }),
        bead("anton-under", { issue_type: "feature", parent: "anton-home" }),
      ],
      now: NOW,
    });
    expect(sectionOf(text, "Run targets")).toContain(
      `- anton-under [feature] · P2 · under anton-home "Payments rails"`,
    );
  });

  it("names the card that carries each ticket, at any depth", () => {
    const text = formatPmBoardContext({
      board: [...board, bead("anton-sub", { parent: "anton-tick" })],
      now: NOW,
    });
    const targets = sectionOf(text, "Run targets");
    expect(targets).toMatch(/ {2}- anton-tick [^\n]*under anton-feat "anton-feat"/);
    // The nesting shows anton-sub under the feature that RUNS it; only the line says what holds it.
    expect(targets).toMatch(/ {2}- anton-sub [^\n]*under anton-tick "anton-tick"/);
  });

  // A nested ticket's PARENT is a bead no rehome could ever name as a home (a ticket's home must be
  // a card), so a line showing only the parent reads as a ticket hanging off a non-card — and the
  // repair for that appearance is a proposal to flatten nesting somebody meant.
  it("names the run target that ships a nested ticket, not just the ticket above it", () => {
    const text = formatPmBoardContext({
      board: [...board, bead("anton-sub", { parent: "anton-tick" })],
      now: NOW,
    });
    const targets = sectionOf(text, "Run targets");
    expect(targets).toMatch(
      / {2}- anton-sub [^\n]*under anton-tick "anton-tick" · shipped by anton-feat "anton-feat"/,
    );
    // Said only where it adds something: a ticket hanging straight off its own run target repeats it.
    expect(targets).not.toMatch(/ {2}- anton-tick [^\n]*shipped by/);
  });

  // `rehome` is a claim about a home that is WRONG, and anton refuses one about a bead with none.
  // A parentless task/bug is a RUN TARGET, so it renders here rather than in the loose section that
  // says as much — silence on its line read as a home the pass had merely not been told.
  it("says outright when a run target hangs under nothing at all", () => {
    const text = formatPmBoardContext({
      board: [...board, bead("anton-bug", { issue_type: "bug", priority: 0 })],
      now: NOW,
    });
    expect(sectionOf(text, "Run targets")).toContain(
      "- anton-bug [bug] · P0 · under nothing (no home to be the wrong one)",
    );
  });

  // Without the contract text the pass is left judging homes by their names, which its own contract
  // forbids: it must either omit every home claim or guess from the shape of the words.
  it("carries what each bead states it is for, subjects and candidate homes alike", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-home", {
          issue_type: "epic",
          title: "Billing",
          description: "## Goal\n\nOwn every surface that charges a customer.\n\n## Success Criteria\n\n- billed",
        }),
        bead("anton-card", { issue_type: "feature", parent: "anton-home" }),
        bead("anton-loose", {
          issue_type: "feature",
          // No `## Goal`: an unshaped bead still says something about itself.
          description: "Retry a failed card charge before we drop the subscription.",
        }),
      ],
      now: NOW,
    });
    expect(sectionOf(text, "Container epics")).toContain(
      "goal: Own every surface that charges a customer.",
    );
    expect(sectionOf(text, "Run targets")).toContain(
      "goal: Retry a failed card charge before we drop the subscription.",
    );
  });

  // `goalBody` returns the formula's TODO prompt when nothing is authored, so a scaffolded bead has
  // stated nothing — while the prompt tells the pass every `goal:` line is the bead's own contract
  // text and the only evidence a home claim may rest on. Rendering the placeholder would let a home
  // be proposed on words the approval gate itself treats as missing.
  it("renders no goal for a bead still carrying the formula's TODO prompt", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-todo", {
          issue_type: "feature",
          description: "## Goal\n\nTODO — what does this make true?\n\n## Success Criteria\n\n- [ ]",
        }),
      ],
      now: NOW,
    });
    const targets = sectionOf(text, "Run targets");
    expect(targets).toContain("- anton-todo [feature]");
    expect(targets.split("\n").some((l) => l.trim().startsWith("goal:"))).toBe(false);
  });

  it("cuts a long goal rather than carrying a whole contract per bead", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-long", {
          issue_type: "feature",
          description: `## Goal\n\n${"word ".repeat(200)}`,
        }),
      ],
      now: NOW,
    });
    const goal = text.split("\n").find((l) => l.trim().startsWith("goal:")) ?? "";
    expect(goal).toHaveLength(`  goal: `.length + MAX_GOAL_CHARS + 1);
    expect(goal.endsWith("…")).toBe(true);
    // The cut is only honest if the pass is told the rest of the contract is not in the prompt.
    expect(text).toContain("is NOT in this prompt");
  });

  it("shows a container epic that runs nothing of its own, since it is still a candidate home", () => {
    const text = formatPmBoardContext({
      board: [
        bead("anton-cont", { issue_type: "epic", title: "Billing" }),
        bead("anton-child", { issue_type: "feature", parent: "anton-cont" }),
        bead("anton-empty", { issue_type: "epic", title: "Growth", parent: "anton-cont" }),
        bead("anton-shell", { issue_type: "feature", parent: "anton-empty" }),
      ],
      now: NOW,
    });
    const homes = sectionOf(text, "Container epics");
    // Counted transitively: anton-shell rides anton-empty, and anton-empty rides anton-cont.
    expect(homes).toMatch(/- anton-cont \[epic\][^\n]*2 open run target\(s\) beneath it/);
    expect(homes).toMatch(/- anton-empty \[epic\][^\n]*1 open run target\(s\) beneath it/);
    // Nested containers are homes too, and carry their own parentage.
    expect(homes).toMatch(/- anton-empty \[epic\][^\n]*under anton-cont "Billing"/);
  });

  it("truncates the containers and each card's tickets rather than losing them silently", () => {
    const crowded = [
      bead("anton-card", { issue_type: "feature" }),
      ...Array.from({ length: 15 }, (_, i) => bead(`anton-t${i}`, { parent: "anton-card" })),
      ...Array.from({ length: 80 }, (_, i) => [
        bead(`anton-c${String(i).padStart(2, "0")}`, { issue_type: "epic" }),
        bead(`anton-cf${String(i).padStart(2, "0")}`, {
          issue_type: "feature",
          parent: `anton-c${String(i).padStart(2, "0")}`,
        }),
      ]).flat(),
    ];
    const text = formatPmBoardContext({ board: crowded, now: NOW });
    expect(text).toContain("…and 3 more ticket(s) under anton-card, not shown");
    expect(text).toMatch(/20 further container epic\(s\) are NOT shown/);
    expect(sectionOf(text, "Container epics").split("\n").filter((l) => l.startsWith("- "))).toHaveLength(60);
  });

  it("keeps the pass on one board it cannot write to", () => {
    const text = formatPmBoardContext({ board, now: NOW });
    expect(text).toContain("It is the only");
    expect(text).toContain("board you have — you cannot run `bd`");
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

  // The other half of "a run owns it": a claim the run-lease has not caught up to. No liveness signal
  // sees it, so without the flag the pass reads a ticket a machine is working as free work.
  it("marks work a run has claimed but not yet leased", () => {
    const held = bead("anton-held", {
      issue_type: "feature",
      status: "in_progress",
      assignee: "runner-7",
    });
    expect(formatPmBoardContext({ board: [held], now: NOW })).toContain("CLAIMED by runner-7");
  });

  it("says what a cap dropped, so absence never reads as an empty board", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      bead(`anton-f${String(i).padStart(2, "0")}`, { issue_type: "feature" }),
    );
    const text = formatPmBoardContext({ board: many, now: NOW });
    expect(text).toMatch(/20 further run target\(s\) are NOT shown/);
  });
});
