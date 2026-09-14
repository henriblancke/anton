/**
 * Route test for GET /api/projects/[slug]/epics/[epicId]/review — the only surface the founder reads
 * a run target's review history from. What is under test is the HTTP SHAPE, and above all the
 * 404-vs-500 split the handler's own comment calls load-bearing: a bd that could not answer must not
 * be reported as "your target is gone".
 *
 * Only the leaf that shells out is stubbed (`beads.showWithComments`) — `isMissingBeadError` and the
 * report replay stay real, so the classification under test is the one production runs. Project
 * resolution runs against a real in-memory anton.db, mirroring the escalation-settle route test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { paramsCtx } from "@/lib/testing/integration";
import type { Bead } from "@/lib/beads/bd";
import { formatReviewScoreComment } from "@/lib/jobs/review-score";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const showWithComments = vi.fn<(repoPath: string, id: string) => Promise<Bead>>();
vi.mock("@/lib/beads/bd", async () => {
  const actual = await vi.importActual<typeof import("@/lib/beads/bd")>("@/lib/beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      showWithComments: (...args: [string, string]) => showWithComments(...args),
    },
  };
});

const { GET } = await import("./route");

const get = (slug: string, epicId: string) =>
  GET(new Request("http://t/"), paramsCtx({ slug, epicId }));

/** A hydrated run target as bd answers for it, carrying the score rounds a finished review left. */
const target = (comments: { text: string; created_at?: string }[]): Bead =>
  ({ id: "anton-e1", title: "Target", status: "open", issue_type: "feature", comments }) as Bead;

const round = (entry: Parameters<typeof formatReviewScoreComment>[0], at = "2026-08-02T12:00:00Z") =>
  ({ text: formatReviewScoreComment(entry), created_at: at });

/** An execFile rejection as `bd` produces it — the stderr is what the classifier reads. */
const bdError = (stderr: string): Error => Object.assign(new Error("bd failed"), { stderr });

describe("GET /api/projects/[slug]/epics/[epicId]/review", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(() => {
    tdb.db.delete(schema.projects).run();
    tdb.db
      .insert(schema.projects)
      .values({ id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" })
      .run();
    showWithComments.mockResolvedValue(target([]));
  });

  // restoreAllMocks too: a console spy must not survive a failed assertion and silence the rest of
  // the file — clearAllMocks drops call history but leaves the mocked implementation in place.
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("200 — the report as the panel renders it", () => {
    it("returns every round, the latest score, and the findings still open", async () => {
      showWithComments.mockResolvedValue(
        target([
          round({
            round: 1,
            score: 4,
            blocking: 1,
            advisory: 0,
            verdict: "fixed",
            findings: [
              { severity: "blocking", location: "src/retry.ts:20", note: "no backoff cap" },
            ],
          }),
          round({ round: 2, score: 9, blocking: 0, advisory: 1, verdict: "clean" }),
        ]),
      );

      const res = await get("alpha", "anton-e1");

      expect(res.status).toBe(200);
      const { report } = await res.json();
      expect(report.rounds.map((r: { round: number }) => r.round)).toEqual([1, 2]);
      // The header reads the LATEST score, and the selectable findings are the last round that had any.
      expect(report.score).toBe(9);
      expect(report.findings).toEqual([
        { severity: "blocking", location: "src/retry.ts:20", note: "no backoff cap" },
      ]);
      // Read against the project the slug resolved to, per PAGE — one hydrated bd spawn, no more.
      expect(showWithComments).toHaveBeenCalledTimes(1);
      expect(showWithComments).toHaveBeenCalledWith("/tmp/alpha", "anton-e1");
    });

    // Never reviewed is a real answer, not an error: the panel says "not scored yet" from this body.
    it("returns an empty report for a target no round has scored", async () => {
      const res = await get("alpha", "anton-e1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ report: { rounds: [], findings: [] } });
    });
  });

  describe("404 — bd answered, and the answer was 'no such bead'", () => {
    it.each([
      ['no issue found matching "anton-e1"'],
      ["no issues found matching the provided IDs"],
      ["issue anton-e1 not found"],
    ])("reports a target the board does not have (%s)", async (stderr) => {
      showWithComments.mockRejectedValue(bdError(stderr));

      const res = await get("alpha", "anton-e1");

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Ticket anton-e1 not found on the board");
    });

    it("404s an unknown project slug before it ever reaches bd", async () => {
      const res = await get("nope", "anton-e1");

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Project not found");
      expect(showWithComments).not.toHaveBeenCalled();
    });
  });

  describe("500 — bd could not answer at all", () => {
    // The split that matters: a wedged Dolt, an absent binary or a timeout says nothing about
    // whether the target exists, so reporting it as not-found would tell the founder it is gone.
    it.each([
      ["a locked database", bdError("Error 1105: database is locked")],
      ["a missing binary", new Error("bd: executable not found in $PATH")],
      ["a timeout", new Error("bd timed out after 120000ms")],
      ["a throw carrying no message at all", "bd exploded"],
    ])("reports %s as unreadable, not as not-found", async (_label, err) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      showWithComments.mockRejectedValue(err);

      const res = await get("alpha", "anton-e1");

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Could not read the review report");
      expect(logged).toHaveBeenCalled();
    });
  });
});
