/**
 * The prompt the product-master pass actually runs with (anton-d2sx): a reasoning contract, the
 * concrete board, and the report protocol — in that order.
 *
 * What each part says is tested next to the module that owns it (board-context, report, refusals).
 * What this file protects is the ASSEMBLY: an operator prompt may restyle the judgment, and must
 * never be able to change what the pass is judging or how anton reads its answer.
 */
import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../projects";
import { buildProductMasterPrompt } from "./context";

const board = {
  board: [{ id: "anton-a", title: "Charge retries", status: "open", issue_type: "feature" }],
  now: Date.parse("2026-08-04T12:00:00Z"),
};

describe("buildProductMasterPrompt", () => {
  it("appends anton's own board and report protocol beneath the reasoning contract", async () => {
    const { prompt, reasoningFrom } = await buildProductMasterPrompt({
      settings: { productMasterPrompt: "Judge it my way." } as ProjectSettings,
      board,
    });
    expect(reasoningFrom).toEqual({ kind: "prompt" });
    expect(prompt.indexOf("Judge it my way.")).toBeLessThan(prompt.indexOf("## Board context"));
    expect(prompt.indexOf("## Board context")).toBeLessThan(
      prompt.indexOf("## Reporting format (required)"),
    );
    // The board anton resolved, not one the session would have to read for itself.
    expect(prompt).toContain("- anton-a [feature]");
  });

  it("falls back to anton's shipped skill when the operator set no prompt", async () => {
    const { prompt, reasoningFrom } = await buildProductMasterPrompt({
      settings: {} as ProjectSettings,
      board,
    });
    expect(reasoningFrom).toEqual({ kind: "default" });
    expect(prompt).toContain("## Board context");
    expect(prompt).toContain("## Reporting format (required)");
  });
});
