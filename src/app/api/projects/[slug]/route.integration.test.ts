/**
 * Real-db route test for DELETE /api/projects/[slug]. Boots a temp anton.db (same approach as
 * src/lib/projects.delete.integration.test.ts), seeds project rows directly, then drives the
 * actual route handler: DELETE a known slug → 200 and the project is gone; unknown slug → 404
 * with {error}; a teardown that leaves residue → 500 with the service's message and the rows
 * kept. Mirrors the ticket-detail integration test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type FileDb, jsonRequest, makeFileDb, paramsCtx } from "@/lib/testing/integration";

let fileDb: FileDb;
let DELETE: typeof import("./route").DELETE;
let getDb: typeof import("@/lib/db").getDb;
let schema: typeof import("@/lib/db/schema");

beforeAll(async () => {
  fileDb = makeFileDb();

  ({ DELETE } = await import("./route"));
  ({ getDb } = await import("@/lib/db"));
  schema = await import("@/lib/db/schema");
});

afterAll(() => {
  fileDb.cleanup();
});

/** Seed a bare project row — no runs, so teardown touches no git state. */
async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();
  await getDb().insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: join(dirname(fileDb.path), slug),
  });
  return projectId;
}

async function projectCount(projectId: string): Promise<number> {
  const rows = await getDb()
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return rows.length;
}

describe("DELETE /api/projects/[slug] (temp anton.db)", () => {
  it("deletes a known project and 200s; a repeat DELETE 404s", async () => {
    const projectId = await seedProject("doomed");

    const res = await DELETE(jsonRequest("DELETE"), paramsCtx({ slug: "doomed" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await projectCount(projectId)).toBe(0);

    const again = await DELETE(jsonRequest("DELETE"), paramsCtx({ slug: "doomed" }));
    expect(again.status).toBe(404);
    expect((await again.json()).error).toMatch(/not found/i);
  });

  it("404s with {error} for an unknown slug", async () => {
    const res = await DELETE(jsonRequest("DELETE"), paramsCtx({ slug: "never-was" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found: never-was/i);
  });

  it("500s with the service's message when teardown leaves residue, keeping the rows", async () => {
    const projectId = await seedProject("stuck");
    // A run whose "worktree" is a plain dir under a non-repo path: removeWorktree's git calls
    // all fail best-effort, the dir survives, and deleteProject fails loud on the residue.
    const fakeWorktree = join(dirname(fileDb.path), "stuck-wt");
    mkdirSync(fakeWorktree, { recursive: true });
    await getDb().insert(schema.runs).values({
      id: randomUUID(),
      projectId,
      epicBeadId: "anton-epic-1",
      worktreePath: fakeWorktree,
      status: "done",
    });

    const res = await DELETE(jsonRequest("DELETE"), paramsCtx({ slug: "stuck" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/residue/i);
    expect(await projectCount(projectId)).toBe(1);
  }, 30_000);
});
