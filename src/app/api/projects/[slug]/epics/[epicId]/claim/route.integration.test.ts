/**
 * Real-db + real-bd route test for the human-claim route:
 *   POST   /api/projects/[slug]/epics/[epicId]/claim  → reserve for the requesting operator
 *   DELETE /api/projects/[slug]/epics/[epicId]/claim  → release
 *
 * Mirrors the approve route test's harness (temp anton.db + real bd repo). Covers the assignee-only
 * primitive (claim leaves the bead `open` / stage `backlog`, release clears the assignee), the
 * steal-required-409 gate naming the current owner, and the non-run-target-422 gate. Skipped when
 * `bd`/`git` are absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const post = (slug: string, id: string, body?: unknown) =>
  POST(
    new Request("http://t/", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    ctx(slug, id),
  );
const del = (slug: string, id: string, body?: unknown) =>
  DELETE(
    new Request("http://t/", {
      method: "DELETE",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    ctx(slug, id),
  );

let workDir: string;
let repo: string;
let POST: typeof import("./route").POST;
let DELETE: typeof import("./route").DELETE;
let beads: typeof import("@/lib/beads/bd").beads;
let deriveStage: typeof import("@/lib/ticket-view").deriveStage;
let resetOperatorCache: typeof import("@/lib/operator").resetOperatorCache;

/** Set the resolved operator identity for the next route call. */
function actAs(name: string): void {
  process.env.ANTON_OPERATOR = name;
  resetOperatorCache();
}

suite("claim route (temp anton.db + real bd)", () => {
  let epic = "";

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-claim-route-"));
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

    ({ POST, DELETE } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    ({ deriveStage } = await import("@/lib/ticket-view"));
    ({ resetOperatorCache } = await import("@/lib/operator"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");

    repo = join(workDir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

    epic = await beads.create(repo, { title: "Claimable epic", type: "epic" });

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "claimy",
      name: "claimy",
      repoPath: repo,
    });
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  beforeEach(async () => {
    // Start each case from an unclaimed epic so ordering doesn't leak.
    await beads.unassign(repo, epic);
    actAs("alice");
  });

  it("claims the target for the requesting operator without changing status or stage", async () => {
    const res = await post("claimy", epic);
    expect(res.status).toBe(200);

    const bead = await beads.show(repo, epic);
    expect(bead.assignee).toBe("alice");
    // Assignee-only: the reservation must NOT flip the bead to in_progress — it stays open/backlog.
    expect(bead.status).toBe("open");
    expect(deriveStage(bead)).toBe("backlog");
  }, 60_000);

  it("re-claiming your own reservation is idempotent (no steal needed)", async () => {
    await beads.assign(repo, epic, "alice");
    const res = await post("claimy", epic);
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
  }, 60_000);

  it("releases the claim, clearing the assignee", async () => {
    await beads.assign(repo, epic, "alice");
    const res = await del("claimy", epic);
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(bead.assignee ?? "").toBe("");
    expect(bead.status).toBe("open");
  }, 60_000);

  it("409s when claiming an item held by another operator, naming the owner", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await post("claimy", epic);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("bob");
    expect(body.owner).toBe("bob");
    // The gate must reject before reassigning — bob keeps the claim.
    expect((await beads.show(repo, epic)).assignee).toBe("bob");
  }, 60_000);

  it("steals another operator's claim when { steal: true } is passed", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await post("claimy", epic, { steal: true });
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
  }, 60_000);

  it("409s when releasing another operator's claim without steal, naming the owner", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await del("claimy", epic);
    expect(res.status).toBe(409);
    expect((await res.json()).owner).toBe("bob");
    expect((await beads.show(repo, epic)).assignee).toBe("bob");
  }, 60_000);

  it("409s a stolen release with no operator identity, keeping the owner's claim", async () => {
    // A steal nobody can be attributed to must not clear a teammate's reservation — POST/approve
    // already refuse an unattributable steal, and a release is no less consequential.
    await beads.assign(repo, epic, "bob");
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache();
    // The fallback identity must miss too, or this wouldn't be the case under test. Point git's
    // global config at an empty file so the host's own user.name can't resolve one for us.
    const realGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(workDir, "empty-gitconfig");
    try {
      const res = await del("claimy", epic, { steal: true });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/ANTON_OPERATOR/);
      expect((await beads.show(repo, epic)).assignee).toBe("bob");
    } finally {
      if (realGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = realGlobalConfig;
      resetOperatorCache();
    }
  }, 60_000);

  it("409s claim + release once the target is approved — the reservation is locked", async () => {
    // Approve locks the reservation (approve enforces the claim as a soft-lock). The human-claim
    // route must not mutate an approved target: the runner swallows its own epic claim, so a
    // post-approval steal/release would let a queued run execute under someone else's reservation.
    const approvedEpic = await beads.create(repo, { title: "Approved epic", type: "epic" });
    await beads.assign(repo, approvedEpic, "bob");
    await beads.approve(repo, approvedEpic);
    try {
      const stealRes = await post("claimy", approvedEpic, { steal: true });
      expect(stealRes.status).toBe(409);
      expect((await stealRes.json()).error).toMatch(/approved/i);
      // The gate rejects before reassigning — bob keeps the claim.
      expect((await beads.show(repo, approvedEpic)).assignee).toBe("bob");

      const releaseRes = await del("claimy", approvedEpic, { steal: true });
      expect(releaseRes.status).toBe(409);
      expect((await beads.show(repo, approvedEpic)).assignee).toBe("bob");
    } finally {
      await beads.delete(repo, approvedEpic, { cascade: true });
    }
  }, 60_000);

  it("422s a child ticket of an epic and points at its parent, without claiming it", async () => {
    const parentEpic = await beads.create(repo, { title: "Parent epic", type: "epic" });
    const child = await beads.create(repo, { title: "Child ticket", type: "task" });
    await beads.link(repo, child, parentEpic, "parent-child");

    const res = await post("claimy", child);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/child ticket/i);
    expect(body.error).toContain(parentEpic);
    expect((await beads.show(repo, child)).assignee ?? "").toBe("");
  }, 60_000);

  it("422s a non-work type (molecule) without claiming it", async () => {
    const out = execFileSync("bd", ["create", "A molecule", "--type", "molecule", "--json"], {
      cwd: repo,
      encoding: "utf8",
    });
    const molecule = (JSON.parse(out).id ?? JSON.parse(out)[0]?.id) as string;
    const res = await post("claimy", molecule);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not a run target/i);
  }, 60_000);

  it("404s an unknown bead id without claiming anything", async () => {
    const res = await post("claimy", "claimy-nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  }, 60_000);

  it("404s for an unknown slug", async () => {
    const res = await post("nope", epic);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});
