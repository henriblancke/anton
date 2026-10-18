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
let boardError: Error | null = null;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
vi.mock("@/lib/beads/issues", () => ({
  allIssues: async () => {
    if (boardError) throw boardError;
    return board;
  },
}));

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
  boardError = null;
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

  // PR #346 review, P1 (chatgpt-codex-connector): a run started before the window must still
  // surface its PR as opened if that happened inside it — the single-column `startedAt` seek used
  // to drop the whole row, silently losing the transition.
  it("reports run.pr_opened for a run started before the window whose PR opened inside it", async () => {
    await mark(1_000);
    await tdb.db.insert(schema.runs).values({
      id: "run-old",
      projectId: "p1",
      epicBeadId: "anton-epic",
      ticketBeadId: "anton-t1",
      status: "in_review",
      startedAt: new Date(500 * 1000),
      updatedAt: new Date(1_500 * 1000),
    });
    board = [{ id: "anton-t1", title: "t1", status: "open", issue_type: "task", metadata: { pr: "gh-9" } } as Bead];

    const body = await (await GET(get(), ctx("tmp"))).json();

    expect(body.events).toEqual([
      expect.objectContaining({ kind: "run.pr_opened", at: 1_500, sourceRefs: ["run-old"] }),
    ]);
  });

  // Same defect, the escalation half: raised before the window, resolved inside it.
  it("reports escalation.resolved for an escalation raised before the window but resolved inside it", async () => {
    await mark(1_000);
    await tdb.db.insert(schema.escalations).values({
      id: "esc-old",
      projectId: "p1",
      findingKey: "k1",
      kind: "parked-run",
      reason: "stuck",
      raisedAt: new Date(500 * 1000),
      updatedAt: new Date(1_500 * 1000),
      status: "resolved",
      resolution: "resumed",
    });

    const body = await (await GET(get(), ctx("tmp"))).json();

    expect(body.events).toEqual([
      expect.objectContaining({ kind: "escalation.resolved", at: 1_500, sourceRefs: ["esc-old"] }),
    ]);
  });

  // PR #346 review, P2 (chatgpt-codex-connector): the lower bound is inclusive and the upper bound
  // exclusive specifically so that posting one read's `until` as the next read's `since` neither
  // drops nor replays an event timestamped exactly at that boundary second.
  it("never replays an event timestamped exactly at a prior read's until", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000 * 1000);
      board = [
        {
          id: "anton-done",
          title: "Ship it",
          status: "closed",
          issue_type: "task",
          closed_at: new Date(10_000 * 1000).toISOString(),
        } as Bead,
      ];

      const first = await (await GET(get(), ctx("tmp"))).json();
      expect(first.until).toBe(10_000);
      // Excluded: the row's own `at` is exactly this read's (exclusive) upper bound.
      expect(first.events).toEqual([]);

      await tdb.db
        .insert(schema.viewerMarks)
        .values({ viewerId: "default", projectId: "p1", seenAt: new Date(first.until * 1000) });
      vi.setSystemTime(10_001 * 1000);

      const second = await (await GET(get(), ctx("tmp"))).json();
      expect(second.since).toBe(10_000);
      // Included exactly once: the next read's (inclusive) lower bound picks it up.
      expect(second.events).toEqual([expect.objectContaining({ kind: "bead.closed" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  // PR #346 review, P1 (chatgpt-codex-connector): a response that silently omitted every bd-derived
  // event category (proposals, bead closes, PR merges) would still hand out a postable `until`,
  // letting a client bury those events behind the watermark forever.
  it("fails the request rather than handing out a cursor over a board it could not read", async () => {
    boardError = new Error("bd: exit status 1");

    const res = await GET(get(), ctx("tmp"));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.until).toBeUndefined();
    expect(body.since).toBeUndefined();
  });
});
