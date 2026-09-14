/**
 * Every bar a home claim clears, asked directly (anton-mspj) — one call to `rehomeRefusal` per bar,
 * with no claim pipeline in the way.
 *
 * The widest guard list in the pass, and the one whose ORDER carries the most: the subject's own
 * bars come before the home's, so a claim anton would refuse whatever home it named says so; the two
 * "which pass owns this ask" bars sit last so they never mask a stronger fault; and `homeMissing`
 * precedes every bar that reads the home at all. Each of those is asserted, not inferred.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { indexBoard } from "../gardener/board-index";
import { bead, NOW } from "./board.fixture";
import { rehomeRefusal, REHOME_GUARDS } from "./home-guards";
import type { PmClaimRehome } from "./report";

/** The epic that already groups a card, so it is a container and may carry another. */
const container = bead("anton-epic", { issue_type: "epic" });
/** Two cards: the wrong home a ticket rides today, and the right one. */
const wrongCard = bead("anton-card1", { issue_type: "feature" });
const rightCard = bead("anton-card2", { issue_type: "feature" });

const BOARD = [
  container,
  bead("anton-f1", { issue_type: "feature", parent: container.id }),
  wrongCard,
  rightCard,
  bead("anton-t", { parent: wrongCard.id }),
  /** A card whose own home is the wrong epic — the other half of the same claim. */
  bead("anton-stray", { issue_type: "feature", parent: "anton-other-epic" }),
  bead("anton-other-epic", { issue_type: "epic" }),
  bead("anton-shut", { issue_type: "feature", status: "closed" }),
  bead("anton-live", { issue_type: "feature", labels: [LABELS.runLease(NOW + 600_000, "abc")] }),
  bead("anton-held", { issue_type: "feature", status: "in_progress", assignee: "runner-7" }),
  bead("anton-prop", { issue_type: "feature", labels: ["pm:low-value:0123456789ab"] }),
  bead("anton-lone", { issue_type: "epic" }),
  // A ticket a run has picked up: the claim lives on it, the lease on the card it rides.
  bead("anton-t-held", { parent: wrongCard.id, status: "in_progress", assignee: "runner-3" }),
  // A subtask filed under a ticket: `feature → task → subtask`, shipped by the card at the top.
  bead("anton-t-nested", { parent: "anton-t" }),
  // Two tickets a run has SELECTED but not reached: every signal lives on the card above them.
  bead("anton-t-riding", { parent: "anton-live" }),
  bead("anton-t-selected", { parent: "anton-held" }),
  bead("anton-learn", { issue_type: "learning" }),
  // A parentless bug: its own run target, and homeless — anton runs it exactly as it stands.
  bead("anton-standalone", { issue_type: "bug", priority: 0 }),
  // A ticket hanging straight off the container epic: it has a home, but no card ancestor, so no
  // run reaches it — the state `detectContainerOrphans` owns.
  bead("anton-t-orphan", { parent: container.id }),
];

const index = indexBoard(BOARD);

const rehome = (id: string, home: string): PmClaimRehome => ({
  kind: "rehome",
  bead: id,
  home,
  summary: "it belongs over there",
  evidence: ["its goal is the other card's goal"],
});

/** The refusal for one claim, judged against the subject the board actually holds. */
const refusalFor = (claim: PmClaimRehome): string | undefined =>
  rehomeRefusal(claim, index.byId.get(claim.bead) as Bead, index, NOW);

/** One bar, the claim that trips it, and the exact string anton hands back. */
interface HomeCase {
  guard: string;
  label: string;
  bad: PmClaimRehome;
  reason: string;
}

