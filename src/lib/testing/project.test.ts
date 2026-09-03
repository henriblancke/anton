/**
 * The point of the shared fixture: a new `projects` column is one edit here, not forty across the
 * suites. These cases pin the two things that would let the copies creep back — that the defaults
 * every suite relied on are still applied, and that an override reaches the row unchanged.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { makeTestDb } from "@/lib/db/testing";
import { insertProject, makeProjectDb } from "@/lib/testing/project";

function projectRow(db: ReturnType<typeof makeTestDb>["db"], id: string) {
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
}

describe("insertProject", () => {
  it("inserts the sandbox defaults the suites used to inline", () => {
    const tdb = makeTestDb();
    const id = insertProject(tdb.db);

    expect(projectRow(tdb.db, id)).toMatchObject({
      id,
      slug: "sandbox",
      name: "sandbox",
      repoPath: "/tmp/sandbox",
      defaultBranch: "main",
      settingsJson: "{}",
    });
    tdb.close();
  });

  it("lets a suite override any column, including the id it pins its payloads to", () => {
    const tdb = makeTestDb();
    const settingsJson = JSON.stringify({ testCommand: "bun test" });
    const id = insertProject(tdb.db, { id: "p1", slug: "p1", name: "P1", repoPath: "/repo", settingsJson });

    expect(id).toBe("p1");
    expect(projectRow(tdb.db, "p1")).toMatchObject({
      slug: "p1",
      name: "P1",
      repoPath: "/repo",
      settingsJson,
    });
    tdb.close();
  });

  it("gives each call a distinct id, so a suite can seed two projects side by side", () => {
    const tdb = makeTestDb();
    const a = insertProject(tdb.db, { slug: "a", name: "a" });
    const b = insertProject(tdb.db, { slug: "b", name: "b" });

    expect(a).not.toBe(b);
    tdb.close();
  });
});

describe("makeProjectDb", () => {
  it("returns a migrated db whose project row is already there", () => {
    const tdb = makeProjectDb({ repoPath: "/tmp/repo" });

    expect(projectRow(tdb.db, tdb.projectId)).toMatchObject({ repoPath: "/tmp/repo" });
    // The FK root is satisfied, which is the whole reason suites seed a project first.
    tdb.db
      .insert(schema.jobs)
      .values({ id: "j1", type: "sync-push", projectId: tdb.projectId, status: "queued" })
      .run();

    tdb.close();
  });
});
