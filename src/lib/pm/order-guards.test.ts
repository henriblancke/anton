/**
 * Every bar an ordering claim clears, asked directly (anton-mspj) — one call to `orderRefusal` per
 * bar, with no claim pipeline in the way.
 *
 * Three properties carry the module, and each is asserted here rather than inferred from a scenario
 * that happens to walk it: a claim that clears every bar is HANDED ON; each refusal reads back
 * verbatim, because the wording is what a founder sees when anton declines the ask; and the bars run
 * in a fixed order, so a weaker one can never mask the fault a stronger one exists to report.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { indexBoard } from "../gardener/board-index";
import { bead, NOW } from "./board.fixture";
import { orderRefusal, ORDER_GUARDS } from "./order-guards";
import type { PmClaimOrder } from "./report";

const BOARD = [
  bead("anton-a", { priority: 3 }),
  bead("anton-b"),
  bead("anton-done", { status: "closed" }),
  bead("anton-prop", { labels: ["pm:low-value:0123456789ab"] }),
  bead("anton-linked", {
    dependencies: [{ issue_id: "anton-linked", depends_on_id: "anton-b", type: "blocks" }],
  }),
  bead("anton-found", {
    dependencies: [{ issue_id: "anton-found", depends_on_id: "anton-b", type: "discovered-from" }],
  }),
  // anton-waits ← anton-mid ← anton-a: no direct pair, but the edge would close the loop.
  bead("anton-waits", {
    dependencies: [{ issue_id: "anton-waits", depends_on_id: "anton-mid", type: "blocks" }],
  }),
  bead("anton-mid", {
    dependencies: [{ issue_id: "anton-mid", depends_on_id: "anton-a", type: "blocks" }],
  }),
  // The edge the graph already records, drawn the OTHER way round.
  bead("anton-rev", {
    dependencies: [{ issue_id: "anton-rev", depends_on_id: "anton-a", type: "blocks" }],
  }),
  // An edge behind work that has since landed: two bars describe it, and only one is the fault.
  bead("anton-oldedge", {
    dependencies: [{ issue_id: "anton-oldedge", depends_on_id: "anton-done", type: "blocks" }],
  }),
];

const index = indexBoard(BOARD);

const order = (bead: string, blockedBy: string): PmClaimOrder => ({
  kind: "order",
  bead,
  blockedBy,
  summary: "the second one cannot start until the first lands",
  evidence: ["the API contract lands in the first"],
});

/** The refusal for one claim, judged against the subject the board actually holds. */
const refusalFor = (claim: PmClaimOrder): string | undefined =>
  orderRefusal(claim, index.byId.get(claim.bead) as Bead, index, NOW);

/** One bar, the claim that trips it, and the exact string anton hands back. */
interface OrderCase {
  guard: string;
  label: string;
  bad: PmClaimOrder;
  reason: string;
}

const CASES: OrderCase[] = [
  {
    guard: "blocksItself",
    label: "a bead blocking itself",
    bad: order("anton-a", "anton-a"),
    reason: "anton-a cannot block itself",
  },
  {
    guard: "blockerMissing",
    label: "a blocker that is not on the board",
    bad: order("anton-a", "anton-ghost"),
    reason: "anton-ghost is not on the board",
  },
  {
    guard: "blockerIsProposal",
    label: "a blocker that is itself a proposal",
    bad: order("anton-a", "anton-prop"),
    reason:
      "anton-prop is a proposal, not work — the edge would outlive it and leave anton-a blocked forever",
  },
  {
    guard: "blockerSettled",
    label: "a blocker that has already landed",
    bad: order("anton-a", "anton-done"),
    reason: "anton-done has already landed, so the edge would constrain nothing",
  },
  {
    guard: "edgeAlreadyRecorded",
    label: "an ordering the graph already records",
    bad: order("anton-linked", "anton-b"),
    reason: "the board already records an ordering between anton-linked and anton-b",
  },
  {
    guard: "pairCarriesDiscovery",
    label: "a pair that already carries a discovered-from edge",
    bad: order("anton-found", "anton-b"),
    reason:
      "anton-found and anton-b already carry a discovered-from edge, and bd keeps one edge per pair",
  },
  {
    guard: "edgeWouldCloseCycle",
    label: "an ordering that would close a cycle",
    bad: order("anton-a", "anton-waits"),
    reason:
      "anton-waits is already blocked by anton-a through other beads — the edge would close a cycle",
  },
];

describe("orderRefusal", () => {
  it("hands on an ordering the board can actually record", () => {
    expect(refusalFor(order("anton-a", "anton-b"))).toBeUndefined();
  });

  it.each(CASES)("refuses $label, and says why", ({ bad, reason }) => {
    expect(refusalFor(bad)).toBe(reason);
  });

  it("asserts the exact refusal of every ordering guard", () => {
    expect(new Set(CASES.map((c) => c.guard))).toEqual(new Set(ORDER_GUARDS.map((g) => g.name)));
  });

  // The order is the behaviour. Every guard after `blockerMissing` HOLDS the bead it proved is
  // there, so a missing blocker must be reported as missing rather than read by the bars below it.
  it("reports a missing blocker rather than reading a bead that is not there", () => {
    expect(() => refusalFor(order("anton-a", "anton-ghost"))).not.toThrow();
    expect(refusalFor(order("anton-a", "anton-ghost"))).toBe("anton-ghost is not on the board");
  });

  // Two bars describe this board: the blocker has landed, and an edge is already recorded. The
  // landed blocker is the fault worth reporting — the recorded edge is what it left behind.
  it("reports a settled blocker rather than the edge that already records it", () => {
    expect(refusalFor(order("anton-oldedge", "anton-done"))).toBe(
      "anton-done has already landed, so the edge would constrain nothing",
    );
  });

  // The edge check is undirected, and it runs first for this reason: the reverse of an edge somebody
  // already drew is a contradiction to hand back, not a cycle to explain.
  it("reports an edge the graph already records rather than the cycle it would close", () => {
    expect(refusalFor(order("anton-a", "anton-rev"))).toBe(
      "the board already records an ordering between anton-a and anton-rev",
    );
  });

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
});
