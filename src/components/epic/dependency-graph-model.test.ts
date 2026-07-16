import { describe, expect, it } from "vitest";
import { orientEdge } from "@/components/epic/dependency-graph-model";
import type { DepEdge } from "@/lib/types";

function edge(from: string, to: string, type: DepEdge["type"]): DepEdge {
  return { from, to, type };
}

describe("orientEdge", () => {
  it("flips a blocks edge to blocker→blocked so the arrow reads 'X blocks Y'", () => {
    // beads stores blocks as blocked→blocker (from = the blocked/dependent side). "b" is blocked by
    // "a", so the rendered arrow must point from the blocker "a" to the blocked "b".
    expect(orientEdge(edge("b", "a", "blocks"))).toEqual({ source: "a", target: "b" });
  });

  it("keeps non-blocks edges in their stored direction", () => {
    // parent-child reads correctly as stored (child → parent = "child part of parent"); related and
    // discovered-from likewise. None of these should be flipped.
    expect(orientEdge(edge("child", "parent", "parent-child"))).toEqual({
      source: "child",
      target: "parent",
    });
    expect(orientEdge(edge("x", "y", "related"))).toEqual({ source: "x", target: "y" });
    expect(orientEdge(edge("x", "y", "discovered-from"))).toEqual({ source: "x", target: "y" });
  });
});
