/**
 * The events-since window (anton-z8j4q), against a real in-memory anton.db.
 *
 * What this route owns is the WINDOW, not the events: where a timeline read starts, and the instant
 * it is current as of. The cases that matter are the two ways a lower bound goes wrong — a viewer
 * who has never looked (whose window is all of history, not none of it) and an explicit `since`
 * that must look back WITHOUT disturbing the stored mark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

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
});
