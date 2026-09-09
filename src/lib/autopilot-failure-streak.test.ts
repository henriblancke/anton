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
import { STALE_CHECKOUT_REFUSAL_PREFIX } from "./jobs/errors";

/** A settled run row's error for a stale-checkout deferral, as `settleRunRow` composes it. */
const STALE = `${STALE_CHECKOUT_REFUSAL_PREFIX} its checkout is 2 commit(s) behind origin/main — run \`git pull\``;

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

  it("counts a stale-checkout deferral as nothing — no work was attempted", () => {
    // The row reads `failed`, but the run refused a start on a machine-wide staleness that clears on
    // restart; it must not weigh toward a per-project disarm.
    expect(verdictOf(run("a", { status: "failed", error: STALE }))).toBe("ignored");
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

  it("does not disarm on a run of stale-checkout deferrals — nothing was attempted", () => {
    const runs = [run("c", { error: STALE }), run("b", { error: STALE }), run("a", { error: STALE })];
    expect(detectFailureStreak(runs, THREE)).toBeUndefined();
  });

  it("skips a stale-checkout deferral without breaking the streak either", () => {
    // A machine-wide staleness sitting between real failures neither counts nor resets — the runs
    // either side are still one story, exactly as a cancel is treated.
    const runs = [run("d"), run("c", { error: STALE }), run("b"), run("a")];
    const streak = detectFailureStreak(runs, THREE);
    expect(streak?.runs.map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(streak?.weight).toBe(3);
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
    run(id, {
      ticketBeadId: ticket,
      error: `ticket ${ticket} timed out after 45m\n  at step commit`,
    });

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

  /**
   * The three real parks the digit heuristic split (anton-q2jw): one broken ordering described three
   * times, differing ONLY in the bead ids each run was carrying — and two of those ids
   * (`anton-gsny`, `anton-ptsy`) carry no digit at all, so nothing about their shape says they vary.
   */
  const depMissingPark = (ticket: string, blocker: string) =>
    `${ticket} is blocked by ${blocker} — refusing to execute; resume the run once the blocker(s) ` +
    `complete — anton drew that edge itself after the agent reported \`dep-missing\`: recorded ` +
    `\`${blocker}\` as a blocker of ${ticket} (bd link ${ticket} ${blocker} --type blocks), ` +
    `parking it until that lands`;

  const blocked = (id: string, epic: string, ticket: string, blocker: string) =>
    run(id, {
      epicBeadId: epic,
      ticketBeadId: ticket,
      status: "parked",
      error: depMissingPark(ticket, blocker),
    });

  it("collapses three parks that differ only in ids whose characters say nothing", () => {
    const runs = [
      blocked("c", "anton-stb2", "anton-0lom", "anton-k4qr"),
      blocked("b", "anton-u189", "anton-7zpv", "anton-gsny"),
      blocked("a", "anton-x37c", "anton-n8eb", "anton-ptsy"),
    ];
    expect(detectFailureStreak(runs, THREE)!.commonFailure).toBe(
      "anton-n8eb is blocked by anton-ptsy — refusing to execute; resume the run once the " +
        "blocker(s) complete — anton drew that edge itself after t",
    );
  });

  it("masks the run target too, not only the ticket and its blockers", () => {
    const target = (epic: string) =>
      run(epic, { epicBeadId: epic, error: `worktree for ${epic} would not check out` });
    const runs = [target("anton-gsny"), target("anton-ptsy"), target("anton-k4qr")];
    expect(detectFailureStreak(runs, THREE)!.commonFailure).toBe(
      "worktree for anton-k4qr would not check out",
    );
  });

  it("still reports nothing when one of those parks is a different failure", () => {
    const runs = [
      run("c", { epicBeadId: "anton-stb2", error: "test gate failed: 3 tests red" }),
      blocked("b", "anton-u189", "anton-7zpv", "anton-gsny"),
      blocked("a", "anton-x37c", "anton-n8eb", "anton-ptsy"),
    ];
    expect(detectFailureStreak(runs, THREE)!.commonFailure).toBeUndefined();
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

/**
 * What a signature masks, and — as much the point — what it no longer does (anton-4mql). Every row
 * is three runs differing in ONE fragment: a quantity collapses and the streak keeps its common
 * point; anything else stands and the streak honestly reports none. The pairs of rows that differ
 * only in whether the varying token carries a digit are the criterion itself — character shape alone
 * must never decide the verdict, so both members of a pair must land the same way.
 */
describe("what a failure point is compared modulo", () => {
  const EPIC = "anton-w0rk";

  /** The table reads oldest first; the breaker is handed runs newest first, as its callers do. */
  const commonPointOf = (points: readonly string[]) =>
    detectFailureStreak(
      points.map((error, i) => run(`r${i}`, { epicBeadId: EPIC, error })).reverse(),
      THREE,
    )!.commonFailure;

  const cases: Array<{ what: string; points: [string, string, string]; shared: boolean }> = [
    {
      what: "durations — the same timeout, three lengths",
      points: [
        "worktree checkout timed out after 45m",
        "worktree checkout timed out after 90m",
        "worktree checkout timed out after 1h30m",
      ],
      shared: true,
    },
    {
      what: "durations spelled every way an error spells them",
      points: [
        "test gate gave up after 2.5s",
        "test gate gave up after 1500ms",
        "test gate gave up after 3 minutes",
      ],
      shared: true,
    },
    {
      what: "ports — one dev server that will not bind",
      points: [
        "dev server could not bind localhost:3000",
        "dev server could not bind localhost:3001",
        "dev server could not bind localhost:5432",
      ],
      shared: true,
    },
    {
      what: "a port named in words",
      points: [
        "port 3000 is already in use",
        "port 3001 is already in use",
        "port 51234 is already in use",
      ],
      shared: true,
    },
    {
      what: "an exit code is NOT a quantity — 137 is an OOM kill and 1 is a test failure",
      points: [
        "the build exited with code 1",
        "the build exited with code 2",
        "the build exited with code 137",
      ],
      shared: false,
    },
    {
      what: "paths differing by a digit stand — the old rule masked these",
      points: [
        "/tmp/anton-run-1/worktree is missing",
        "/tmp/anton-run-2/worktree is missing",
        "/tmp/anton-run-3/worktree is missing",
      ],
      shared: false,
    },
    {
      what: "paths differing by a letter stand too — and that is the same verdict as the digits",
      points: [
        "/tmp/anton-run-a/worktree is missing",
        "/tmp/anton-run-b/worktree is missing",
        "/tmp/anton-run-c/worktree is missing",
      ],
      shared: false,
    },
    {
      what: "bead ids the row cannot name stand, digits or none — the old rule split on exactly this",
      points: [
        "waiting on anton-k4qr before this can run",
        "waiting on anton-gsny before this can run",
        "waiting on anton-ptsy before this can run",
      ],
      shared: false,
    },
    {
      what: "an id whose base36 tail reads like a duration is still an id",
      points: [
        "anton-12ms would not check out",
        "anton-34ms would not check out",
        "anton-56ms would not check out",
      ],
      shared: false,
    },
    {
      what: "…and the duration beside that id still masks",
      points: [
        "anton-12ms timed out after 45m",
        "anton-12ms timed out after 90m",
        "anton-12ms timed out after 1h30m",
      ],
      shared: true,
    },
    {
      what: "identical points — the control",
      points: [
        "base branch would not check out",
        "base branch would not check out",
        "base branch would not check out",
      ],
      shared: true,
    },
  ];

  for (const { what, points, shared } of cases) {
    it(shared ? `collapses ${what}` : `keeps ${what} apart`, () => {
      expect(commonPointOf(points)).toBe(shared ? points[0] : undefined);
    });
  }
});

/**
 * Where the 140-character cut lands must not decide whether two failures are the same story
 * (anton-tyk0). The signature is compared on the whole first line; the cut is a display budget, and
 * the pair of tests either side of it is the whole claim.
 */
describe("the display cut", () => {
  const EPIC = "anton-w0rk";

  /** The module's display budget, restated because it is the boundary under test. */
  const DISPLAY_CHARS = 140;

  /** Exactly one display's worth of failure, so anything appended sits past the cut. */
  const PREFIX = "test gate failed while checking ".padEnd(DISPLAY_CHARS, "migrations ");

  const streakOf = (points: readonly string[]) =>
    detectFailureStreak(
      points.map((error, i) => run(`r${i}`, { epicBeadId: EPIC, error })).reverse(),
      THREE,
    )!;

  it("reports no common point when the runs differ only past the cut", () => {
    const streak = streakOf([
      `${PREFIX}: relation "runs" is missing`,
      `${PREFIX}: relation "beads" is missing`,
      `${PREFIX}: relation "jobs" is missing`,
    ]);
    expect(streak.commonFailure).toBeUndefined();
  });

  it("reports one point when the runs agree past the cut", () => {
    const point = `${PREFIX}: relation "runs" is missing`;
    const streak = streakOf([point, point, point]);
    expect(streak.commonFailure).toBe(PREFIX);
  });

  it("cuts what it prints, in the summary and in the evidence alike", () => {
    const point = `${PREFIX}: relation "runs" is missing`;
    const streak = streakOf([point, point, point]);
    expect(streak.commonFailure).toHaveLength(DISPLAY_CHARS);
    expect(describeFailureStreak(streak)).toBe(
      `3 runs in a row ended without delivering, every one of them at the same point: ${PREFIX}`,
    );
    expect(failureStreakEvidence(streak)[0]).toBe(`r0 · ${EPIC} · failed · ${PREFIX}`);
  });
});
