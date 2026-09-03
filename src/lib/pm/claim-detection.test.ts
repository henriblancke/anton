/**
 * What an ACCEPTED claim becomes (anton-mspj): one case per proposal class, because the mapping is
 * per-kind and a class asserted only through whichever scenario happens to reach it is a class
 * nothing pins.
 *
 * Two things are behaviour here rather than plumbing. The MOVE each kind maps to — `makeDetection`
 * refuses a kind/move pair the gardener's table does not hold, so a drifted mapping is a proposal
 * apply could never read. And the IDENTITY: the fingerprint is what makes one judgment one ask, so
 * what joins it (a priority, a home) and what does not (the wording) is asserted directly.
 */
import { describe, expect, it } from "vitest";
import { detectionFor } from "./claim-detection";
import type { PmClaim } from "./report";

const EVIDENCE = ["three reviews at 3, 2, 2"];

/** A claim of any kind: the `kill` shape, which needs no per-kind field, with the case's own over it. */
const claim = (o: Partial<PmClaim> = {}): PmClaim =>
  ({
    kind: "kill",
    bead: "anton-a",
    summary: "nothing wants this any more",
    evidence: EVIDENCE,
    ...o,
  }) as PmClaim;

describe("detectionFor", () => {
  it("turns a reprioritize into the move that writes the priority, which joins its identity", () => {
    const d = detectionFor(claim({ kind: "reprioritize", priority: "P1" }));
    expect([d.kind, d.move, d.subjects, d.detail]).toEqual([
      "mispriority",
      "reprioritize",
      ["anton-a"],
      "P1",
    ]);
    // Two priorities for one bead are two asks — collapsing them would let the first approved one
    // suppress the second forever.
    expect(d.subjectKey).toBe("mispriority:anton-a#P1");
    expect(d.target).toBeUndefined();
  });

  it("turns an order claim into a link pointing at the bead that has to land first", () => {
    const d = detectionFor(claim({ kind: "order", blockedBy: "anton-b" }));
    expect([d.kind, d.move, d.subjects, d.target]).toEqual([
      "missing-order",
      "link",
      ["anton-a"],
      "anton-b",
    ]);
    expect(d.subjectKey).toBe("missing-order:anton-a>anton-b");
  });

  // Always a target, never the gardener's targetless "which feature?" ask: a session that makes a
  // home claim has already named the home, and one without it never parses.
  it("turns a rehome into a reparent that names the home", () => {
    const d = detectionFor(claim({ kind: "rehome", home: "anton-card2" }));
    expect([d.kind, d.move, d.subjects, d.target]).toEqual([
      "misfiled",
      "reparent",
      ["anton-a"],
      "anton-card2",
    ]);
    expect(d.subjectKey).toBe("misfiled:anton-a>anton-card2");
  });

  // The sketch rides with the evidence because it IS part of the claim: a split proposal without a
  // decomposition asks a founder to do the thinking the pass was run to do.
  it("turns a split into a split carrying the decomposition as evidence", () => {
    const d = detectionFor(claim({ kind: "split", pieces: ["the API half", "the UI half"] }));
    expect([d.kind, d.move, d.subjects]).toEqual(["oversized", "split", ["anton-a"]]);
    expect(d.evidence).toEqual([
      ...EVIDENCE,
      "proposed ticket 1: the API half",
      "proposed ticket 2: the UI half",
    ]);
    // The sketch is evidence, not identity: a reworded decomposition is the same ask.
    expect(d.subjectKey).toBe("oversized:anton-a");
  });

  // A kill applies as `defer` — out of the ready set, contract intact, reversible with `bd undefer`
  // — and never as a close.
  it("turns a kill into a retirement that defers rather than closes", () => {
    const d = detectionFor(claim({ kind: "kill" }));
    expect([d.kind, d.move, d.retireAs, d.subjects]).toEqual([
      "low-value",
      "retire",
      "defer",
      ["anton-a"],
    ]);
    expect(d.subjectKey).toBe("low-value:anton-a");
  });

  it("turns a start into the approve that grants the gate", () => {
    const d = detectionFor(claim({ kind: "start" }));
    expect([d.kind, d.move, d.subjects]).toEqual(["withheld-approval", "approve", ["anton-a"]]);
    // The ask IS the bead, so nothing else joins its identity — one start question per target.
    expect(d.subjectKey).toBe("withheld-approval:anton-a");
    expect(d.retireAs).toBeUndefined();
  });

  it("files every kind under the pm namespace, so the two producers never collide on a hash", () => {
    const kinds: PmClaim[] = [
      claim({ kind: "reprioritize", priority: "P1" }),
      claim({ kind: "order", blockedBy: "anton-b" }),
      claim({ kind: "rehome", home: "anton-card2" }),
      claim({ kind: "split", pieces: ["a", "b"] }),
      claim({ kind: "kill" }),
      claim({ kind: "start" }),
    ];
    for (const c of kinds) {
      const d = detectionFor(c);
      expect(d.fingerprint).toMatch(new RegExp(`^pm:${d.kind}:[0-9a-f]{12}$`));
      expect(d.summary).toBe(c.summary);
    }
  });

  it("reaches the same fingerprint for the same judgment worded differently", () => {
    expect(detectionFor(claim({ summary: "worded differently" })).fingerprint).toBe(
      detectionFor(claim()).fingerprint,
    );
  });

  it("keeps two judgments about one bead apart when what they ask for differs", () => {
    const p1 = detectionFor(claim({ kind: "reprioritize", priority: "P1" }));
    const p2 = detectionFor(claim({ kind: "reprioritize", priority: "P2" }));
    expect(p1.fingerprint).not.toBe(p2.fingerprint);
  });
});
