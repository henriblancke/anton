/**
 * The unwatched-park signal (anton-kh98). Two halves, tested apart:
 *   • the pure computation, whose whole contract is WHEN it says nothing — a band that appeared on
 *     a watched or empty queue would be an always-on ornament; and
 *   • the read, which decides "armed" from schedule rows that may not exist at all. That last case
 *     is the shipped default this ticket is about: run-health is opt-in, and a project predating a
 *     schedule type has no row for it, so a read that took absence for "on" would stay silent on
 *     exactly the installs with parked work nobody is watching.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import {
  disarmedWatchers,
  projectUnwatchedParks,
  unwatchedParks,
  type WatcherAutomation,
} from "./unwatched-parks";
import type { Clock } from "./jobs/queue";

const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };
const HOUR = 3_600_000;
/** Unix SECONDS, the unit every park time is stored and passed in. */
const secondsAgo = (ms: number) => Math.floor((NOW - ms) / 1000);

const BOTH: WatcherAutomation[] = ["run-health", "unstick"];

describe("unwatchedParks", () => {
  it("counts the parked jobs and ages the oldest of them", () => {
    expect(
      unwatchedParks({
        parkedAt: [secondsAgo(2 * HOUR), secondsAgo(7 * 24 * HOUR), secondsAgo(30 * HOUR)],
        disarmed: ["run-health"],
        nowMs: NOW,
      }),
    ).toEqual({
      parkedCount: 3,
      oldestSince: secondsAgo(7 * 24 * HOUR),
      oldestAgeMs: 7 * 24 * HOUR,
      disarmed: ["run-health"],
    });
  });

  // The band's silence is the feature: with the watcher armed a park becomes an escalation on the
  // next sweep, and that row — not this band — is where it belongs.
  it("says nothing when the watcher is armed, however much is parked", () => {
    expect(
      unwatchedParks({ parkedAt: [secondsAgo(9 * 24 * HOUR)], disarmed: [], nowMs: NOW }),
    ).toBeUndefined();
  });

  it("says nothing when nothing is parked, however disarmed the watcher is", () => {
    expect(unwatchedParks({ parkedAt: [], disarmed: BOTH, nowMs: NOW })).toBeUndefined();
  });

  // What is off decides the sentence the band prints, so the order has to be the loop's order
  // (detect, then act) rather than whatever order the caller's rows came back in.
  it("reports the disarmed halves in detect → act order", () => {
    const signal = unwatchedParks({
      parkedAt: [secondsAgo(HOUR)],
      disarmed: ["unstick", "run-health"],
      nowMs: NOW,
    });
    expect(signal?.disarmed).toEqual(["run-health", "unstick"]);
  });

  it("never ages a park negatively when its stamp runs ahead of the read", () => {
    const signal = unwatchedParks({
      parkedAt: [Math.floor(NOW / 1000) + 30],
      disarmed: BOTH,
      nowMs: NOW,
    });
    expect(signal?.oldestAgeMs).toBe(0);
  });
});

describe("the project read", () => {
  let tdb: TestDb;
  const projectId = "p1";

  async function park(id: string, ms: number) {
    await tdb.db.insert(schema.jobs).values({
      id,
      type: "execute-epic",
      projectId,
      status: "parked",
      updatedAt: new Date(NOW - ms),
    });
  }

  async function schedule(type: WatcherAutomation, enabled: boolean) {
    await tdb.db
      .insert(schema.schedules)
      .values({ id: `s-${type}`, projectId, type, cron: "0 * * * *", enabled });
  }

  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db
      .insert(schema.projects)
      .values({ id: projectId, slug: "p1", name: "p1", repoPath: "/tmp/p1" });
  });

  // The shipped default, and the bug: run-health has never been armed, so nothing detects and the
  // parked job waits with no signal anywhere.
  it("reports parked work when the project has no watcher schedules at all", async () => {
    await park("j-1", 7 * 24 * HOUR);
    await park("j-2", 3 * HOUR);

    expect(await projectUnwatchedParks(tdb.db, projectId, clock)).toEqual({
      parkedCount: 2,
      oldestSince: secondsAgo(7 * 24 * HOUR),
      oldestAgeMs: 7 * 24 * HOUR,
      disarmed: BOTH,
    });
  });

  it("still reports when the sweep is armed but nothing acts on what it finds", async () => {
    await schedule("run-health", true);
    await schedule("unstick", false);
    await park("j-1", 5 * HOUR);

    const signal = await projectUnwatchedParks(tdb.db, projectId, clock);
    expect(signal?.disarmed).toEqual(["unstick"]);
    expect(signal?.parkedCount).toBe(1);
  });

  it("goes quiet once the whole loop is armed", async () => {
    await schedule("run-health", true);
    await schedule("unstick", true);
    await park("j-1", 5 * HOUR);

    expect(await projectUnwatchedParks(tdb.db, projectId, clock)).toBeUndefined();
  });

  // A job that failed, ran, or finished is not work waiting on a human, and counting it would
  // inflate the one number the band is trusted for.
  it("counts parked jobs only, and only this project's", async () => {
    await park("j-1", 2 * HOUR);
    await tdb.db.insert(schema.jobs).values([
      { id: "j-2", type: "execute-epic", projectId, status: "done" },
      { id: "j-3", type: "execute-epic", projectId, status: "queued" },
      { id: "j-4", type: "execute-epic", projectId, status: "failed" },
      { id: "j-5", type: "execute-epic", projectId: null, status: "parked" },
    ]);

    expect((await projectUnwatchedParks(tdb.db, projectId, clock))?.parkedCount).toBe(1);
  });

  it("reads a missing schedule row as off, not as on", async () => {
    await schedule("unstick", true);
    expect(await disarmedWatchers(tdb.db, projectId)).toEqual(["run-health"]);
  });

  it("ignores another project's armed watcher", async () => {
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p2", slug: "p2", name: "p2", repoPath: "/tmp/p2" });
    await tdb.db.insert(schema.schedules).values([
      { id: "s-other-1", projectId: "p2", type: "run-health", cron: "0 * * * *", enabled: true },
      { id: "s-other-2", projectId: "p2", type: "unstick", cron: "0 * * * *", enabled: true },
    ]);

    expect(await disarmedWatchers(tdb.db, projectId)).toEqual(BOTH);
  });
});
