/**
 * The watermark store (anton-z8j4q), against a real in-memory anton.db.
 *
 * One property carries the feature and cannot be proven by reading the code: the mark only ever
 * moves FORWARD. Everything downstream — the since-you-looked window, the digest, notifications —
 * reads this value as "already seen", so a mark that could be walked back would resurface work the
 * operator had read, which is the exact noise the feature exists to remove. The cases below go
 * through the real upsert rather than a stub, because the guard lives in that statement's `WHERE`:
 * a test that compared in TypeScript would pass while the SQL did nothing.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import { DEFAULT_VIEWER_ID, getViewerMark, markSeen } from "./viewer-marks";

let tdb: TestDb;

/** Epoch ms the fixtures stamp writes with — fixed so `updatedAt` is assertable, not racy. */
const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

const MORNING = 1_799_900_000;
const AFTERNOON = 1_799_990_000;

beforeEach(async () => {
  tdb = makeTestDb();
  await tdb.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
});

afterEach(() => tdb.close());

describe("markSeen", () => {
  it("records the first mark under the default viewer", async () => {
    const { mark, moved } = await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING });

    expect(moved).toBe(true);
    expect(mark).toEqual({
      viewerId: DEFAULT_VIEWER_ID,
      seenAt: MORNING,
      updatedAt: Math.floor(NOW / 1000),
    });
    expect(await getViewerMark(tdb.db, "p1")).toEqual(mark);
  });

  it("moves the mark forward", async () => {
    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING });
    const { mark, moved } = await markSeen(tdb.db, clock, { projectId: "p1", seenAt: AFTERNOON });

    expect(moved).toBe(true);
    expect(mark.seenAt).toBe(AFTERNOON);
    expect((await getViewerMark(tdb.db, "p1"))?.seenAt).toBe(AFTERNOON);
  });

  // The stale-tab case, and the reason the guard is in the SQL: a board left open since the morning
  // posts the watermark it loaded with, which must not un-see the afternoon.
  it("leaves an earlier mark alone and reports the stored one", async () => {
    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: AFTERNOON });

    const { mark, moved } = await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING });

    expect(moved).toBe(false);
    expect(mark.seenAt).toBe(AFTERNOON);
    expect((await getViewerMark(tdb.db, "p1"))?.seenAt).toBe(AFTERNOON);
  });

  // Re-posting the same instant is the double-click / re-render case. Idempotent, and `moved: false`
  // tells a caller that someone else's mark already covered it.
  it("treats re-posting the same instant as a no-op", async () => {
    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: AFTERNOON });
    const { mark, moved } = await markSeen(tdb.db, clock, { projectId: "p1", seenAt: AFTERNOON });

    expect(moved).toBe(false);
    expect(mark.seenAt).toBe(AFTERNOON);
  });

  // The refused update must not touch `updatedAt` either: "when you last looked" is read off that
  // column, and bumping it on a no-op would report a look that did not happen.
  it("does not restamp updatedAt when the mark does not move", async () => {
    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: AFTERNOON });
    const later = { now: () => NOW + 60_000 };

    const { mark } = await markSeen(tdb.db, later, { projectId: "p1", seenAt: MORNING });

    expect(mark.updatedAt).toBe(Math.floor(NOW / 1000));
  });

  it("keeps one mark per viewer per project", async () => {
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p2", slug: "other", name: "other", repoPath: "/tmp/p2" });

    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING });
    await markSeen(tdb.db, clock, { projectId: "p2", seenAt: AFTERNOON });
    await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING, viewerId: "someone-else" });

    expect((await getViewerMark(tdb.db, "p1"))?.seenAt).toBe(MORNING);
    expect((await getViewerMark(tdb.db, "p2"))?.seenAt).toBe(AFTERNOON);
    expect((await getViewerMark(tdb.db, "p1", "someone-else"))?.seenAt).toBe(MORNING);
    expect(await tdb.db.select().from(schema.viewerMarks)).toHaveLength(3);
  });

  // A project with no row has never been looked at, which is a different answer from epoch 0 and is
  // what every project predating this table reads as.
  it("reports no mark for a viewer who has never looked", async () => {
    expect(await getViewerMark(tdb.db, "p1")).toBeUndefined();
  });

  // Whole seconds, matching the column: a fractional mark stored as-is would compare inconsistently
  // against the integer the guard reads.
  it("floors a fractional instant to whole seconds", async () => {
    const { mark } = await markSeen(tdb.db, clock, { projectId: "p1", seenAt: MORNING + 0.9 });
    expect(mark.seenAt).toBe(MORNING);
  });
});
