/**
 * Real-db + real-bd route test for GET /api/projects/[slug]/graph. Boots a temp anton.db (same
 * approach as the DELETE route test), creates a real bd repo with two epics whose child tickets
 * carry a cross-epic `blocks`, seeds a project row pointing at it, then drives the actual route
 * handler and asserts the epic nodes plus the INFERRED epic→epic edge the rollup produces.
 * Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
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

let fileDb: FileDb;
let bdRepo: BdRepo;
let repo: string;
let GET: typeof import("./route").GET;
let beads: typeof import("@/lib/beads/bd").beads;

describeBd("GET /api/projects/[slug]/graph (temp anton.db + real bd)", () => {
  let epic1 = "";
  let epic2 = "";

  beforeAll(async () => {
    fileDb = makeFileDb();

    ({ GET } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");

    // A real bd repo the route will read via the seeded project's repoPath.
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;

    epic1 = await beads.create(repo, { title: "Epic one", type: "epic" });
    epic2 = await beads.create(repo, { title: "Epic two", type: "epic" });
    const t1 = await beads.create(repo, { title: "Ticket in one", type: "task" });
    const t2 = await beads.create(repo, { title: "Ticket in two", type: "task" });
    await beads.link(repo, t1, epic1, "parent-child");
    await beads.link(repo, t2, epic2, "parent-child");
    // t1 (under epic1) is blocked by t2 (under epic2) → an inferred epic1→epic2 edge.
    await beads.link(repo, t1, t2, "blocks");

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "graphy",
      name: "graphy",
      repoPath: repo,
    });
  });

  afterAll(() => {
    bdRepo?.cleanup();
    fileDb?.cleanup();
  });

  it("returns epic nodes plus the inferred cross-epic edge", async () => {
    const res = await GET(jsonRequest("GET"), paramsCtx({ slug: "graphy" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    const epicIds = body.epics.map((e: { id: string }) => e.id);
    expect(epicIds).toContain(epic1);
    expect(epicIds).toContain(epic2);

    const edge = body.edges.find(
      (e: { from: string; to: string }) => e.from === epic1 && e.to === epic2,
    );
    expect(edge, "inferred epic1→epic2 edge").toBeDefined();
    expect(edge.inferred).toBe(true);

    const one = body.epics.find((e: { id: string }) => e.id === epic1);
    const two = body.epics.find((e: { id: string }) => e.id === epic2);
    expect(one.blockedBy).toEqual([epic2]);
    expect(one.ready).toBe(false);
    expect(two.ready).toBe(true);
  });

  it("404s with {error} for an unknown slug", async () => {
    const res = await GET(jsonRequest("GET"), paramsCtx({ slug: "nope" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});
