/**
 * The mark-seen route (anton-z8j4q), against a real in-memory anton.db.
 *
 * The property under test is the one no client can prove: the watermark never moves backwards. A
 * stale tab reposting the mark it loaded with is the realistic case — it must leave the stored mark
 * alone AND still answer 200, because the operator who clicked did nothing wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// The "mark then read" case below drives the real events-since GET, which now fails the request
// rather than degrading to an empty board on a `bd` error (anton-8ubg3 PR #346 review) — mocked
// the same way events-since/route.test.ts does, so this suite stays hermetic instead of shelling
// out to a real `bd` against /tmp/p1.
vi.mock("@/lib/beads/issues", () => ({ refreshAllIssues: async () => [] }));

const { POST } = await import("./route");
const { GET } = await import("../events-since/route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const post = (body: unknown) =>
  new Request("http://t/", { method: "POST", body: JSON.stringify(body) });

function storedMark() {
  return tdb.db.select().from(schema.viewerMarks).all()[0];
}

beforeEach(async () => {
  tdb = makeTestDb();
  await tdb.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
});

describe("POST /timeline/mark-seen", () => {
  it("records the mark and reports it as moved", async () => {
    const res = await POST(post({ seenAt: 4000 }), ctx("tmp"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toBe(true);
    expect(body.mark).toMatchObject({ viewerId: "default", seenAt: 4000 });
    expect(storedMark()!.viewerId).toBe("default");
  });

  it("moves the mark forward on a later instant", async () => {
    await POST(post({ seenAt: 4000 }), ctx("tmp"));

    const body = await (await POST(post({ seenAt: 8000 }), ctx("tmp"))).json();

    expect(body.moved).toBe(true);
    expect(body.mark.seenAt).toBe(8000);
  });

  it("leaves the mark alone on an earlier instant, answering 200 with moved: false", async () => {
    await POST(post({ seenAt: 8000 }), ctx("tmp"));

    const res = await POST(post({ seenAt: 4000 }), ctx("tmp"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toBe(false);
    expect(body.mark.seenAt).toBe(8000);
    // One row, still — a refused move is not a second mark.
    expect(tdb.db.select().from(schema.viewerMarks).all()).toHaveLength(1);
  });

  it("rejects a malformed body rather than marking an unknown instant", async () => {
    for (const body of [{}, { seenAt: "4000" }, { seenAt: -1 }, { seenAt: 1.5 }]) {
      const res = await POST(post(body), ctx("tmp"));
      expect(res.status).toBe(400);
    }
    expect(storedMark()).toBeUndefined();
  });

  it("404s an unknown project", async () => {
    expect((await POST(post({ seenAt: 4000 }), ctx("nope"))).status).toBe(404);
  });

  // A mark is irreversible, so a caller using its OWN clock instead of the `until` it was handed is
  // the one malformed case that cannot be absorbed: stored, it would bury events that have not
  // happened yet, forever. Anchored on the real clock because the route judges against the server's.
  it("refuses a mark far ahead of the server's clock, storing nothing", async () => {
    const res = await POST(post({ seenAt: Math.floor(Date.now() / 1000) + 3600 }), ctx("tmp"));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ahead of this server/);
    expect(storedMark()).toBeUndefined();
  });

  // A legitimate seenAt is an `until` this same server minted earlier, so it can never be ahead of
  // the server's own clock by POST time — there is no skew to tolerate (PR #346 review, P2).
  it("accepts a mark exactly at the server's current clock", async () => {
    const res = await POST(post({ seenAt: Math.floor(Date.now() / 1000) }), ctx("tmp"));
    expect(res.status).toBe(200);
  });

  it("rejects a mark even a second ahead of the server's clock, storing nothing", async () => {
    const res = await POST(post({ seenAt: Math.floor(Date.now() / 1000) + 1 }), ctx("tmp"));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ahead of this server/);
    expect(storedMark()).toBeUndefined();
  });
});

describe("mark then read, through both routes", () => {
  it("hands back the window the mark opened", async () => {
    const marked = await (await POST(post({ seenAt: 4000 }), ctx("tmp"))).json();

    const window = await (await GET(new Request("http://t/"), ctx("tmp"))).json();

    expect(window.since).toBe(4000);
    expect(window.mark).toEqual(marked.mark);
    // The upper bound a caller posts back is never behind the lower one it was handed.
    expect(window.until).toBeGreaterThanOrEqual(window.since);
  });
});
