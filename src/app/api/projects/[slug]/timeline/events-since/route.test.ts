/**
 * The events-since window (anton-z8j4q) and the events it folds (anton-uxgze, anton-4ldxk), against
 * a real in-memory anton.db.
 *
 * The WINDOW cases that matter are the two ways a lower bound goes wrong — a viewer who has never
 * looked (whose window is all of history, not none of it) and an explicit `since` that must look
 * back WITHOUT disturbing the stored mark. The EVENTS case that matters is that the route actually
 * calls the per-source readers and `foldTimeline` over this window, rather than handing back a
 * window a caller has to assemble the timeline from itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "@/lib/beads/bd";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

let tdb: TestDb;
let board: Bead[] = [];

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
vi.mock("@/lib/beads/issues", () => ({ allIssues: async () => board }));

const { GET } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const get = (query = "") => new Request(`http://t/${query}`);

async function mark(seenAt: number): Promise<void> {
  await tdb.db
    .insert(schema.viewerMarks)
    .values({ viewerId: "default", projectId: "p1", seenAt: new Date(seenAt * 1000) });
}

beforeEach(async () => {
  tdb = makeTestDb();
  board = [];
  await tdb.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
});

describe("GET /timeline/events-since", () => {
  // Null, never `now`: a project that predates the watermark has read nothing, and a window
  // starting at the present would show such an operator an empty timeline.
  it("reports since: null when the viewer has never looked", async () => {
    const body = await (await GET(get(), ctx("tmp"))).json();

    expect(body.since).toBeNull();
    expect(body.mark).toBeNull();
    expect(body.viewerId).toBe("default");
    expect(body.until).toEqual(expect.any(Number));
  });

  it("starts the window at the stored mark", async () => {
    await mark(4000);

    const body = await (await GET(get(), ctx("tmp"))).json();

    expect(body.since).toBe(4000);
    expect(body.mark).toMatchObject({ viewerId: "default", seenAt: 4000 });
  });

  it("an explicit since looks further back without moving the mark", async () => {
    await mark(8000);

    const body = await (await GET(get("?since=1000"), ctx("tmp"))).json();

    expect(body.since).toBe(1000);
    // The mark the viewer will return to is reported unchanged, and is still what is stored.
    expect(body.mark.seenAt).toBe(8000);
    const [row] = tdb.db.select().from(schema.viewerMarks).all();
    expect(Math.floor(row!.seenAt!.getTime() / 1000)).toBe(8000);
  });

  it("rejects a malformed since rather than silently ignoring it", async () => {
    for (const query of ["?since=yesterday", "?since=-1", "?since=1.5"]) {
      expect((await GET(get(query), ctx("tmp"))).status).toBe(400);
    }
  });

  it("404s an unknown project", async () => {
    expect((await GET(get(), ctx("nope"))).status).toBe(404);
  });

  it("folds anton.db rows and the board snapshot into events, not just the window", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    await tdb.db.insert(schema.runs).values({
      id: "run-1",
      projectId: "p1",
      epicBeadId: "anton-epic",
      status: "implementing",
      startedAt,
    });

    const closedAt = new Date(Date.now() - 5_000).toISOString();
    board = [
      {
        id: "anton-done",
        title: "Ship it",
        status: "closed",
        issue_type: "task",
        closed_at: closedAt,
      } as Bead,
    ];

    const body = await (await GET(get(), ctx("tmp"))).json();

    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "run.started", sourceRefs: ["run-1"] }),
        expect.objectContaining({ kind: "bead.closed", sourceRefs: ["anton-done"] }),
      ]),
    );
  });
});
