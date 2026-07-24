/**
 * Real bd round-trip for `beads.prune` and POST /api/projects/[slug]/prune (anton-uobe):
 * seed closed + open + in_progress beads, assert the dry-run preview counts only the closed one
 * (and deletes nothing), and that `--force` deletes only the closed one — open/in_progress are
 * never touched (bd's own guarantee). Follows the bd-sync integration pattern: real `bd`/`git`
 * subprocesses via the shared harness, real route handler over a temp file-backed anton.db.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  describeBd,
  jsonRequest,
  makeBdRepo,
  makeFileDb,
  paramsCtx,
  type BdRepo,
  type FileDb,
} from "@/lib/testing/integration";
import { beads } from "./bd";

const SLUG = "prune-it";

describeBd("bd prune (real bd · dry-run vs --force via the route)", () => {
  let bdRepo: BdRepo;
  let fileDb: FileDb;
  let POST: typeof import("@/app/api/projects/[slug]/prune/route").POST;
  let closedId: string;
  let openId: string;
  let inProgressId: string;

  beforeAll(async () => {
    bdRepo = makeBdRepo();
    fileDb = makeFileDb(); // must precede the route import — getDb resolves ANTON_DB at import time

    ({ POST } = await import("@/app/api/projects/[slug]/prune/route"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");
    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: SLUG,
      name: SLUG,
      repoPath: bdRepo.repo,
    });

    closedId = await beads.create(bdRepo.repo, { title: "shipped work", type: "task" });
    await beads.close(bdRepo.repo, closedId);
    openId = await beads.create(bdRepo.repo, { title: "still open", type: "task" });
    inProgressId = await beads.create(bdRepo.repo, { title: "being worked", type: "task" });
    await beads.setStatus(bdRepo.repo, inProgressId, "in_progress");
  });

  afterAll(() => {
    fileDb.cleanup();
    bdRepo.cleanup();
  });

  /** Every bead id still in the repo, closed included (`bd list` hides closed by default). */
  const allIds = async () =>
    (await beads.list(bdRepo.repo, ["--status", "open,in_progress,closed"])).map((b) => b.id);

  it("preview (all closed) counts only the closed bead and deletes nothing", async () => {
    const res = await POST(jsonRequest("POST", { age: "all" }), paramsCtx({ slug: SLUG }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.pruned).toBe(false);

    // Dry-run must not delete: the closed bead is still there.
    expect(await allIds()).toContain(closedId);
  });

  it("an age window excludes a freshly closed bead (0 → nothing to prune)", async () => {
    const res = await POST(jsonRequest("POST", { age: "30d" }), paramsCtx({ slug: SLUG }));
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(0);
  });

  it("force deletes only the closed bead; open and in_progress survive", async () => {
    const res = await POST(
      jsonRequest("POST", { age: "all", force: true }),
      paramsCtx({ slug: SLUG }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.pruned).toBe(true);

    const ids = await allIds();
    expect(ids).not.toContain(closedId);
    expect(ids).toContain(openId);
    expect(ids).toContain(inProgressId);
  });

  it("force with 0 matches returns count 0 without error", async () => {
    // After the force-delete test has run, the closed bead is gone; force on an empty set must 200.
    const res = await POST(
      jsonRequest("POST", { age: "all", force: true }),
      paramsCtx({ slug: SLUG }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.pruned).toBe(true);
  });

  it("400s on an unknown age and 404s on an unknown project", async () => {
    const bad = await POST(jsonRequest("POST", { age: "7d" }), paramsCtx({ slug: SLUG }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/age must be one of/i);

    const missing = await POST(jsonRequest("POST", { age: "all" }), paramsCtx({ slug: "nope" }));
    expect(missing.status).toBe(404);
  });
});
