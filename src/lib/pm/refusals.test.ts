/**
 * The half that actually protects the board (anton-d2sx): what anton refuses to file on the
 * session's behalf.
 *
 * Two properties carry this module:
 *   • every claim is checked against the board before it becomes a bead, because a language model
 *     naming a bead id is a guess until something looks;
 *   • the fingerprints come from the claim's content, so the same judgment reached twice is one ask.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import { detectionsFor } from "./refusals";
import type { PmClaim } from "./report";

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", priority: 2, ...o };
}

const NOW = Date.parse("2026-08-04T12:00:00Z");

/**
 * A claim of any kind: the `kill` shape — the only one needing no per-kind field — with the case's
 * own overrides spread over it. The assertion is what a factory over a discriminated union costs;
 * each call site names the field its kind requires.
 */
const claim = (o: Partial<PmClaim> = {}): PmClaim =>
  ({
    kind: "kill",
    bead: "anton-a",
    summary: "nothing wants this any more",
    evidence: ["three reviews at 3, 2, 2"],
    ...o,
  }) as PmClaim;

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
      // The same no-op one tier out. A nested ticket already ships in the run of the card above its
      // parent, and its line names that card as `shipped by` — the very evidence such a claim cites.
      // The move changes no run; it only flattens nesting somebody meant.
      [
        "the card that already ships a nested ticket",
        () => rehome("anton-t-nested", wrongCard.id),
        /anton-t-nested already ships under anton-card1/,
      ],
      ["a home that is not on the board", () => rehome(ticket.id, "anton-ghost"), /not on the board/],
      // The SUBJECT end of "which pass owns this ask". A parentless task/bug is a RUN TARGET, so it
      // renders as one rather than in the loose section, and nothing else here stops a claim that
      // demotes a standalone run into somebody else's child ticket. First homes are the gardener's.
      [
        "a bead that hangs under nothing — a first home is the gardener's ask, not this pass's",
        () => rehome("anton-standalone", rightCard.id),
        /hangs under nothing — giving homeless work its first home is the gardener's proposal/,
      ],
      // The rest of that ask. A ticket under a container epic HAS a parent, so the bar above waves
      // it through — but no run target carries it, the context renders it as work nothing ships, and
      // the gardener's container-orphan detector already proposes this move under its own
      // fingerprint.
      [
        "a bead whose home runs nothing — the gardener's container-orphan ask, not this pass's",
        () => rehome("anton-t-orphan", rightCard.id),
        /no run target carries anton-t-orphan — it hangs under anton-epic, which runs nothing/,
      ],
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
      // The rest of that bar, and the half no per-bead signal reaches: a grouped run publishes ONE
      // lease, on the card, and cascades an assignee only to the tickets it has already reached — so
      // a ticket it has SELECTED carries neither, and both checks above read it as free work.
      [
        "a bead whose card a run is shipping",
        () => rehome("anton-t-riding", rightCard.id),
        /rides anton-live's ticket set and a run owns anton-live/,
      ],
      [
        "a bead whose card a run has claimed but not yet leased",
        () => rehome("anton-t-selected", rightCard.id),
        /rides anton-held's ticket set and a run owns anton-held/,
      ],
      // The SUBJECT end of the tier taxonomy. A report is untrusted input, and every bar around this
      // one reads "not a board card" — which a container epic satisfies as surely as a ticket does.
      [
        "a container epic, which groups the board's cards rather than riding one",
        () => rehome(container.id, rightCard.id),
        /anton-epic is not a bead a card can carry/,
      ],
      [
        "a bead type the taxonomy names no home for",
        () => rehome("anton-learn", rightCard.id),
        /anton-learn is a learning, which is neither a board card nor working-layer work/,
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
        // A subtask filed under a ticket: `feature → task → subtask`, shipped by the card at the top.
        bead("anton-t-nested", { parent: ticket.id }),
        // Two tickets a run has SELECTED but not reached: every signal lives on the card above them.
        bead("anton-t-riding", { parent: "anton-live" }),
        bead("anton-t-selected", { parent: "anton-held" }),
        bead("anton-learn", { issue_type: "learning" }),
        // A parentless bug: its own run target, and homeless — anton runs it exactly as it stands.
        bead("anton-standalone", { issue_type: "bug", priority: 0 }),
        // A ticket hanging straight off the container epic: it has a home, but no card ancestor, so
        // no run reaches it — the state `detectContainerOrphans` owns.
        bead("anton-t-orphan", { parent: container.id }),
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
