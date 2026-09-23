/**
 * The feature ledger's timing half (anton-96ga0), tested where it can lie.
 *
 * The claims under test are honesty claims rather than arithmetic ones: active counts an invocation
 * once no matter how many models it reported, lead spans the parks that active deliberately does
 * not, an undelivered scope has no lead rather than a zero one, and NO wall time exists to be
 * rendered — the last of those is a compile-time assertion, because a runtime one cannot fail if
 * the field is never added.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  activeMs,
  firstInvocationStartMs,
  lastDeliveryMs,
  ledgerTiming,
  waitingMs,
  type LedgerTiming,
  type LedgerTimingRow,
} from "./feature-ledger";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** An invocation's rows share every dimension but the model — the grain the fold must respect. */
function row(overrides: Partial<LedgerTimingRow> = {}): LedgerTimingRow {
  return {
    invocationId: "inv-1",
    projectId: "p1",
    jobType: "execute-epic",
    jobId: "j1",
    step: "implement",
    runId: "r1",
    beadId: "anton-aaa",
    claudeSessionId: "s1",
    modelRequested: "claude-opus-5",
    modelReported: "claude-opus-5",
    endpointHost: null,
    outcome: "ok",
    recordedAt: new Date("2026-09-20T09:00:00Z"),
    durationMs: 10 * MINUTE,
    ...overrides,
  };
}

describe("activeMs", () => {
  it("sums each invocation's duration", () => {
    const rows = [
      row({ invocationId: "inv-1", durationMs: 4 * MINUTE }),
      row({ invocationId: "inv-2", durationMs: 6 * MINUTE }),
      row({ invocationId: "inv-3", durationMs: 90_000 }),
    ];
    expect(activeMs(rows)).toBe(11 * MINUTE + 30_000);
  });

  it("counts an invocation ONCE however many models it reported usage under", () => {
    // The fact table's grain is (invocation, model) and `duration_ms` is copied onto every row of
    // one invocation, so a per-row sum would double-count the haiku sidecar that rides along with
    // essentially every real opus invocation.
    const sidecar = [
      row({ invocationId: "inv-1", modelReported: "claude-opus-5", durationMs: 8 * MINUTE }),
      row({ invocationId: "inv-1", modelReported: "claude-haiku-4-5", durationMs: 8 * MINUTE }),
    ];
    expect(activeMs(sidecar)).toBe(8 * MINUTE);
  });

  it("treats an unreported duration as nothing, not as a hole in the sum", () => {
    const rows = [
      row({ invocationId: "inv-1", durationMs: 5 * MINUTE }),
      row({ invocationId: "inv-2", durationMs: null }),
    ];
    expect(activeMs(rows)).toBe(5 * MINUTE);
  });

  it("is zero on no rows at all", () => {
    expect(activeMs([])).toBe(0);
  });
});

describe("ledgerTiming on a run that parked overnight", () => {
  // 09:00 — 10min of implement work. Quota park. 07:00 next morning — 5min to finish, delivered at
  // 07:10. Active is 15 minutes; lead is 22h10m. Both are correct, and neither is the other.
  const firstStart = Date.parse("2026-09-20T09:00:00Z");
  const rows = [
    row({
      invocationId: "inv-1",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 10 * MINUTE,
    }),
    row({
      invocationId: "inv-2",
      step: "review",
      recordedAt: new Date("2026-09-21T07:05:00Z"),
      durationMs: 5 * MINUTE,
    }),
  ];
  const deliveredAt = Date.parse("2026-09-21T07:10:00Z");

  it("reports a small active and a large lead, both correct", () => {
    const timing = ledgerTiming(rows, deliveredAt);
    expect(timing.activeMs).toBe(15 * MINUTE);
    expect(timing.leadMs).toBe(deliveredAt - firstStart);
    expect(timing.leadMs).toBe(22 * HOUR + 10 * MINUTE);
  });

  it("separates working from waiting — the figure the split exists for", () => {
    // The overnight park itself: everything in the lead that was not work.
    expect(waitingMs(ledgerTiming(rows, deliveredAt))).toBe(21 * HOUR + 55 * MINUTE);
  });

  it("starts the lead when the first invocation BEGAN, not when it was recorded", () => {
    // `recorded_at` is stamped as an invocation ENDS, so reading it as the origin would drop the
    // first invocation's own work out of the span — and make lead − active negative on a
    // single-invocation feature.
    expect(firstInvocationStartMs(rows)).toBe(firstStart);
  });
});

