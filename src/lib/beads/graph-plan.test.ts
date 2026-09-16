/**
 * Direct suite for graph-plan.ts (anton-ql1n): {@link graphPlanError}, the reader for the refusal
 * `bd create --graph` prints as `{"error": …}` on STDOUT while exiting non-zero. The subprocess
 * round-trip (bd-graph.test.ts) drives `beads.createGraph` against a real fake bd; this pins the
 * pure extraction alone.
 */
import { describe, expect, it } from "vitest";
import { graphPlanError } from "@/lib/beads/graph-plan";

describe("graphPlanError", () => {
  it("extracts the error string from bd's JSON stdout", () => {
    const err = { stdout: '{"error":"graph create: node \\"feature\\": issue p-nope not found"}' };
    expect(graphPlanError(err)).toBe('graph create: node "feature": issue p-nope not found');
  });

  it("returns undefined when stdout parses but carries no error field", () => {
    expect(graphPlanError({ stdout: '{"ids":{"epic":"p-1"}}' })).toBeUndefined();
  });

  it("returns undefined when stdout is not JSON at all", () => {
    expect(graphPlanError({ stdout: "not json at all" })).toBeUndefined();
  });

  it("returns undefined when the error carries no stdout", () => {
    expect(graphPlanError({})).toBeUndefined();
    expect(graphPlanError(new Error("Command failed"))).toBeUndefined();
  });
});
