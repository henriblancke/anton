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

  it("reads a home claim as the subject and the home it names", () => {
    const result = parsePmReport(
      report(
        `{"proposals":[{"kind":"rehome","bead":"anton-a","home":"anton-epic","summary":"s","evidence":["e"]}]}`,
      ),
    );
    expect(result).toEqual({
      ok: true,
      claims: [
        { kind: "rehome", bead: "anton-a", home: "anton-epic", summary: "s", evidence: ["e"] },
      ],
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
    // A home claim names two beads, and "this is misfiled" without the second names no move at all.
    ["a rehome with no home", report(`{"proposals":[{"kind":"rehome","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a rehome whose home is blank", report(`{"proposals":[{"kind":"rehome","bead":"a","home":"  ","summary":"s","evidence":["e"]}]}`)],
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
    // A block that tried to be the report and failed IS the report — say WHICH way it broke, so a
    // log reader can tell a garbled report from a session that emitted none.
    expect(parsePmReport(text)).toEqual({ ok: false, violation: "malformed-proposals" });
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
      // A proposal is open work, so nothing above catches it — but it closes the moment the founder
      // answers it, and the edge outlives it. The subject would wait forever on a settled ask.
      "an ordering against a proposal bead",
      claim({ kind: "order", blockedBy: "anton-prop" }),
      /is a proposal, not work/,
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

  // The home claim (anton-02po). One kind covers both tiers, so the accepted cases and the refusals
  // are asserted over a board that carries both shapes: a ticket under the wrong card, and a card
  // under the wrong epic.
  describe("a home claim", () => {
    /** The epic that already groups a card, so it is a container and may carry another. */
    const container = bead("anton-epic", { issue_type: "epic" });
    const grouped = bead("anton-f1", { issue_type: "feature", parent: container.id });
    /** Two cards: the wrong home a ticket rides today, and the right one. */
    const wrongCard = bead("anton-card1", { issue_type: "feature" });
    const rightCard = bead("anton-card2", { issue_type: "feature" });
    const ticket = bead("anton-t", { parent: wrongCard.id });
    /** A card whose own home is the wrong epic — the other half of the same claim. */
    const strayCard = bead("anton-stray", { issue_type: "feature", parent: "anton-other-epic" });
    const otherEpic = bead("anton-other-epic", { issue_type: "epic" });

    const board = [container, grouped, wrongCard, rightCard, ticket, strayCard, otherEpic];

    const rehome = (bead: string, home: string): PmClaim =>
      claim({ kind: "rehome", bead, home, summary: "it belongs over there" });

    it("moves a ticket to another card, and a card to the epic that groups it", () => {
      const { detections, rejected } = detectionsFor(
        [rehome(ticket.id, rightCard.id), rehome(strayCard.id, container.id)],
        board,
        NOW,
      );
      expect(rejected).toEqual([]);
      expect(detections.map((d) => [d.kind, d.move, d.subjects, d.target])).toEqual([
        ["misfiled", "reparent", [ticket.id], rightCard.id],
        ["misfiled", "reparent", [strayCard.id], container.id],
      ]);
      // The home is part of the claim's identity: two homes for one bead are two different asks.
      expect(detections[0].subjectKey).toBe(`misfiled:${ticket.id}>${rightCard.id}`);
      expect(detections[0].fingerprint.split(":")[0]).toBe("pm");
    });

    it.each([
      [
        "the home the bead already hangs under",
        () => rehome(ticket.id, wrongCard.id),
        /already hangs under anton-card1/,
      ],
      ["a home that is not on the board", () => rehome(ticket.id, "anton-ghost"), /not on the board/],
      ["the bead itself", () => rehome(ticket.id, ticket.id), /cannot be its own home/],
      ["a home that has settled", () => rehome(ticket.id, "anton-shut"), /already settled/],
      ["a home a run is shipping", () => rehome(ticket.id, "anton-live"), /mid-run/],
      [
        "a home a run has claimed but not yet leased",
        () => rehome(ticket.id, "anton-held"),
        /is held by runner-7/,
      ],
      ["a home that is itself a proposal", () => rehome(ticket.id, "anton-prop"), /is a proposal/],
      // The SUBJECT end of the same bar. A run working a ticket writes the assignee and
      // `in_progress` onto it while the run-lease lives on the card above, so `subjectRefusal`'s
      // liveness check waves it through — and a move out of that run's ticket set lands the commit
      // in the old card's PR while the bead hangs off the new one.
      [
        "a bead a run has claimed but not yet leased",
        () => rehome("anton-t-held", rightCard.id),
        /anton-t-held is held by runner-3/,
      ],
      // The tier taxonomy, asked through apply's own homeWrongTier so the filing check and the
      // approve check cannot disagree about which homes are legal.
      [
        "a ticket under something that is not a board card",
        () => rehome(ticket.id, container.id),
        /is not a board card/,
      ],
      [
        "a card under a card",
        () => rehome(strayCard.id, rightCard.id),
        /a card hangs off an epic and nothing else/,
      ],
      [
        "a card under an epic that groups no cards — the move would demote it out of its own run",
        () => rehome(strayCard.id, "anton-lone"),
        /is not a container epic/,
      ],
      [
        "a home that sits under the bead being moved",
        () => rehome(wrongCard.id, ticket.id),
        /would make the subtree its own ancestor/,
      ],
    ])("refuses %s, and says why rather than dropping it", (_label, bad, reason) => {
      const full = [
        ...board,
        bead("anton-shut", { issue_type: "feature", status: "closed" }),
        bead("anton-live", {
          issue_type: "feature",
          labels: [LABELS.runLease(NOW + 600_000, "abc")],
        }),
        bead("anton-held", {
          issue_type: "feature",
          status: "in_progress",
          assignee: "runner-7",
        }),
        bead("anton-prop", { issue_type: "feature", labels: ["pm:low-value:0123456789ab"] }),
        bead("anton-lone", { issue_type: "epic" }),
        // A ticket a run has picked up: the claim lives on it, the lease on the card it rides.
        bead("anton-t-held", {
          parent: wrongCard.id,
          status: "in_progress",
          assignee: "runner-3",
        }),
      ];
      const { detections, rejected } = detectionsFor([bad()], full, NOW);
      expect(detections).toEqual([]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatch(reason);
    });
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
