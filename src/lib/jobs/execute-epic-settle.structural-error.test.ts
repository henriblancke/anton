/**
 * anton-4kvp / anton-ocm4: the catch-all failure branch is where a `NoDeliveryError`/
 * `BlockedByAgentError` actually lands once the ticket loop's poison bubbles up through the epic
 * handler — `settleRunRow`'s other branches all name a specific park (usage limit, board outage,
 * held tail, blocked review). Without this, the split those errors carry (anton's own account vs.
 * the agent's quoted self-report) was composed and then thrown away the instant it was caught: the
 * row's `error` column got the whole rendered message and nothing ever recovered the structural
 * half back out of it — which is what left the consecutive-failure breaker's signature always
 * falling back to the full string (anton-ocm4's own regression).
 */
import { describe, expect, it, vi } from "vitest";
import { NoDeliveryError } from "./execute-epic-errors";

const updateRunMock = vi.fn(async () => undefined);

vi.mock("../runs", () => ({
  updateRun: (...args: unknown[]) => updateRunMock(...(args as [])),
}));

const { settleStoppedRun } = await import("./execute-epic-settle");
import type { EpicRun } from "./execute-epic-run";

function fakeRun(): EpicRun {
  return {
    db: {},
    clock: { now: () => 1_000 },
    ctx: { signal: new AbortController().signal },
    projectId: "proj-1",
    repo: "/tmp/anton-repo",
    targetId: "anton-epic",
    runId: "run-1",
    orphanNotice: "",
    timedOut: [],
    childCascade: null,
    worktree: undefined,
  } as unknown as EpicRun;
}

describe("settling a run the catch-all failure branch takes", () => {
  it("persists anton's structural half apart from the rendered error, for a NoDeliveryError", async () => {
    const structural =
      "anton-t1 produced no delivery: claude exited cleanly and passed the verify gates but left " +
      "no changes to commit (zero diff).";
    const rendered =
      `${structural} The agent self-reported blocked — the acceptance criteria contradict each ` +
      `other., corroborating the block.`;
    const error = new NoDeliveryError(rendered, structural, {
      outcome: "blocked",
      reason: "the acceptance criteria contradict each other",
    });

    const { thrown } = await settleStoppedRun(fakeRun(), error);

    expect(thrown).toBe(error);
    expect(updateRunMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), "run-1", {
      status: "failed",
      error: rendered,
      structuralError: structural,
      endedAt: 1_000,
    });
  });

  it("degrades a plain Error to its whole message on both columns — nothing to split out", async () => {
    const error = new Error("ECONNRESET: socket hang up");

    await settleStoppedRun(fakeRun(), error);

    expect(updateRunMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), "run-1", {
      status: "failed",
      error: "ECONNRESET: socket hang up",
      structuralError: "ECONNRESET: socket hang up",
      endedAt: 1_000,
    });
  });
});
