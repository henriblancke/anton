/**
 * Function-level parity for /shape's Phase 5 audit script against the production code it claims to
 * mirror (PR #274 review): the doc's `card`/`runTickets`/`orderTickets` logic is a hand-copied
 * mirror of `ticket-view.boardCards`/`runTickets` and `execute-epic-board.orderTickets`, and nothing
 * pinned the two together — a change to tie-breaking, card rules, or pipeline exclusion in the real
 * functions could drift from the doc's copy while `shape-dispatch-order.integration.test.ts` (which
 * only exercises the doc script's own output against a hand-picked expectation) stayed green.
 *
 * This extracts the doc's pure graph functions straight out of the markdown (no bd process, no
 * network) and runs them against the SAME synthetic board the production functions see, the same way
 * `tiers-parity.test.ts` pins `tiers.mjs` against its TypeScript twins.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { beads, type Bead } from "@/lib/beads/bd";
import { orderTickets } from "@/lib/jobs/execute-epic-board";
import { boardCards, runTickets } from "@/lib/ticket-view";
import { skillPath } from "./prompt";

/** The doc's pure graph functions, unchanged from the markdown — no bd-shelling, no printing. */
function extractDocPureFns(): string {
  const skill = readFileSync(skillPath("shape"), "utf8");
  const startMarker = "const parentOf = (b) => b.parent ?? b.parent_id;";
  const endMarker = 'const isAbandoned = (b) => (b.labels ?? []).includes("abandoned");';
  const start = skill.indexOf(startMarker);
  const end = skill.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error("/shape Phase 5's pure graph functions moved — update the extraction markers");
  }
  return skill.slice(start, end + endMarker.length);
}

interface DocFns {
  cardOf: (b: Bead) => string | undefined;
  runTickets: (featureId: string) => Bead[];
  orderTickets: (tickets: Bead[]) => Bead[];
  isAbandoned: (b: Bead) => boolean;
}

/** Evaluates the extracted snippet with `all` bound, exactly as it runs inside the doc's `node` block. */
function buildDocFns(all: Bead[]): DocFns {
  const factory = new Function(
    "all",
    `${extractDocPureFns()}\nreturn { cardOf, runTickets, orderTickets, isAbandoned };`,
  );
  return factory(all) as DocFns;
}

const bead = (id: string, issue_type: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type,
  ...over,
});
const blocks = (blockedId: string, blockerId: string) => ({
  issue_id: blockedId,
  depends_on_id: blockerId,
  type: "blocks",
});

describe("/shape Phase 5 dispatch-order audit agrees with the production functions it mirrors", () => {
  // f1 dispatches a, then (tied) c and the pipeline-gated leaf, then b once a clears — and the doc
  // script must land in the SAME place `ticket-view`/`execute-epic-board` land, not just a plausible one.
  const all: Bead[] = [
    bead("e1", "epic"),
    bead("f1", "feature", { parent: "e1" }),
    bead("a", "task", { parent: "f1" }),
    bead("b", "task", { parent: "f1", dependencies: [blocks("b", "a")] }),
    bead("c", "task", { parent: "f1" }),
    bead("d1", "task", { parent: "f1", labels: ["abandoned"] }),
    // A gate reparented under its own ticket: the card walk must stop at it, not resolve through it.
    bead("g1", "gate", { parent: "a" }),
    bead("u1", "task", { parent: "g1" }),
  ];

  it("resolves cardOf identically for every ticket-tier bead, pipeline stop included", () => {
    // Restricted to non-pipeline beads: the doc's `cardOf` short-circuits to `undefined` for a
    // gate/molecule passed directly (mirroring `runTickets`'s own `!pipeline.has(...)` guard, which
    // never calls `cardOf` on one), while production's `cardOf` keeps walking from a pipeline bead's
    // OWN position — a real difference, but one neither script's `runTickets` ever observes.
    const docFns = buildDocFns(all);
    const cards = boardCards(all);
    for (const b of all.filter((b) => b.issue_type !== "gate" && b.issue_type !== "molecule")) {
      expect(docFns.cardOf(b)).toBe(cards.cardOf(b));
    }
  });

  it("prints the same dispatch order runTickets/orderTickets compute, abandoned members dropped after ordering", () => {
    const docFns = buildDocFns(all);
    const docOrder = docFns
      .orderTickets(docFns.runTickets("f1"))
      .filter((t) => !docFns.isAbandoned(t))
      .map((t) => t.id);

    const productionOrder = orderTickets(runTickets(all, "f1"), all)
      .filter((t) => !beads.isAbandoned(t))
      .map((t) => t.id);

    expect(docOrder).toEqual(productionOrder);
    expect(docOrder).toEqual(["a", "c", "b"]);
  });
});
