/**
 * leaseDue exclusion (rolling-dispatch double-lease guard): a job already dispatched in-process is
 * kept in the runner's `inFlight` set and passed as `exclude`, so even if its lease lapses (a missed
 * renewal from laptop sleep or a transient DB hiccup) a spare-capacity tick won't lease it a second
 * time and run two handlers against the same worktree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { leaseDue, systemClock } from "./queue";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

/** Insert a `running` job whose lease already expired — i.e. it looks reclaimable to leaseDue. */
function seedReclaimable(id: string) {
  const past = new Date(systemClock.now() - 100_000);
  t.db
    .insert(schema.jobs)
    .values({
      id,
      type: "execute-epic",
      status: "running",
      runAt: past,
      leaseExpiresAt: past, // expired → reclaimable
      attempts: 1,
    })
    .run();
}

describe("leaseDue exclude", () => {
  it("reclaims a lease-expired running job by default", async () => {
    seedReclaimable("j1");
    const leased = await leaseDue(t.db, systemClock, { leaseMs: 30_000, limit: 5 });
    expect(leased.map((j) => j.id)).toEqual(["j1"]);
  });

  it("does NOT re-lease a job listed in exclude (still dispatched in-process)", async () => {
    seedReclaimable("j1");
    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 5,
      exclude: ["j1"],
    });
    expect(leased).toHaveLength(0);
    // Left untouched — its lease/attempts aren't bumped by the skipped lease.
    const row = t.db.select().from(schema.jobs).all()[0];
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("running");
  });

  it("leases other due jobs while excluding the in-flight one", async () => {
    seedReclaimable("busy");
    const soon = new Date(systemClock.now() - 1_000);
    t.db
      .insert(schema.jobs)
      .values({ id: "fresh", type: "execute-epic", status: "queued", runAt: soon, attempts: 0 })
      .run();

    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 5,
      exclude: ["busy"],
    });
    expect(leased.map((j) => j.id)).toEqual(["fresh"]);
  });
});
