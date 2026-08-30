/**
 * Tests for the escalation store (anton-wvcy) against a real migrated anton.db.
 *
 * Two invariants carry the feature and are tested here rather than inferred from the sweep:
 *   • RAISE IS IDEMPOTENT — one open row per (project, finding), so an hourly sweep over an
 *     unchanged stall yields one board item instead of a growing pile the founder learns to ignore.
 *   • SETTLE IS A COMPARE-AND-SWAP — only the first `open → resolved` wins, which is what stops a
 *     double-click (or two operators on one board) from resuming the same epic twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import {
  getEscalation,
  listOpenEscalations,
  markEscalationNoted,
  raiseEscalation,
  settleEscalation,
  toEscalationView,
} from "./escalations";
import type { RunHealthFinding } from "./run-health";
import type { Clock } from "./jobs/queue";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const clock: Clock = { now: () => NOW };

let t: TestDb;

beforeEach(() => {
  t = makeTestDb();
  for (const id of ["p1", "p2"]) {
    t.db.insert(schema.projects).values({ id, slug: id, name: id, repoPath: `/tmp/${id}` }).run();
  }
});
afterEach(() => t.close());

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "parked 4h ago: agent exited 1",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId: "r-1",
    beadId: "t-9",
    ...o,
  };
}

const raise = (o: { projectId?: string; finding?: RunHealthFinding; epicBeadId?: string } = {}) =>
  raiseEscalation(t.db, clock, {
    projectId: o.projectId ?? "p1",
    finding: o.finding ?? finding(),
    epicBeadId: "epicBeadId" in o ? o.epicBeadId : "e-1",
  });

describe("raiseEscalation", () => {
  it("stores the finding's evidence, target and decision state", async () => {
    const { escalation, created } = await raise();

    expect(created).toBe(true);
    expect(escalation).toMatchObject({
      projectId: "p1",
      findingKey: "parked-run:r-1",
      kind: "parked-run",
      reason: "parked 4h ago: agent exited 1",
      beadId: "t-9",
      epicBeadId: "e-1",
      runId: "r-1",
      status: "open",
      resolution: null,
      notedAt: null,
    });
    expect(JSON.parse(escalation.evidenceJson)).toEqual(finding());
  });

  it("returns the open row and inserts nothing when the same finding is raised again", async () => {
    const first = await raise();
    const again = await raise({ finding: finding({ reason: "parked 9h ago: agent exited 1" }) });

    expect(again.created).toBe(false);
    expect(again.escalation.id).toBe(first.escalation.id);
    // The reason is NOT refreshed: the row records what was escalated, and rewriting it would make
    // "resolved" ambiguous about which claim the founder actually answered.
    expect(again.escalation.reason).toBe("parked 4h ago: agent exited 1");
    expect(t.db.select().from(schema.escalations).all()).toHaveLength(1);
  });

  it("keeps findings and projects independent", async () => {
    const a = await raise();
    const b = await raise({ finding: finding({ key: "parked-run:r-2" }) });
    const c = await raise({ projectId: "p2" });

    expect(new Set([a, b, c].map((r) => r.escalation.id)).size).toBe(3);
  });

  it("raises again once the prior escalation is resolved — a recurrence is new news", async () => {
    const first = await raise();
    await settleEscalation(t.db, clock, first.escalation.id, "abandoned");

    const second = await raise();
    expect(second.created).toBe(true);
    expect(second.escalation.id).not.toBe(first.escalation.id);
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(1);
  });

  it("tolerates a finding that names no bead at all", async () => {
    const { escalation } = await raise({
      finding: finding({ key: "exhausted-job:j-1", kind: "exhausted-job", beadId: undefined }),
      epicBeadId: undefined,
    });
    expect(escalation.beadId).toBeNull();
    expect(toEscalationView(escalation).beadId).toBeUndefined();
  });
});

describe("escalations_open_unique (DB backstop)", () => {
  it("rejects a second OPEN row for the same (project, finding)", async () => {
    await raise();
    expect(() =>
      t.db
        .insert(schema.escalations)
        .values({
          id: "dup",
          projectId: "p1",
          findingKey: "parked-run:r-1",
          kind: "parked-run",
          reason: "dup",
          evidenceJson: "{}",
          status: "open",
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("permits a resolved duplicate, so history is kept rather than overwritten", async () => {
    const { escalation } = await raise();
    await settleEscalation(t.db, clock, escalation.id, "resumed");
    await raise();
    expect(t.db.select().from(schema.escalations).all()).toHaveLength(2);
  });
});

describe("settleEscalation", () => {
  it("records the founder's answer and closes the item", async () => {
    const { escalation } = await raise();

    expect(await settleEscalation(t.db, clock, escalation.id, "resumed")).toBe(true);
    const row = t.db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id))
      .get();
    expect(row).toMatchObject({ status: "resolved", resolution: "resumed" });
    expect(await listOpenEscalations(t.db, "p1")).toEqual([]);
  });

  it("lets only the first settle win — the second reports false and changes nothing", async () => {
    // This is the guard that makes a double-clicked Resume enqueue one job, not two.
    const { escalation } = await raise();

    expect(await settleEscalation(t.db, clock, escalation.id, "resumed")).toBe(true);
    expect(await settleEscalation(t.db, clock, escalation.id, "abandoned")).toBe(false);
    const row = t.db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id))
      .get();
    expect(row?.resolution).toBe("resumed");
  });

  it("reports false for an unknown id rather than throwing", async () => {
    expect(await settleEscalation(t.db, clock, "nope", "resumed")).toBe(false);
  });
});

describe("reads", () => {
  it("lists only this project's open escalations, newest stall first", async () => {
    const older = await raise({ finding: finding({ key: "parked-run:old" }) });
    t.db
      .update(schema.escalations)
      .set({ raisedAt: new Date(NOW - 6 * HOUR) })
      .where(eq(schema.escalations.id, older.escalation.id))
      .run();
    const newer = await raise({ finding: finding({ key: "parked-run:new" }) });
    const settled = await raise({ finding: finding({ key: "parked-run:done" }) });
    await settleEscalation(t.db, clock, settled.escalation.id, "abandoned");
    await raise({ projectId: "p2" });

    const rows = await listOpenEscalations(t.db, "p1");
    expect(rows.map((r) => r.id)).toEqual([newer.escalation.id, older.escalation.id]);
  });

  it("scopes a single read to its project, so a route can't settle another project's item", async () => {
    const { escalation } = await raise();
    expect(await getEscalation(t.db, "p1", escalation.id)).toBeDefined();
    expect(await getEscalation(t.db, "p2", escalation.id)).toBeUndefined();
  });
});

describe("markEscalationNoted", () => {
  it("stamps the bd note so later sweeps stop retrying it", async () => {
    const { escalation } = await raise();
    expect(toEscalationView(escalation).noted).toBe(false);

    await markEscalationNoted(t.db, clock, escalation.id);
    const row = await getEscalation(t.db, "p1", escalation.id);
    expect(toEscalationView(row!).noted).toBe(true);
  });
});

describe("toEscalationView", () => {
  it("surfaces the PR evidence the panel links to", async () => {
    const { escalation } = await raise({
      finding: finding({
        kind: "stale-pr",
        key: "stale-pr:e-1:42",
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
      }),
    });
    expect(toEscalationView(escalation)).toMatchObject({
      kind: "stale-pr",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
      ageMs: 4 * HOUR,
      since: Math.floor((NOW - 4 * HOUR) / 1000),
      status: "open",
    });
  });

  it("surfaces the gate a wait on a person hangs on — the bead resolve-and-resume closes", async () => {
    // The gate has no column of its own, so this blob IS the link between the detector that found
    // the wait and the verb that ends it (escalation-actions.ts).
    const { escalation } = await raise({
      finding: finding({
        kind: "needs-human",
        key: "needs-human:g-1",
        gateId: "g-1",
        beadId: "t-1",
        targetBeadId: "e-1",
      }),
    });
    expect(toEscalationView(escalation)).toMatchObject({ kind: "needs-human", gateId: "g-1" });
  });

  it("stays actionable when the evidence blob is corrupt", async () => {
    // The row's own columns carry the reason, target and stall time, so a bad blob costs the extra
    // evidence — never the escalation itself.
    const { escalation } = await raise();
    t.db
      .update(schema.escalations)
      .set({ evidenceJson: "{not json" })
      .where(eq(schema.escalations.id, escalation.id))
      .run();

    const view = toEscalationView((await getEscalation(t.db, "p1", escalation.id))!);
    expect(view).toMatchObject({ reason: "parked 4h ago: agent exited 1", epicBeadId: "e-1" });
    expect(view.ageMs).toBe(0);
    expect(view.prNumber).toBeUndefined();
  });
});
