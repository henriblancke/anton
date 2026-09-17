/**
 * A typed board outage during the initial lease publish must PARK the run row, not fail it (PR #277
 * review). `beginEpicRun` opens the run row before the lease is ever claimed, and `publishOrPark`
 * (execute-epic-lease.ts) rethrows a `BoardUnreachableError` unchanged rather than wrapping it as a
 * `RunAlreadyLiveError` — so without a dedicated branch here, `settleRunRow`'s catch-all marks the
 * row FAILED. `findOpenRunForEpic` only resumes queued/running/parked rows, so a failed row is
 * invisible to it: every outage-probe retry would open a brand new row, turning one outage into one
 * failed run per probe for as long as it lasts.
 */
import { describe, expect, it, vi } from "vitest";
import { BoardUnreachableError } from "./errors";

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

describe("settling a run stopped by a board outage", () => {
  it("parks the row instead of failing it", async () => {
    const run = fakeRun();
    const outage = new BoardUnreachableError("Dolt server unreachable");

    const { thrown } = await settleStoppedRun(run, outage);

    expect(thrown).toBe(outage);
    expect(updateRunMock).toHaveBeenCalledWith(run.db, run.clock, "run-1", {
      status: "parked",
      error: "board-unreachable",
    });
    // No endedAt: a parked row must stay OPEN for `findOpenRunForEpic` to resume it.
    const call = updateRunMock.mock.calls[0] as unknown as unknown[];
    expect((call[3] as Record<string, unknown> | undefined)?.endedAt).toBeUndefined();
  });

  it("carries the orphan notice into the park error, like the run-live-elsewhere park does", async () => {
    const run = fakeRun();
    (run as { orphanNotice: string }).orphanNotice = " (orphan PR anton/anton-epic found on GitHub)";

    await settleStoppedRun(run, new BoardUnreachableError("Dolt server unreachable"));

    expect(updateRunMock).toHaveBeenCalledWith(run.db, run.clock, "run-1", {
      status: "parked",
      error: "board-unreachable (orphan PR anton/anton-epic found on GitHub)",
    });
  });
});
