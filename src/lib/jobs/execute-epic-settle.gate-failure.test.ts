/**
 * A run stopped by a red verify gate records that gate on its row (anton-vynb8), so the retry — a
 * fresh walk over this same row — opens with it instead of blind.
 *
 * Written from the TYPED error the gate threw, never parsed back out of `error`: that field is one
 * operator-facing sentence, it is reworded freely, and the resume clears it. Any other failure
 * writes nothing here, leaving whatever the row already remembers — a run that dies in commit or
 * push has learned nothing new about its gates.
 */
import { describe, expect, it, vi } from "vitest";
import { PoisonEpic, VerifyGateFailedError } from "./errors";
import { decodeGateFailure } from "./gate-failure-record";
import { MAX_GATE_OUTPUT_CHARS } from "./gate-output";

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

function redGate(
  output: string,
  site?: { beadId: string; stepId?: string },
): VerifyGateFailedError {
  return new VerifyGateFailedError(
    "tests gate failed for anton-t1 (exit 1)",
    { label: "tests", command: "bun run test", ok: false, code: 1, output },
    site,
  );
}

/** The patch the settle's last `updateRun` wrote. */
function lastPatch(): Record<string, unknown> | undefined {
  const call = updateRunMock.mock.calls.at(-1) as unknown as unknown[] | undefined;
  return call?.[3] as Record<string, unknown> | undefined;
}

/** The `lastGateFailure` the settle wrote, decoded — `untouched` when it wrote no such key at all. */
function recorded(): ReturnType<typeof decodeGateFailure> | "untouched" {
  const patch = lastPatch();
  if (!patch || !("lastGateFailure" in patch)) return "untouched";
  return decodeGateFailure(patch.lastGateFailure as string | null);
}

describe("settling a run stopped by a red verify gate", () => {
  it("records the gate, its command, its exit code and where it failed", async () => {
    updateRunMock.mockClear();

    await settleStoppedRun(fakeRun(), redGate("FAIL one", { beadId: "anton-t1", stepId: "verify" }));

    expect(recorded()).toEqual({
      label: "tests",
      command: "bun run test",
      code: 1,
      output: "FAIL one",
      beadId: "anton-t1",
      stepId: "verify",
    });
  });

  // A gate thrown without a site still names a bead: the run target it stopped.
  it("falls back to the run target when the gate named no bead", async () => {
    updateRunMock.mockClear();

    await settleStoppedRun(fakeRun(), redGate("FAIL one"));

    expect((recorded() as { beadId: string }).beadId).toBe("anton-epic");
  });

  // The same bound and the same end as the reviewer's own gate evidence.
  it("tails the stored output at the reviewer's cap", async () => {
    updateRunMock.mockClear();
    const output = `${"progress\n".repeat(2000)}FAIL the one that matters`;

    await settleStoppedRun(fakeRun(), redGate(output));

    const stored = (recorded() as { output: string }).output;
    expect(stored).toContain("FAIL the one that matters");
    expect(stored).toContain("… [earlier output omitted]");
    expect(stored.length).toBeLessThan(output.length);
    expect(stored.length).toBeLessThanOrEqual(MAX_GATE_OUTPUT_CHARS + 64);
  });

  // The error sentence is untouched — the record sits beside it, not instead of it.
  it("leaves the row's error exactly as it was", async () => {
    updateRunMock.mockClear();

    await settleStoppedRun(fakeRun(), redGate("FAIL one"));

    expect(lastPatch()?.status).toBe("failed");
    expect(lastPatch()?.error).toBe("tests gate failed for anton-t1 (exit 1)");
  });

  it("writes no record for a failure that was not a gate, leaving what the row remembers", async () => {
    updateRunMock.mockClear();

    await settleStoppedRun(fakeRun(), new Error("push rejected by the remote"));

    expect(recorded()).toBe("untouched");
  });

  // A park is not this branch at all — the poison path writes its own patch and touches nothing here.
  it("writes no record when the run parks on a poison", async () => {
    updateRunMock.mockClear();

    await settleStoppedRun(fakeRun(), new PoisonEpic("anton-epic has no tickets"));

    expect(recorded()).toBe("untouched");
  });
});
