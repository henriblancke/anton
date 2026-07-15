/**
 * Pure-mapper tests for the jobs view (anton-ner.3): row→summary field extraction, epicBeadId
 * pulled from the JSON payload (tolerating malformed/absent payloads), timestamp normalization,
 * and the active/terminal split that groups parked/failed jobs for audit.
 */
import { describe, expect, it } from "vitest";
import { isActiveJob, toJobSummary } from "./jobs-view";
import type { schema } from "./db";

type JobRow = (typeof schema.jobs)["$inferSelect"];

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "j1",
    type: "review-fix",
    projectId: "p1",
    payloadJson: "{}",
    status: "done",
    runAt: new Date(1_000_000_000_000),
    leaseExpiresAt: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(1_000_000_000_000),
    updatedAt: new Date(1_000_000_060_000),
    ...overrides,
  } as JobRow;
}

describe("toJobSummary", () => {
  it("maps core fields and normalizes Date timestamps to epoch seconds", () => {
    const s = toJobSummary(row({ attempts: 3 }));
    expect(s).toMatchObject({
      id: "j1",
      type: "review-fix",
      status: "done",
      projectId: "p1",
      attempts: 3,
      createdAt: 1_000_000_000,
      updatedAt: 1_000_000_060,
    });
    expect(s.epicBeadId).toBeUndefined();
    expect(s.lastError).toBeUndefined();
  });

  it("extracts epicBeadId from the JSON payload", () => {
    const s = toJobSummary(row({ payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "anton-abc" }) }));
    expect(s.epicBeadId).toBe("anton-abc");
  });

  it("extracts scheduleId from a cron-enqueued payload (nightly-stringer etc.)", () => {
    const s = toJobSummary(row({ payloadJson: JSON.stringify({ projectId: "p1", scheduleId: "sched-9" }) }));
    expect(s.scheduleId).toBe("sched-9");
    expect(s.epicBeadId).toBeUndefined();
  });

  it("tolerates malformed or epic-less payloads without throwing", () => {
    expect(toJobSummary(row({ payloadJson: "not json" })).epicBeadId).toBeUndefined();
    expect(toJobSummary(row({ payloadJson: null as unknown as string })).epicBeadId).toBeUndefined();
    expect(toJobSummary(row({ payloadJson: JSON.stringify({ epicBeadId: 42 }) })).epicBeadId).toBeUndefined();
  });

  it("surfaces lastError for parked/failed jobs", () => {
    const s = toJobSummary(row({ status: "parked", lastError: "quota exhausted" }));
    expect(s.lastError).toBe("quota exhausted");
  });
});

describe("isActiveJob", () => {
  it("treats queued/running/parked as active and done/failed as terminal", () => {
    expect(isActiveJob("queued")).toBe(true);
    expect(isActiveJob("running")).toBe(true);
    expect(isActiveJob("parked")).toBe(true);
    expect(isActiveJob("done")).toBe(false);
    expect(isActiveJob("failed")).toBe(false);
  });
});
