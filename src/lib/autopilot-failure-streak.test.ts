/**
 * The consecutive-failure breaker's arithmetic (anton-rgso / R4.4).
 *
 * Four properties carry it, and each is a different way to be wrong about the same evidence:
 *
 *   • N-1 failures must NOT disarm, N must. A breaker that fires early trains an operator to re-arm
 *     without reading, which is worse than no breaker at all.
 *   • a delivered run RESETS. Work landing is the proof the environment isn't broken.
 *   • an operator's cancel counts as NOTHING — neither a failure nor a reset. It is a person saying
 *     stop, and says nothing either way about the environment.
 *   • the weighting is the caller's, because a failed auto-repair will later count double.
 */
import { describe, expect, it } from "vitest";
import {
  describeFailureStreak,
  detectFailureStreak,
  failureStreakEvidence,
  verdictOf,
  type FailureWeight,
  type RunOutcome,
} from "./autopilot-failure-streak";

const THREE: { threshold: number } = { threshold: 3 };

/** Runs are handed to the breaker NEWEST FIRST, as `listRecentRunOutcomes` returns them. */
function run(id: string, over: Partial<RunOutcome> = {}): RunOutcome {
  return { id, epicBeadId: `anton-${id}`, status: "failed", ...over };
}

const delivered = (id: string) => run(id, { status: "done" });

describe("verdictOf", () => {
  it("reads a delivery, a failure and an in-flight run apart", () => {
    expect(verdictOf(run("a", { status: "done" }))).toBe("delivered");
    expect(verdictOf(run("b", { status: "failed" }))).toBe("failure");
    expect(verdictOf(run("c", { status: "parked" }))).toBe("failure");
    expect(verdictOf(run("d", { status: "running" }))).toBe("ignored");
    expect(verdictOf(run("e", { status: "queued" }))).toBe("ignored");
  });

  it("counts an abandoned run as a failure even though abandoning also cancels its job", () => {
    expect(verdictOf(run("a", { abandoned: true, cancelled: true }))).toBe("failure");
  });

  it("counts an operator's cancel as nothing", () => {
    expect(verdictOf(run("a", { status: "failed", cancelled: true }))).toBe("ignored");
    expect(verdictOf(run("b", { status: "parked", cancelled: true }))).toBe("ignored");
  });
});

describe("detectFailureStreak", () => {
  it("does not disarm at N-1 failures", () => {
    expect(detectFailureStreak([run("c"), run("b")], THREE)).toBeUndefined();
  });

  it("disarms at N, naming the runs oldest first", () => {
    const streak = detectFailureStreak([run("c"), run("b"), run("a")], THREE);
    expect(streak?.weight).toBe(3);
    expect(streak?.runs.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("resets on a delivered run — the failures behind it are a closed chapter", () => {
    const runs = [run("d"), run("c"), delivered("x"), run("b"), run("a")];
    expect(detectFailureStreak(runs, THREE)).toBeUndefined();
  });

  it("counts an abandoned run, whatever its row says", () => {
    const runs = [run("c"), run("b", { status: "running", abandoned: true }), run("a")];
    expect(detectFailureStreak(runs, THREE)?.runs.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("skips a cancelled run without letting it break the streak either", () => {
    // Three real failures with an operator's cancel sitting in the middle of them: the cancel is
    // neither counted nor treated as a reset, so the streak either side of it is still one story.
    const runs = [run("d"), run("c", { cancelled: true }), run("b"), run("a")];
    const streak = detectFailureStreak(runs, THREE);
    expect(streak?.runs.map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(streak?.weight).toBe(3);
  });

  it("stays silent when the only failures were cancelled", () => {
    const runs = [run("c", { cancelled: true }), run("b", { cancelled: true }), run("a")];
    expect(detectFailureStreak(runs, THREE)).toBeUndefined();
  });

  it("is off when the threshold is 0 — the operator's opt-out", () => {
    const runs = [run("c"), run("b"), run("a")];
    expect(detectFailureStreak(runs, { threshold: 0 })).toBeUndefined();
    expect(detectFailureStreak(runs, undefined)).toBeUndefined();
  });

  it("trips earlier under a weigher that counts some failures double", () => {
    // The seam a failed auto-repair uses later: two runs, one of which is worth two.
    const double: FailureWeight = (r) => (r.epicBeadId === "anton-b" ? 2 : 1);
    const runs = [run("b"), run("a")];
    expect(detectFailureStreak(runs, THREE)).toBeUndefined();
    const weighted = detectFailureStreak(runs, { ...THREE, weigh: double });
    expect(weighted?.weight).toBe(3);
    expect(weighted?.runs).toHaveLength(2);
  });
});

describe("the case the operator reads", () => {
  const timeout = (id: string, ticket: string) =>
    run(id, { error: `ticket ${ticket} timed out after 45m\n  at step commit` });

  it("names the shared failure point when the runs differ only in their ids", () => {
    const runs = [timeout("c", "anton-c3"), timeout("b", "anton-b2"), timeout("a", "anton-a1")];
    const streak = detectFailureStreak(runs, THREE)!;
    expect(streak.commonFailure).toBe("ticket anton-a1 timed out after 45m");
    expect(describeFailureStreak(streak)).toBe(
      "3 runs in a row ended without delivering, every one of them at the same point: " +
        "ticket anton-a1 timed out after 45m",
    );
  });

  it("names no shared point when the failures genuinely differ", () => {
    const runs = [
      run("c", { error: "test gate failed" }),
      timeout("b", "anton-b2"),
      timeout("a", "anton-a1"),
    ];
    const streak = detectFailureStreak(runs, THREE)!;
    expect(streak.commonFailure).toBeUndefined();
    expect(describeFailureStreak(streak)).toBe(
      "3 runs in a row ended without delivering, with no failure point in common.",
    );
  });

  it("names no shared point when one run recorded no error at all", () => {
    const runs = [run("c"), timeout("b", "anton-b2"), timeout("a", "anton-a1")];
    expect(detectFailureStreak(runs, THREE)!.commonFailure).toBeUndefined();
  });

  it("lists every run in the streak — the count alone cannot say which work is stuck", () => {
    const runs = [
      run("cccccccc", { epicBeadId: "anton-two", error: "test gate failed" }),
      run("bbbbbbbb", { epicBeadId: "anton-one", status: "parked", error: "usage-limit" }),
      run("aaaaaaaa", { epicBeadId: "anton-one", abandoned: true, error: "cancelled" }),
    ];
    expect(failureStreakEvidence(detectFailureStreak(runs, THREE)!)).toEqual([
      "aaaaaaaa · anton-one · abandoned · cancelled",
      "bbbbbbbb · anton-one · parked · usage-limit",
      "cccccccc · anton-two · failed · test gate failed",
    ]);
  });
});
