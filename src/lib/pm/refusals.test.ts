/**
 * The half that actually protects the board (anton-d2sx): what anton refuses to file on the
 * session's behalf.
 *
 * Three properties carry this module:
 *   • every claim is checked against the board before it becomes a bead, because a language model
 *     naming a bead id is a guess until something looks;
 *   • every guard's refusal is asserted VERBATIM — the wording is what a founder reads when anton
 *     declines a claim, so it is behaviour, not prose;
 *   • the guards run in a fixed order, and that order is pinned here: several of them describe the
 *     same board state from different angles, and a weaker bar moved ahead of a stronger one would
 *     silently start reporting the wrong fault.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import { REHOME_GUARDS } from "./home-guards";
import { ORDER_GUARDS } from "./order-guards";
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

/**
 * One refusal case: the guard it must reach, what the board looks like in prose, the claim, and the
 * exact string anton hands back. `guard` is what the coverage assertions count, so a guard added
 * without a case here fails the suite rather than shipping unasserted.
 */
interface RefusalCase {
  guard: string;
  label: string;
  bad: PmClaim;
  reason: string;
}

/** Every guard the cases below cover, minus the shared subject bars, which are not guards. */
const guardsCovered = (cases: RefusalCase[]): Set<string> =>
  new Set(cases.map((c) => c.guard).filter((name) => name !== "subjectChecked"));

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

  const KIND_CASES: RefusalCase[] = [
    {
      guard: "subjectChecked",
      label: "a bead that is not on the board",
      bad: claim({ bead: "anton-ghost" }),
      reason: "anton-ghost is not on the board",
    },
    {
      guard: "subjectChecked",
      label: "a bead that already settled",
      bad: claim({ bead: "anton-done" }),
      reason: "anton-done is already settled",
    },
    {
      guard: "subjectChecked",
      label: "a bead a run owns",
      bad: claim({ bead: "anton-live" }),
      reason: "anton-live is mid-run — a proposal would race the run",
    },
    {
      guard: "subjectChecked",
      label: "a proposal bead",
      bad: claim({ bead: "anton-prop" }),
      reason: "anton-prop is itself a proposal, not work",
    },
    {
      guard: "priorityUnchanged",
      label: "a priority the bead already carries",
      bad: claim({ kind: "reprioritize", priority: "P3" }),
      reason: "anton-a is already at P3",
    },
    {
      guard: "blocksItself",
      label: "a bead blocking itself",
      bad: claim({ kind: "order", blockedBy: "anton-a" }),
      reason: "anton-a cannot block itself",
    },
    {
      guard: "blockerMissing",
      label: "an ordering behind a bead that is not on the board",
      bad: claim({ kind: "order", blockedBy: "anton-ghost" }),
      reason: "anton-ghost is not on the board",
    },
    {
      // A proposal is open work, so nothing above catches it — but it closes the moment the founder
      // answers it, and the edge outlives it. The subject would wait forever on a settled ask.
      guard: "blockerIsProposal",
      label: "an ordering against a proposal bead",
      bad: claim({ kind: "order", blockedBy: "anton-prop" }),
      reason:
        "anton-prop is a proposal, not work — the edge would outlive it and leave anton-a blocked forever",
    },
    {
      guard: "blockerSettled",
      label: "an ordering behind work that has already landed",
      bad: claim({ kind: "order", blockedBy: "anton-done" }),
      reason: "anton-done has already landed, so the edge would constrain nothing",
    },
    {
      guard: "edgeAlreadyRecorded",
      label: "an ordering the graph already records",
      bad: claim({ kind: "order", bead: "anton-linked", blockedBy: "anton-b" }),
      reason: "the board already records an ordering between anton-linked and anton-b",
    },
    {
      // bd keeps ONE edge per directed pair, so a pair already carrying provenance can never also
      // carry ordering: approving the ask would reach a 500 rather than the edge it promised.
      guard: "pairCarriesDiscovery",
      label: "an ordering over a pair that already carries a discovered-from edge",
      bad: claim({ kind: "order", bead: "anton-found", blockedBy: "anton-b" }),
      reason:
        "anton-found and anton-b already carry a discovered-from edge, and bd keeps one edge per pair",
    },
    {
      guard: "edgeWouldCloseCycle",
      label: "an ordering that would close a cycle",
      bad: claim({ kind: "order", bead: "anton-a", blockedBy: "anton-waits" }),
      reason:
        "anton-waits is already blocked by anton-a through other beads — the edge would close a cycle",
    },
    {
      // A deferred bead is still OPEN work, so nothing above this catches it — and a kill applies as
      // `defer`, which apply settles as a no-op. The ask would cost a founder a decision and write
      // nothing at all.
      guard: "alreadyDeferred",
      label: "a kill on a bead a previous kill already deferred",
      bad: claim({ kind: "kill", bead: "anton-parked" }),
      reason: "anton-parked is already deferred — killing it again would change nothing",
    },
  ];

  it.each(KIND_CASES)("refuses $label, and says why rather than dropping it", ({ bad, reason }) => {
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
      bead("anton-found", {
        dependencies: [
          { issue_id: "anton-found", depends_on_id: "anton-b", type: "discovered-from" },
        ],
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
    expect(rejected[0].reason).toBe(reason);
  });

  it("asserts the exact refusal of every ordering guard", () => {
    expect(guardsCovered(KIND_CASES)).toEqual(
      new Set([...ORDER_GUARDS.map((g) => g.name), "priorityUnchanged", "alreadyDeferred"]),
    );
  });

  // The order an ordering claim is judged in. `blockerMissing` comes before every guard that reads
  // the blocker — those hold the bead it proved exists — and the graph walks come last, so a plain
  // contradiction is never reported as a cycle.
  it("runs the ordering guards in the order the refusals depend on", () => {
    expect(ORDER_GUARDS.map((g) => g.name)).toEqual([
      "blocksItself",
      "blockerMissing",
      "blockerIsProposal",
      "blockerSettled",
      "edgeAlreadyRecorded",
      "pairCarriesDiscovery",
      "edgeWouldCloseCycle",
    ]);
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

    const HOME_CASES: RefusalCase[] = [
      {
        guard: "homeIsSubject",
        label: "the bead itself",
        bad: rehome(ticket.id, ticket.id),
        reason: "anton-t cannot be its own home",
      },
      {
        guard: "homeIsCurrentParent",
        label: "the home the bead already hangs under",
        bad: rehome(ticket.id, wrongCard.id),
        reason: "anton-t already hangs under anton-card1 — the move would write nothing",
      },
      {
        // The same no-op one tier out. A nested ticket already ships in the run of the card above its
        // parent, and its line names that card as `shipped by` — the very evidence such a claim cites.
        // The move changes no run; it only flattens nesting somebody meant.
        guard: "homeAlreadyShipsSubject",
        label: "the card that already ships a nested ticket",
        bad: rehome("anton-t-nested", wrongCard.id),
        reason:
          "anton-t-nested already ships under anton-card1 — it hangs inside that run's ticket set today, so the move would flatten nesting somebody meant rather than change what ships it",
      },
      {
        // The SUBJECT end of "a run owns it". A run working a ticket writes the assignee and
        // `in_progress` onto it while the run-lease lives on the card above, so `subjectChecked`'s
        // liveness check waves it through — and a move out of that run's ticket set lands the commit
        // in the old card's PR while the bead hangs off the new one.
        guard: "subjectHeldByRun",
        label: "a bead a run has claimed but not yet leased",
        bad: rehome("anton-t-held", rightCard.id),
        reason:
          "anton-t-held is held by runner-3 — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places",
      },
      {
        // The rest of that bar, and the half no per-bead signal reaches: a grouped run publishes ONE
        // lease, on the card, and cascades an assignee only to the tickets it has already reached — so
        // a ticket it has SELECTED carries neither, and both checks above read it as free work.
        guard: "subjectRidesOwnedCard",
        label: "a bead whose card a run is shipping",
        bad: rehome("anton-t-riding", rightCard.id),
        reason:
          "anton-t-riding rides anton-live's ticket set and a run owns anton-live — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships",
      },
      {
        guard: "subjectRidesOwnedCard",
        label: "a bead whose card a run has claimed but not yet leased",
        bad: rehome("anton-t-selected", rightCard.id),
        reason:
          "anton-t-selected rides anton-held's ticket set and a run owns anton-held — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships",
      },
      {
        guard: "homeMissing",
        label: "a home that is not on the board",
        bad: rehome(ticket.id, "anton-ghost"),
        reason: "anton-ghost is not on the board",
      },
      {
        guard: "homeIsProposal",
        label: "a home that is itself a proposal",
        bad: rehome(ticket.id, "anton-prop"),
        reason: "anton-prop is a proposal, not a home",
      },
      {
        guard: "homeSettled",
        label: "a home that has settled",
        bad: rehome(ticket.id, "anton-shut"),
        reason:
          "anton-shut is already settled — hanging work under it would leave it riding a home nothing will run",
      },
      {
        guard: "homeInFlight",
        label: "a home a run is shipping",
        bad: rehome(ticket.id, "anton-live"),
        reason: "anton-live is mid-run — hanging work under it would race the run that owns it",
      },
      {
        guard: "homeClaimed",
        label: "a home a run has claimed but not yet leased",
        bad: rehome(ticket.id, "anton-held"),
        reason:
          "anton-held is held by runner-7 — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun",
      },
      {
        guard: "homeUnderSubject",
        label: "a home that sits under the bead being moved",
        bad: rehome(wrongCard.id, ticket.id),
        reason: "anton-t sits under anton-card1 — the move would make the subtree its own ancestor",
      },
      {
        // The SUBJECT end of the tier taxonomy. A report is untrusted input, and every bar around this
        // one reads "not a board card" — which a container epic satisfies as surely as a ticket does.
        guard: "homeWrongTierForSubject",
        label: "a container epic, which groups the board's cards rather than riding one",
        bad: rehome(container.id, rightCard.id),
        reason:
          "anton-epic is not a bead a card can carry — it is a container epic, which GROUPS the board's cards rather than riding one, so hanging it under a card would hand that card's run every ticket beneath it (`boardCards.cardOf` walks straight through)",
      },
      {
        guard: "homeWrongTierForSubject",
        label: "a bead type the taxonomy names no home for",
        bad: rehome("anton-learn", rightCard.id),
        reason:
          "anton-learn is a learning, which is neither a board card nor working-layer work — the tier taxonomy (`epic → feature → task|bug|chore`) names no home for it, so nothing here can say where it belongs",
      },
      {
        // The tier taxonomy, asked through apply's own homeWrongTier so the filing check and the
        // approve check cannot disagree about which homes are legal.
        guard: "homeWrongTierForSubject",
        label: "a ticket under something that is not a board card",
        bad: rehome(ticket.id, container.id),
        reason:
          "anton-epic is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about",
      },
      {
        guard: "homeWrongTierForSubject",
        label: "a card under a card",
        bad: rehome(strayCard.id, rightCard.id),
        reason:
          "anton-card2 is not an epic and anton-stray is a board card — a card hangs off an epic and nothing else (`feature-under-non-epic`); both are run targets, so the move would ship the same work twice",
      },
      {
        guard: "homeWrongTierForSubject",
        label: "a card under an epic that groups no cards — the move would demote it out of its own run",
        bad: rehome(strayCard.id, "anton-lone"),
        reason:
          "anton-lone is not a container epic — it groups no cards, so it is a run target in its own right, and landing anton-stray under it would demote it: its own run is cancelled and any ticket it carries is left beneath a card nothing will reach (`ticket-under-container-epic`)",
      },
      {
        // The SUBJECT end of "which pass owns this ask". A parentless task/bug is a RUN TARGET, so it
        // renders as one rather than in the loose section, and nothing else here stops a claim that
        // demotes a standalone run into somebody else's child ticket. First homes are the gardener's.
        guard: "subjectHasNoHome",
        label: "a bead that hangs under nothing — a first home is the gardener's ask, not this pass's",
        bad: rehome("anton-standalone", rightCard.id),
        reason:
          "anton-standalone hangs under nothing — giving homeless work its first home is the gardener's proposal, not this pass's",
      },
      {
        // The rest of that ask. A ticket under a container epic HAS a parent, so the bar above waves
        // it through — but no run target carries it, the context renders it as work nothing ships, and
        // the gardener's container-orphan detector already proposes this move under its own
        // fingerprint.
        guard: "noRunTargetCarriesSubject",
        label: "a bead whose home runs nothing — the gardener's container-orphan ask, not this pass's",
        bad: rehome("anton-t-orphan", rightCard.id),
        reason:
          "no run target carries anton-t-orphan — it hangs under anton-epic, which runs nothing, so putting it where a run can reach it is the gardener's proposal, not this pass's",
      },
    ];

    it.each(HOME_CASES)("refuses $label, and says why rather than dropping it", ({ bad, reason }) => {
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
      const { detections, rejected } = detectionsFor([bad], full, NOW);
      expect(detections).toEqual([]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe(reason);
    });

    it("asserts the exact refusal of every home guard", () => {
      expect(guardsCovered(HOME_CASES)).toEqual(new Set(REHOME_GUARDS.map((g) => g.name)));
    });

    // The order is the behaviour: the subject's own bars come first, so a claim anton would refuse
    // whatever home it named says so; `homeMissing` precedes every guard that reads the home; and the
    // two "which pass owns this ask" bars sit last so they never mask a stronger fault.
    it("runs the home guards in the order the refusals depend on", () => {
      expect(REHOME_GUARDS.map((g) => g.name)).toEqual([
        "homeIsSubject",
        "homeIsCurrentParent",
        "homeAlreadyShipsSubject",
        "subjectHeldByRun",
        "subjectRidesOwnedCard",
        "homeMissing",
        "homeIsProposal",
        "homeSettled",
        "homeInFlight",
        "homeClaimed",
        "homeUnderSubject",
        "homeWrongTierForSubject",
        "subjectHasNoHome",
        "noRunTargetCarriesSubject",
      ]);
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