describe("firstInvocationStartMs with an unmeasured invocation", () => {
  it("excludes an invocation with no reported duration, even when it is temporally first", () => {
    // inv-1 crashed before reporting a duration (durationMs: null, the shape
    // claude-invocations.ts writes whenever a result never reports one). Reconstructing its start
    // from `recordedAt - 0` would collapse the start to inv-1's own end time and understate lead.
    // The genuinely reconstructable start is inv-2's, even though inv-2 ended later.
    const rows = [
      row({
        invocationId: "inv-1",
        recordedAt: new Date("2026-09-20T09:10:00Z"),
        durationMs: null,
      }),
      row({
        invocationId: "inv-2",
        recordedAt: new Date("2026-09-20T09:20:00Z"),
        durationMs: 5 * MINUTE,
      }),
    ];
    expect(firstInvocationStartMs(rows)).toBe(Date.parse("2026-09-20T09:15:00Z"));
  });

  it("is undefined when no invocation in scope has a known duration", () => {
    const rows = [
      row({ invocationId: "inv-1", durationMs: null }),
      row({ invocationId: "inv-2", durationMs: null }),
    ];
    expect(firstInvocationStartMs(rows)).toBeUndefined();
    expect(ledgerTiming(rows, Date.parse("2026-09-21T07:10:00Z")).leadMs).toBeUndefined();
  });
});

describe("leadMs", () => {
  it("is absent, not zero, for a scope that has not delivered", () => {
    expect(ledgerTiming([row()]).leadMs).toBeUndefined();
    expect(waitingMs(ledgerTiming([row()]))).toBeUndefined();
  });

  it("is absent for a scope with no invocations recorded, even when a delivery exists", () => {
    expect(ledgerTiming([], Date.parse("2026-09-21T07:10:00Z")).leadMs).toBeUndefined();
  });

  it("refuses a negative span rather than clamping it to zero", () => {
    // A bead reparented into a scope it did not deliver under: the delivery predates every row here,
    // so there is no honest span between the two.
    const delivered = Date.parse("2026-09-19T00:00:00Z");
    expect(ledgerTiming([row()], delivered).leadMs).toBeUndefined();
  });

  it("spans to the LAST delivery across the feature and its children", () => {
    const deliveries = new Map([
      ["anton-aaa", [Date.parse("2026-09-20T10:00:00Z") / 1000]],
      ["anton-bbb", [Date.parse("2026-09-21T07:10:00Z") / 1000]],
    ]);
    const last = lastDeliveryMs(deliveries, ["anton-aaa", "anton-bbb"]);
    expect(last).toBe(Date.parse("2026-09-21T07:10:00Z"));
    // A bead outside the scope contributes nothing, and an unknown bead is not an error.
    expect(lastDeliveryMs(deliveries, ["anton-zzz"])).toBeUndefined();
    expect(lastDeliveryMs(new Map(), ["anton-aaa"])).toBeUndefined();
  });
});

describe("measurement completeness", () => {
  it("says how many invocations actually reported a duration", () => {
    const timing = ledgerTiming([
      row({ invocationId: "inv-1", durationMs: 5 * MINUTE }),
      row({ invocationId: "inv-2", durationMs: null }),
    ]);
    // Below `invocations`, the active figure is a floor rather than a total — the caller can say so
    // instead of letting a partly-measured span read as complete.
    expect(timing.invocations).toBe(2);
    expect(timing.timedInvocations).toBe(1);
  });

  it("distinguishes nothing recorded from zero recorded", () => {
    expect(ledgerTiming([]).invocations).toBe(0);
    expect(ledgerTiming([row({ durationMs: 0 })]).invocations).toBe(1);
  });
});

describe("wall time", () => {
  /**
   * The acceptance criterion that only a type can enforce: `attemptStartedAt` is rewritten on every
   * resume, so any wall figure derived today is the LAST attempt's duration wearing wall time's
   * name. The field does not exist, so no caller can render a wrong number — and this assertion
   * fails the typecheck the moment someone adds one back without a per-attempt record.
   */
  it("is carried by no field on the timing type", () => {
    expectTypeOf<LedgerTiming>().not.toHaveProperty("wallMs");
    expectTypeOf<LedgerTiming>().not.toHaveProperty("lastAttemptMs");
    expectTypeOf<LedgerTiming>().toEqualTypeOf<{
      activeMs: number;
      invocations: number;
      timedInvocations: number;
      leadMs: number | undefined;
    }>();
    expect(Object.keys(ledgerTiming([row()])).sort()).toEqual([
      "activeMs",
      "invocations",
      "leadMs",
      "timedInvocations",
    ]);
  });
});
