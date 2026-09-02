/**
 * The walk the guard lists run through (anton-mspj): what `firstRefusal` reports, and — the part
 * every guard list depends on — where it STOPS.
 *
 * The bars are ordered lists rather than a nested chain because the order is the behaviour, and this
 * walk is what makes that order mean anything: the guards after `blockerMissing`/`homeMissing` hold
 * the bead those proved exists instead of looking it up again, so a walk that ran a later bar after
 * an earlier one refused would read a bead that is not there.
 */
import { describe, expect, it } from "vitest";
import { indexBoard } from "../gardener/board-index";
import { bead, NOW } from "./board.fixture";
import { firstRefusal, type Guard } from "./guard";
import type { PmClaimKill } from "./report";

const claim: PmClaimKill = {
  kind: "kill",
  bead: "anton-a",
  summary: "nothing wants this any more",
  evidence: ["three reviews at 3, 2, 2"],
};
const subject = bead("anton-a");
const index = indexBoard([subject, bead("anton-b")]);

/** A bar that refuses with `refusal` (or clears), recording that it ran and what it was handed. */
const bar = (name: string, ran: string[], refusal?: string): Guard<PmClaimKill> => {
  const guard: Guard<PmClaimKill> = () => {
    ran.push(name);
    return refusal;
  };
  return guard;
};

describe("firstRefusal", () => {
  it("hands the claim on when every bar clears", () => {
    const ran: string[] = [];
    const refusal = firstRefusal(
      [bar("first", ran), bar("second", ran)],
      claim,
      subject,
      index,
      NOW,
    );
    expect(refusal).toBeUndefined();
    expect(ran).toEqual(["first", "second"]);
  });

  it("reports the first bar the claim fails, not the last", () => {
    const ran: string[] = [];
    const refusal = firstRefusal(
      [bar("clears", ran), bar("stronger", ran, "the stronger fault"), bar("weaker", ran, "a weaker one")],
      claim,
      subject,
      index,
      NOW,
    );
    expect(refusal).toBe("the stronger fault");
  });

  // What lets a guard hold the bead an earlier one proved exists (`blockerIn`, `homeIn`) rather than
  // re-asserting the lookup. A walk that kept going would hand those bars an undefined bead.
  it("stops at the first refusal, so no later bar runs on a claim already refused", () => {
    const ran: string[] = [];
    firstRefusal(
      [bar("clears", ran), bar("refuses", ran, "no"), bar("must not run", ran)],
      claim,
      subject,
      index,
      NOW,
    );
    expect(ran).toEqual(["clears", "refuses"]);
  });

  it("hands every bar the same claim, subject, board and clock", () => {
    const seen: unknown[][] = [];
    const record: Guard<PmClaimKill> = (...args) => {
      seen.push(args);
      return undefined;
    };
    firstRefusal([record, record], claim, subject, index, NOW);
    expect(seen).toEqual([
      [claim, subject, index, NOW],
      [claim, subject, index, NOW],
    ]);
  });

  it("clears a kind that holds no bars of its own", () => {
    expect(firstRefusal([], claim, subject, index, NOW)).toBeUndefined();
  });
});
