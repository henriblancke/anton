/**
 * Real-db + real-bd route test for the score history the UI trends over (anton-tprv):
 *   GET /api/projects/[slug]/epics/[epicId]/review → every round this target recorded.
 *
 * The rounds are written the way a run writes them (`formatReviewScoreComment`) and read back
 * through the route, so the comment format and the reader are pinned against real bd rather than
 * against each other. A hand-written comment rides alongside them, because that is what the thread
 * actually looks like: comments are free text, and one a human left must not cost a round.
 * Skipped when `bd`/`git` are absent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  type BdRepo,
  type FileDb,
  describeBd,
  jsonRequest,
  makeBdRepo,
  makeFileDb,
  paramsCtx,
} from "@/lib/testing/integration";

const get = (slug: string, id: string) => GET(jsonRequest("GET"), paramsCtx({ slug, epicId: id }));

let fileDb: FileDb;
let bdRepo: BdRepo;
let repo: string;
let GET: typeof import("./route").GET;
let beads: typeof import("@/lib/beads/bd").beads;
let formatReviewScoreComment: typeof import("@/lib/jobs/review-score").formatReviewScoreComment;
let getDb: typeof import("@/lib/db").getDb;
let schema: typeof import("@/lib/db/schema");

describeBd("review report route (temp anton.db + real bd)", () => {
  let feature = "";

  beforeAll(async () => {
    fileDb = makeFileDb();

    ({ GET } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    ({ formatReviewScoreComment } = await import("@/lib/jobs/review-score"));
    ({ getDb } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");

    bdRepo = makeBdRepo();
    repo = bdRepo.repo;

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "scored",
      name: "scored",
      repoPath: repo,
    });
  });

  afterAll(() => {
    bdRepo?.cleanup();
    fileDb?.cleanup();
  });

  beforeEach(async () => {
    feature = await beads.create(repo, { title: "Reviewed feature", type: "feature" });
  });

  it("replays every round in order, with the last round's findings still on the table", async () => {
    await beads.comment(
      repo,
      feature,
      formatReviewScoreComment({
        round: 1,
        score: 4,
        blocking: 1,
        advisory: 0,
        verdict: "fixed",
        rationale: "the retry path is untested",
        findings: [{ severity: "blocking", location: "src/retry.ts:20", note: "no backoff cap" }],
      }),
    );
    await beads.comment(repo, feature, "Looks better now — merging after CI.");
    await beads.comment(
      repo,
      feature,
      formatReviewScoreComment({
        round: 2,
        score: 8,
        blocking: 0,
        advisory: 1,
        verdict: "clean",
        rationale: "capped and covered",
        findings: [{ severity: "advisory", location: "(general)", note: "naming drifts" }],
      }),
    );

    const res = await get("scored", feature);
    expect(res.status).toBe(200);
    const { report } = await res.json();

    expect(report.rounds.map((r: { round: number }) => r.round)).toEqual([1, 2]);
    expect(report.rounds[0]).toMatchObject({ score: 4, blocking: 1, verdict: "fixed" });
    expect(report.rounds[1]).toMatchObject({ score: 8, advisory: 1, verdict: "clean" });
    // Each round carries bd's own timestamp — the ordering the trend visual can vouch for.
    expect(typeof report.rounds[1].at).toBe("string");
    expect(report.score).toBe(8); // the latest round that reported one
    expect(report.findings).toEqual([
      { severity: "advisory", location: "(general)", note: "naming drifts" },
    ]);
  });

  it("keeps the rounds around a malformed payload — one bad comment can't erase the series", async () => {
    await beads.comment(
      repo,
      feature,
      formatReviewScoreComment({ round: 1, score: 7, blocking: 0, advisory: 0, verdict: "clean" }),
    );
    await beads.comment(repo, feature, ["```json", '{"kind":"anton.review-score",', "```"].join("\n"));

    const { report } = await (await get("scored", feature)).json();
    expect(report.rounds).toHaveLength(1);
    expect(report.score).toBe(7);
  });

  it("reports an unreviewed target as no rounds and no score — never as zero", async () => {
    const { report } = await (await get("scored", feature)).json();
    expect(report.rounds).toEqual([]);
    expect(report.score).toBeUndefined();
    expect(report.findings).toEqual([]);
  });

  it("404s a bead that isn't on the board", async () => {
    const res = await get("scored", "anton-nope");
    expect(res.status).toBe(404);
  });
});
