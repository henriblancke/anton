/**
 * Real-db + real-bd route test for GET /api/projects/[slug]/graph. Boots a temp anton.db (same
 * approach as the DELETE route test), creates a real bd repo with two epics whose child tickets
 * carry a cross-epic `blocks`, seeds a project row pointing at it, then drives the actual route
 * handler and asserts the epic nodes plus the INFERRED epic→epic edge the rollup produces.
 * Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("bd") && has("git") ? describe : describe.skip;

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

let workDir: string;
let repo: string;
let GET: typeof import("./route").GET;
let beads: typeof import("@/lib/beads/bd").beads;

suite("GET /api/projects/[slug]/graph (temp anton.db + real bd)", () => {
  let epic1 = "";
  let epic2 = "";

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-graph-route-"));
    process.env.ANTON_DB = join(workDir, "anton.db");

    // Apply every committed migration before the module-level getDb() singleton is created.
    const setup = new Database(process.env.ANTON_DB);
    const migrationsDir = join(process.cwd(), "drizzle");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      const raw = readFileSync(join(migrationsDir, file), "utf8");
      setup.exec(
        raw
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(";\n"),
      );
    }
    setup.close();

    ({ GET } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");

    // A real bd repo the route will read via the seeded project's repoPath.
    repo = join(workDir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

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
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("returns epic nodes plus the inferred cross-epic edge", async () => {
    const res = await GET(new Request("http://t/"), ctx("graphy"));
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
  }, 60_000);

  it("404s with {error} for an unknown slug", async () => {
    const res = await GET(new Request("http://t/"), ctx("nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});
