/**
 * The runner's PURE durability policy (anton-dzh.1): given a job row and a classified failure, what
 * must happen next — complete, reschedule (with or without refunding the attempt), or park. No db,
 * no clock, no runner; the live-loop proof that the loop actually obeys these decisions lives in the
 * sibling `runner.lifecycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { RunAlreadyLiveError, SyncNotWiredError } from "./errors";
import { BUDGET_DEFER_PREFIX, BUDGET_DEFER_PRIOR_SEP } from "./queue";
import { classifyError, hasPriorAttempt, nextAction } from "./runner";
import { CONFIG } from "./runner.fixture";

describe("hasPriorAttempt (durable evidence of an unfinished attempt)", () => {
  it("reads a first attempt as the job's first", () => {
    expect(hasPriorAttempt({ attempts: 1, lastError: null })).toBe(false);
  });

  it("counts a second lease — the first attempt ran and did not complete", () => {
    expect(hasPriorAttempt({ attempts: 2, lastError: null })).toBe(true);
  });

  it("counts a refunded retry by the error it stamped, not by attempts", () => {
    // Quota / lease-held / not-wired rewind `attempts`, so the row's error is their only trace.
    expect(hasPriorAttempt({ attempts: 1, lastError: "usage-limit: resumes at …" })).toBe(true);
  });

  it("ignores a budget-defer marker — pacing stamps a QUEUED row that never ran", () => {
    const lastError = `${BUDGET_DEFER_PREFIX}weekly pace — resumes at 2026-01-01T00:00:00.000Z`;
    expect(hasPriorAttempt({ attempts: 1, lastError })).toBe(false);
    // Once an attempt has actually run, the stale marker no longer decides it.
    expect(hasPriorAttempt({ attempts: 2, lastError })).toBe(true);
  });

  it("still counts a refunded attempt whose error a later defer carried inside the marker", () => {
    // A deferral can land on a row a refunded attempt already ran; `deferQueuedJobs` appends that
    // attempt's error rather than replacing it, so the evidence survives into the next lease.
    const lastError =
      `${BUDGET_DEFER_PREFIX}weekly pace — resumes at 2026-01-01T00:00:00.000Z` +
      `${BUDGET_DEFER_PRIOR_SEP}usage-limit: resumes at …`;
    expect(hasPriorAttempt({ attempts: 1, lastError })).toBe(true);
  });
});

describe("nextAction (pure durability policy)", () => {
  const now = 1_000_000_000_000;
  it("completes on success", () => {
    expect(nextAction(CONFIG, { attempts: 1 }, { kind: "success" }, now)).toEqual({
      action: "complete",
    });
  });

  it("reschedules a quota hit to the reset time and refunds the attempt but not its spend", () => {
    // The limit is Claude's own answer, so the attempt reached it — and a multi-call handler may
    // have finished a whole PR before the wall. The retry budget comes back; the project's spend
    // meter keeps the charge, as it does for every other attempt the runner sampled.
    const resetAt = Math.floor(now / 1000) + 3600; // seconds
    const a = nextAction(CONFIG, { attempts: 2 }, { kind: "quota", resetAt }, now);
    expect(a.action).toBe("reschedule");
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.refundAttempt).toBe(true);
    expect(a.refundSpend).toBe(false);
    expect(a.runAtMs).toBe(resetAt * 1000);
  });

  it("uses the cool-off window when the reset time is unknown", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "quota" }, now);
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.quotaCooloffMs);
    expect(a.refundAttempt).toBe(true);
  });

  it("parks immediately on a poison error", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "poison", error: "boom" }, now);
    expect(a.action).toBe("park");
  });

  it("reschedules a run-live-elsewhere hit after a cool-off and refunds the attempt (anton-jz1)", () => {
    // A foreign live lease is not this job's failure and the other run may hold it a long time, so
    // the attempt is refunded — it re-checks liveness each cool-off and must never poison-park.
    const a = nextAction(CONFIG, { attempts: 3 }, { kind: "lease-held", error: "live on B" }, now);
    expect(a.action).toBe("reschedule");
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.quotaCooloffMs);
    expect(a.refundAttempt).toBe(true);
    expect(a.refundSpend).toBe(true); // liveness is checked before Claude is invoked
  });

  it("keeps the classified reason on the row a lease-held reschedule writes (anton-3dpp)", () => {
    // Two very different situations reschedule identically: a foreign machine holding the lease, and
    // a run that could not PROVE it holds one because its board write failed. The row's text is the
    // only place that difference survives — a bare "run live elsewhere" reads as the first when it
    // was the second, and sends an operator (or a CI reader) looking for a machine that never ran.
    const unproven =
      "epic-1 could not publish its run-lease to the shared board (bd dolt push failed) — parking";
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "lease-held", error: unproven }, now);
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.lastError).toContain(unproven);
    expect(a.lastError).toContain(new Date(now + CONFIG.quotaCooloffMs).toISOString());
  });

  it("classifies RunAlreadyLiveError as a lease-held outcome (anton-jz1)", () => {
    expect(classifyError(new RunAlreadyLiveError("live on B"))).toEqual({
      kind: "lease-held",
      error: "live on B",
    });
  });

  it("rechecks a not-wired project on a slow cadence and refunds the attempt (anton-x7la)", () => {
    // Nothing was delivered, so the job must not complete — but only a human wiring a remote can
    // unblock it, so it never burns attempts toward a park either, even past maxAttempts.
    const a = nextAction(CONFIG, { attempts: 3 }, { kind: "not-wired", error: "no remote" }, now);
    expect(a.action).toBe("reschedule");
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.notWiredRetryMs);
    expect(a.refundAttempt).toBe(true);
    expect(a.refundSpend).toBe(true); // nothing was invoked, so nothing was spent
    expect(a.lastError).toMatch(/not wired/i);
  });

  it("classifies SyncNotWiredError as a not-wired outcome (anton-x7la)", () => {
    expect(classifyError(new SyncNotWiredError("no remote"))).toEqual({
      kind: "not-wired",
      error: "no remote",
    });
  });

  it("retries with exponential backoff below the attempt cap", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "error", error: "flaky" }, now);
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.backoffBaseMs); // 2^0
    const b = nextAction(CONFIG, { attempts: 2 }, { kind: "error", error: "flaky" }, now);
    if (b.action !== "reschedule") throw new Error("unreachable");
    expect(b.runAtMs).toBe(now + CONFIG.backoffBaseMs * 2); // 2^1
  });

  it("parks (poison-pill) once attempts reach maxAttempts", () => {
    const a = nextAction(CONFIG, { attempts: 3 }, { kind: "error", error: "still broken" }, now);
    expect(a.action).toBe("park");
  });
});
