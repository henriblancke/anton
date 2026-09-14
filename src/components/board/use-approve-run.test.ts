import { describe, expect, it } from "vitest";

import { approveOutcomeMessage } from "@/components/board/use-approve-run";

describe("approveOutcomeMessage", () => {
  it("reports an applied gardener proposal as the board move it made, never as a run", () => {
    // anton-1t3n: approving a PROPOSAL applies it and closes the bead — no run ever starts.
    expect(approveOutcomeMessage({ applied: "closed t-9 as duplicate", immediate: true, title: "x" })).toBe(
      "Applied — closed t-9 as duplicate",
    );
  });

  it("distinguishes running now from queuing for the budget governor", () => {
    expect(approveOutcomeMessage({ immediate: true, title: "Loose task" })).toBe(
      'Approved & running "Loose task"',
    );
    expect(approveOutcomeMessage({ immediate: false, title: "Loose task" })).toBe(
      'Queued "Loose task" for optimal usage',
    );
  });
});