const CASES: HomeCase[] = [
  {
    guard: "homeIsSubject",
    label: "the bead itself as its own home",
    bad: rehome("anton-t", "anton-t"),
    reason: "anton-t cannot be its own home",
  },
  {
    guard: "homeIsCurrentParent",
    label: "the home the bead already hangs under",
    bad: rehome("anton-t", wrongCard.id),
    reason: "anton-t already hangs under anton-card1 — the move would write nothing",
  },
  {
    guard: "homeAlreadyShipsSubject",
    label: "the card that already ships a nested ticket",
    bad: rehome("anton-t-nested", wrongCard.id),
    reason:
      "anton-t-nested already ships under anton-card1 — it hangs inside that run's ticket set today, so the move would flatten nesting somebody meant rather than change what ships it",
  },
  {
    guard: "subjectHeldByRun",
    label: "a subject a run has claimed but not yet leased",
    bad: rehome("anton-t-held", rightCard.id),
    reason:
      "anton-t-held is held by runner-3 — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places",
  },
  {
    guard: "subjectRidesOwnedCard",
    label: "a subject whose card a run is shipping",
    bad: rehome("anton-t-riding", rightCard.id),
    reason:
      "anton-t-riding rides anton-live's ticket set and a run owns anton-live — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships",
  },
  {
    guard: "subjectRidesOwnedCard",
    label: "a subject whose card a run has claimed but not yet leased",
    bad: rehome("anton-t-selected", rightCard.id),
    reason:
      "anton-t-selected rides anton-held's ticket set and a run owns anton-held — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships",
  },
  {
    guard: "homeMissing",
    label: "a home that is not on the board",
    bad: rehome("anton-t", "anton-ghost"),
    reason: "anton-ghost is not on the board",
  },
  {
    guard: "homeIsProposal",
    label: "a home that is itself a proposal",
    bad: rehome("anton-t", "anton-prop"),
    reason: "anton-prop is a proposal, not a home",
  },
  {
    guard: "homeSettled",
    label: "a home that has settled",
    bad: rehome("anton-t", "anton-shut"),
    reason:
      "anton-shut is already settled — hanging work under it would leave it riding a home nothing will run",
  },
  {
    guard: "homeInFlight",
    label: "a home a run is shipping",
    bad: rehome("anton-t", "anton-live"),
    reason: "anton-live is mid-run — hanging work under it would race the run that owns it",
  },
  {
    guard: "homeClaimed",
    label: "a home a run has claimed but not yet leased",
    bad: rehome("anton-t", "anton-held"),
    reason:
      "anton-held is held by runner-7 — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun",
  },
  {
    guard: "homeUnderSubject",
    label: "a home that sits under the bead being moved",
    bad: rehome(wrongCard.id, "anton-t"),
    reason: "anton-t sits under anton-card1 — the move would make the subtree its own ancestor",
  },
  {
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
    guard: "homeWrongTierForSubject",
    label: "a ticket under something that is not a board card",
    bad: rehome("anton-t", container.id),
    reason:
      "anton-epic is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about",
  },
  {
    guard: "homeWrongTierForSubject",
    label: "a card under a card",
    bad: rehome("anton-stray", rightCard.id),
    reason:
      "anton-card2 is not an epic and anton-stray is a board card — a card hangs off an epic and nothing else (`feature-under-non-epic`); both are run targets, so the move would ship the same work twice",
  },
  {
    guard: "homeWrongTierForSubject",
    label: "a card under an epic that groups no cards",
    bad: rehome("anton-stray", "anton-lone"),
    reason:
      "anton-lone is not a container epic — it groups no cards, so it is a run target in its own right, and landing anton-stray under it would demote it: its own run is cancelled and any ticket it carries is left beneath a card nothing will reach (`ticket-under-container-epic`)",
  },
  {
    guard: "subjectHasNoHome",
    label: "a bead that hangs under nothing — a first home is the gardener's ask",
    bad: rehome("anton-standalone", rightCard.id),
    reason:
      "anton-standalone hangs under nothing — giving homeless work its first home is the gardener's proposal, not this pass's",
  },
  {
    guard: "noRunTargetCarriesSubject",
    label: "a bead whose home runs nothing — the gardener's container-orphan ask",
    bad: rehome("anton-t-orphan", rightCard.id),
    reason:
      "no run target carries anton-t-orphan — it hangs under anton-epic, which runs nothing, so putting it where a run can reach it is the gardener's proposal, not this pass's",
  },
];

describe("rehomeRefusal", () => {
  it("hands on a ticket moving to another card", () => {
    expect(refusalFor(rehome("anton-t", rightCard.id))).toBeUndefined();
  });

  it("hands on a card moving to the epic that groups it", () => {
    expect(refusalFor(rehome("anton-stray", container.id))).toBeUndefined();
  });

  it.each(CASES)("refuses $label, and says why", ({ bad, reason }) => {
    expect(refusalFor(bad)).toBe(reason);
  });

  it("asserts the exact refusal of every home guard", () => {
    expect(new Set(CASES.map((c) => c.guard))).toEqual(new Set(REHOME_GUARDS.map((g) => g.name)));
  });

  // The subject's own bars come first, so a claim anton would refuse whatever home it named says
  // so rather than reporting whatever is wrong with the home it happened to pick.
  it("reports the subject's own fault before anything about the home", () => {
    expect(refusalFor(rehome("anton-t-held", "anton-ghost"))).toBe(
      "anton-t-held is held by runner-3 — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places",
    );
  });

  // Every guard after `homeMissing` HOLDS the bead it proved is there rather than looking it up.
  it("reports a missing home rather than reading a bead that is not there", () => {
    expect(() => refusalFor(rehome("anton-t", "anton-ghost"))).not.toThrow();
    expect(refusalFor(rehome("anton-t", "anton-ghost"))).toBe("anton-ghost is not on the board");
  });

  // The two "which pass owns this ask" bars sit LAST: a homeless subject moved under an illegal home
  // is refused for the illegal home, which is the fault that survives whoever owns the ask.
  it("reports a stronger fault before the bar that says another pass owns the ask", () => {
    expect(refusalFor(rehome("anton-standalone", container.id))).toBe(
      "anton-epic is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about",
    );
  });

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
