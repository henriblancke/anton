/**
 * anton-qbz.2/.3: the run-detail view's pure decisions — which session the terminal attaches to,
 * timeline ordering, active-run detection, and duration formatting.
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVE_RUN_STATUSES,
  fmtDuration,
  isActiveRun,
  pickAttachSession,
  timelineOrder,
  type SessionSummary,
} from "./run-view-utils";

// Newest-first, as listSessions returns.
const sessions: SessionSummary[] = [
  { id: "s3", kind: "review-fix", status: "running", startedAt: 300 },
  { id: "s2", kind: "execute", status: "done", startedAt: 200, endedAt: 260 },
  { id: "s1", kind: "execute", status: "failed", startedAt: 100, endedAt: 150 },
];

describe("pickAttachSession", () => {
  it("returns null when there are no sessions", () => {
    expect(pickAttachSession([], null)).toBeNull();
  });

  it("prefers the running session when nothing is explicitly selected", () => {
    expect(pickAttachSession(sessions, null)).toBe("s3");
  });

  it("falls back to the most recent (newest-first [0]) when none is running", () => {
    const finished = sessions.filter((s) => s.status !== "running");
    expect(pickAttachSession(finished, null)).toBe("s2");
  });

  it("honors an explicit selection that still exists", () => {
    expect(pickAttachSession(sessions, "s1")).toBe("s1");
  });

  it("ignores a stale selection and re-derives", () => {
    expect(pickAttachSession(sessions, "gone")).toBe("s3");
  });
});

describe("timelineOrder", () => {
  it("orders oldest-first without mutating the input", () => {
    const input = [...sessions];
    const ordered = timelineOrder(input);
    expect(ordered.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(input.map((s) => s.id)).toEqual(["s3", "s2", "s1"]); // unchanged
  });
});

describe("isActiveRun", () => {
  it("treats queued/running/parked as active", () => {
    for (const s of ACTIVE_RUN_STATUSES) expect(isActiveRun(s)).toBe(true);
  });
  it("treats done/failed as inactive", () => {
    expect(isActiveRun("done")).toBe(false);
    expect(isActiveRun("failed")).toBe(false);
  });
});

describe("fmtDuration", () => {
  it("renders seconds, minutes, and hours", () => {
    expect(fmtDuration(100, 130)).toBe("30s");
    expect(fmtDuration(100, 100 + 90)).toBe("1m 30s");
    expect(fmtDuration(0, 3661)).toBe("1h 1m");
  });
  it("counts up to a fixed now when the session is still open", () => {
    // from=100s, now=160_000ms → 60s elapsed.
    expect(fmtDuration(100, undefined, 160_000)).toBe("1m 0s");
  });
  it("returns a dash without a start", () => {
    expect(fmtDuration(undefined)).toBe("—");
  });
});
