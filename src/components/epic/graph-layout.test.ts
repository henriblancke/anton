import { describe, expect, it } from "vitest";
import { layoutGraphNodes } from "@/components/epic/graph-layout";

describe("layoutGraphNodes", () => {
  it("returns an empty map for empty input", () => {
    expect(layoutGraphNodes([], []).size).toBe(0);
  });

  it("positions every node, including ones with no edges", () => {
    const positions = layoutGraphNodes(
      [
        { id: "a", width: 100, height: 50 },
        { id: "b", width: 100, height: 50 },
        { id: "isolated", width: 100, height: 50 },
      ],
      [{ source: "a", target: "b" }],
    );

    expect(positions.size).toBe(3);
    for (const id of ["a", "b", "isolated"]) {
      const position = positions.get(id);
      expect(position).toBeDefined();
      expect(Number.isFinite(position?.x)).toBe(true);
      expect(Number.isFinite(position?.y)).toBe(true);
    }
  });

  it("ranks nodes top-to-bottom along the edge direction in TB (default) mode", () => {
    const positions = layoutGraphNodes(
      [
        { id: "parent", width: 120, height: 60 },
        { id: "child", width: 120, height: 60 },
      ],
      [{ source: "parent", target: "child" }],
    );

    const parent = positions.get("parent")!;
    const child = positions.get("child")!;
    expect(parent.y).toBeLessThan(child.y);
  });

  it("ranks nodes left-to-right along the edge direction in LR mode", () => {
    const positions = layoutGraphNodes(
      [
        { id: "parent", width: 120, height: 60 },
        { id: "child", width: 120, height: 60 },
      ],
      [{ source: "parent", target: "child" }],
      { direction: "LR" },
    );

    const parent = positions.get("parent")!;
    const child = positions.get("child")!;
    expect(parent.x).toBeLessThan(child.x);
  });

  it("ignores edges that reference an unknown node id", () => {
    const positions = layoutGraphNodes(
      [{ id: "only", width: 100, height: 50 }],
      [{ source: "only", target: "missing" }],
    );

    expect(positions.size).toBe(1);
    expect(positions.get("only")).toBeDefined();
  });

  it("separates disconnected branches sharing the same rank", () => {
    const positions = layoutGraphNodes(
      [
        { id: "root", width: 100, height: 50 },
        { id: "left", width: 100, height: 50 },
        { id: "right", width: 100, height: 50 },
      ],
      [
        { source: "root", target: "left" },
        { source: "root", target: "right" },
      ],
    );

    const left = positions.get("left")!;
    const right = positions.get("right")!;
    expect(left.x).not.toBe(right.x);
  });
});
