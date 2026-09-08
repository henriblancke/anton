/**
 * leaseDue exclusion (rolling-dispatch double-lease guard): a job already dispatched in-process is
 * kept in the runner's `inFlight` set and passed as `exclude`, so even if its lease lapses (a missed
 * renewal from laptop sleep or a transient DB hiccup) a spare-capacity tick won't lease it a second
 * time and run two handlers against the same worktree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { cancelJob, leaseDue, systemClock } from "./queue";
import { insertProject } from "@/lib/testing/project";

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
  it("does not lease a queued row that was cancelled before the lease transition", async () => {
    const due = new Date(systemClock.now() - 1_000);
    t.db
      .insert(schema.jobs)
      .values({ id: "cancelled", type: "execute-epic", status: "queued", runAt: due })
      .run();
    expect(await cancelJob(t.db, systemClock, "cancelled")).toBe(true);

    expect(await leaseDue(t.db, systemClock, { leaseMs: 30_000, limit: 5 })).toEqual([]);
    expect(t.db.select().from(schema.jobs).all()[0].status).toBe("cancelled");
  });

  it("returns no job when cancellation wins after candidate selection", async () => {
    const due = new Date(systemClock.now() - 1_000);
    t.db
      .insert(schema.jobs)
      .values({ id: "raced", type: "execute-epic", status: "queued", runAt: due })
      .run();
    // Simulate cancellation in the exact window between leaseDue's candidate SELECT and guarded
    // UPDATE. The trigger makes the competing transition win and skips the stale lease write.
    t.sqlite.exec(`
      CREATE TRIGGER cancel_before_lease
      BEFORE UPDATE OF status ON jobs
      WHEN OLD.id = 'raced' AND NEW.status = 'running'
      BEGIN
        UPDATE jobs SET status = 'cancelled' WHERE id = OLD.id;
        SELECT RAISE(IGNORE);
      END;
    `);

    expect(await leaseDue(t.db, systemClock, { leaseMs: 30_000, limit: 5 })).toEqual([]);
    expect(t.db.select().from(schema.jobs).all()[0].status).toBe("cancelled");
  });

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

  it("counts an excluded lease-lapsed in-flight job toward its project cap", async () => {
    // "busy": still dispatched in-process for project P, but its DB lease lapsed (missed heartbeat)
    // so it looks reclaimable. "queued": a second execute-epic queued for the SAME project.
    insertProject(t.db, { id: "P", slug: "P", name: "P", repoPath: "/tmp/P" });
    const past = new Date(systemClock.now() - 100_000);
    t.db
      .insert(schema.jobs)
      .values({
        id: "busy",
        type: "execute-epic",
        projectId: "P",
        status: "running",
        runAt: past,
        leaseExpiresAt: past, // expired → would count as reclaimable, but it's still in-flight
        attempts: 1,
      })
      .run();
    const soon = new Date(systemClock.now() - 1_000);
    t.db
      .insert(schema.jobs)
      .values({
        id: "queued",
        type: "execute-epic",
        projectId: "P",
        status: "queued",
        runAt: soon,
        attempts: 0,
      })
      .run();

    // Per-project cap of 1. The excluded in-flight job occupies P's only slot, so the queued job for
    // P must NOT be leased — otherwise two handlers run for project P at once.
    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 5,
      capOf: () => 1,
      exclude: ["busy"],
    });
    expect(leased).toHaveLength(0);
  });
});

/**
 * Cap-saturation pagination (PR #250 review): the scan window is finite (max(limit*8, 200)), and a
 * cap only skips a candidate — it does not remove it from the window. A backlog of capped rows wider
 * than the window therefore used to leave every later job unreachable, however many free slots the
 * runner had for it. The scan now excludes a saturated type/bucket from the next page and reads on.
 */
describe("leaseDue paginates past saturated caps", () => {
  const WINDOW = 200;

  function seedBacklog(type: "review-fix-pr" | "execute-epic", projectId: string, count: number) {
    const backlogAt = new Date(systemClock.now() - 10_000);
    t.db
      .insert(schema.jobs)
      .values(
        Array.from({ length: count }, (_, i) => ({
          id: `${type}-${projectId}-${i}`,
          type,
          projectId,
          status: "queued" as const,
          runAt: backlogAt,
          attempts: 0,
        })),
      )
      .run();
  }

  /** A `running` job with a live lease — real load against the caps. */
  function seedLive(id: string, type: "review-fix-pr" | "execute-epic", projectId: string) {
    t.db
      .insert(schema.jobs)
      .values({
        id,
        type,
        projectId,
        status: "running",
        runAt: new Date(systemClock.now() - 100_000),
        leaseExpiresAt: new Date(systemClock.now() + 100_000),
        attempts: 1,
      })
      .run();
  }

  /** The one job of another type/project, due AFTER the whole backlog. */
  function seedLeasable(type: "review-fix-pr" | "execute-epic", projectId: string) {
    t.db
      .insert(schema.jobs)
      .values({
        id: "leasable",
        type,
        projectId,
        status: "queued",
        runAt: new Date(systemClock.now() - 1_000),
        attempts: 0,
      })
      .run();
  }

  beforeEach(() => {
    for (const id of ["A", "B"]) {
      insertProject(t.db, { id, slug: id, name: id, repoPath: `/tmp/${id}` });
    }
  });

  it("reaches an execute-epic queued behind a window of type-capped review-fix-pr jobs", async () => {
    seedLive("busy", "review-fix-pr", "A"); // the runner-wide review-fix ceiling of 1 is full
    seedBacklog("review-fix-pr", "A", WINDOW + 50);
    seedLeasable("execute-epic", "B");

    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 2,
      typeCapOf: (job) => (job.type === "review-fix-pr" ? 1 : Infinity),
    });
    expect(leased.map((j) => j.id)).toEqual(["leasable"]);
    // The capped backlog is untouched — skipped, not consumed.
    const backlog = t.db.select().from(schema.jobs).all().filter((j) => j.id.startsWith("review-fix-pr-"));
    expect(backlog.every((j) => j.status === "queued")).toBe(true);
  });

  it("reaches another project's job queued behind a window of bucket-capped jobs", async () => {
    seedLive("busy", "execute-epic", "A"); // A's per-project cap of 1 is full
    seedBacklog("execute-epic", "A", WINDOW + 50);
    seedLeasable("execute-epic", "B");

    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 2,
      capOf: (job) => (job.type === "execute-epic" ? 1 : Infinity),
    });
    expect(leased.map((j) => j.id)).toEqual(["leasable"]);
  });

  it("stops paging once the limit is met, without touching the rest of the backlog", async () => {
    seedBacklog("review-fix-pr", "A", WINDOW + 50); // nothing running: the type is under its cap
    seedLeasable("execute-epic", "B");

    const leased = await leaseDue(t.db, systemClock, {
      leaseMs: 30_000,
      limit: 2,
      typeCapOf: (job) => (job.type === "review-fix-pr" ? 2 : Infinity),
    });
    // Two fixes fill the type cap inside the first page; the limit is met there, so "leasable"
    // (due later) correctly waits for the next tick.
    expect(leased).toHaveLength(2);
    expect(leased.every((j) => j.type === "review-fix-pr")).toBe(true);
  });
});

