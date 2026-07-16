/**
 * Real-db + real-bd route test for POST /api/projects/[slug]/epics/[epicId]/approve. Mirrors the
 * graph route test's harness (temp anton.db + real bd repo). Covers the readiness gate: a blocked
 * epic (open cross-epic blocker) must be rejected with 409 *before* any approve/enqueue happens,
 * so a dependent epic can't start before its blocker completes. Skipped when `bd`/`git` are absent.
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

const ctx = (slug: string, epicId: string) => ({ params: Promise.resolve({ slug, epicId }) });

let workDir: string;
let repo: string;
let POST: typeof import("./route").POST;
let beads: typeof import("@/lib/beads/bd").beads;

suite("POST /api/projects/[slug]/epics/[epicId]/approve (temp anton.db + real bd)", () => {
  let blocked = "";

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-approve-route-"));
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

    ({ POST } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");

    repo = join(workDir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

    // blocked epic's child is blocked by blocker epic's child → inferred blocked→blocker edge.
    blocked = await beads.create(repo, { title: "Blocked epic", type: "epic" });
    const blocker = await beads.create(repo, { title: "Blocker epic", type: "epic" });
    const t1 = await beads.create(repo, { title: "Ticket in blocked", type: "task" });
    const t2 = await beads.create(repo, { title: "Ticket in blocker", type: "task" });
    await beads.link(repo, t1, blocked, "parent-child");
    await beads.link(repo, t2, blocker, "parent-child");
    await beads.link(repo, t1, t2, "blocks");

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "approvy",
      name: "approvy",
      repoPath: repo,
    });
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("409s a blocked epic without approving it", async () => {
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", blocked));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    // The gate must reject *before* tagging: the epic stays un-approved.
    const bead = await beads.show(repo, blocked);
    expect(beads.isApproved(bead)).toBe(false);
  }, 60_000);

  it("404s with {error} for an unknown slug", async () => {
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("nope", blocked));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});
