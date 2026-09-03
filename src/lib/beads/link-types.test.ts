import { describe, expect, it } from "vitest";
import {
  assertLinkType,
  auditLinkTypes,
  isLinkType,
  LINK_TYPES,
  unexplainedEdges,
} from "./link-types";

describe("assertLinkType (anton-igkb)", () => {
  it("accepts every type anton writes", () => {
    for (const t of LINK_TYPES) expect(() => assertLinkType(t)).not.toThrow();
  });

  it("rejects a typo — the case bd itself accepts and silently makes non-blocking", () => {
    expect(() => assertLinkType("blocsk")).toThrow(/refusing dependency type "blocsk"/);
    expect(() => assertLinkType("totally-bogus-type")).toThrow(/NON-BLOCKING/);
  });

  it("rejects the types bd stores but does nothing with — indistinguishable from a typo", () => {
    // Measured no-ops (.product/decisions/2026-07-28-bd-workflow-primitives.md §3).
    for (const t of ["waits-for", "tracks", "until", "caused-by", "validates", "relates-to"]) {
      expect(() => assertLinkType(t)).toThrow(/refusing dependency type/);
    }
  });

  it("rejects conditional-blocks: it blocks, but it is a second spelling of `blocks`", () => {
    expect(() => assertLinkType("conditional-blocks")).toThrow(/refusing dependency type/);
  });

  it("rejects the empty string (which bd itself also rejects) and the case/whitespace variants bd would take", () => {
    expect(() => assertLinkType("")).toThrow(/refusing dependency type/);
    expect(() => assertLinkType(" blocks")).toThrow(/refusing dependency type/);
    expect(() => assertLinkType("BLOCKS")).toThrow(/refusing dependency type/);
  });

  it("names the allowed set in the error, so the fix is in the message", () => {
    expect(() => assertLinkType("nope")).toThrow(/blocks, parent-child, related, discovered-from/);
  });

  it("isLinkType agrees with the assertion", () => {
    expect(isLinkType("blocks")).toBe(true);
    expect(isLinkType("waits-for")).toBe(false);
  });
});

describe("auditLinkTypes (anton-igkb)", () => {
  const edge = (type: string) => ({ from: "a-1", to: "a-2", type });

  it("reports nothing when every edge is one anton writes", () => {
    expect(auditLinkTypes(LINK_TYPES.map((t) => edge(t)))).toEqual([]);
  });

  it("finds the silent no-op edge a typo left behind", () => {
    const strays = auditLinkTypes([edge("blocks"), edge("waits-for"), edge("blocsk")]);
    expect(strays).toEqual([
      { from: "a-1", to: "a-2", type: "waits-for" },
      { from: "a-1", to: "a-2", type: "blocsk" },
    ]);
    expect(unexplainedEdges(strays)).toHaveLength(2);
  });

  it("flags a `conditional-blocks` stray as blocking — it orders work, it is just not our spelling", () => {
    const strays = auditLinkTypes([edge("conditional-blocks"), edge("waits-for")]);
    expect(strays).toEqual([
      { from: "a-1", to: "a-2", type: "conditional-blocks", blocking: true },
      { from: "a-1", to: "a-2", type: "waits-for" },
    ]);
    // Both are unexplained — the flag separates "orders nothing" from "orders work we can't read".
    expect(unexplainedEdges(strays)).toHaveLength(2);
  });

  it("reports a `supersedes` edge but explains it — bd writes it for `bd supersede`", () => {
    const strays = auditLinkTypes([edge("supersedes")]);
    expect(strays).toEqual([
      { from: "a-1", to: "a-2", type: "supersedes", writtenBy: "bd supersede (beads.supersede)" },
    ]);
    // Explained, so it never fails the audit — otherwise every board reports a permanent finding.
    expect(unexplainedEdges(strays)).toEqual([]);
  });
});
