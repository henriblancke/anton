/**
 * Real-db + real-bd route test for the human-claim route:
 *   POST   /api/projects/[slug]/epics/[epicId]/claim  → reserve for the requesting operator
 *   DELETE /api/projects/[slug]/epics/[epicId]/claim  → release
 *
 * Mirrors the approve route test's harness (temp anton.db + real bd repo). Covers the assignee-only
 * primitive (claim leaves the bead `open` / stage `backlog`, release clears the assignee), the
 * steal-required-409 gate naming the current owner, the non-run-target-422 gate, and the
 * backlog-only gate (a target that has left backlog — approved or in_progress — is 409, not
 * mutated). Skipped when `bd`/`git` are absent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type BdRepo,
  type FileDb,
  describeBd,
  jsonRequest,
  makeBdRepo,
  makeFileDb,
  paramsCtx,
  saveEnv,
  withOperator,
} from "@/lib/testing/integration";

const post = (slug: string, id: string, body?: unknown) =>
  POST(jsonRequest("POST", body), paramsCtx({ slug, epicId: id }));
const del = (slug: string, id: string, body?: unknown) =>
  DELETE(jsonRequest("DELETE", body), paramsCtx({ slug, epicId: id }));

let fileDb: FileDb;
let bdRepo: BdRepo;
let repo: string;
let POST: typeof import("./route").POST;
let DELETE: typeof import("./route").DELETE;
let beads: typeof import("@/lib/beads/bd").beads;
let deriveStage: typeof import("@/lib/ticket-view").deriveStage;
let resetOperatorCache: typeof import("@/lib/operator").resetOperatorCache;

describeBd("claim route (temp anton.db + real bd)", () => {
  let epic = "";

  beforeAll(async () => {
    fileDb = makeFileDb();

    ({ POST, DELETE } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    ({ deriveStage } = await import("@/lib/ticket-view"));
    ({ resetOperatorCache } = await import("@/lib/operator"));
    const { getDb } = await import("@/lib/db");
    const schema = await import("@/lib/db/schema");

    bdRepo = makeBdRepo();
    repo = bdRepo.repo;

    epic = await beads.create(repo, { title: "Claimable epic", type: "epic" });

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "claimy",
      name: "claimy",
      repoPath: repo,
    });
  }, 60_000);

  afterAll(() => {
    bdRepo?.cleanup();
    fileDb?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  beforeEach(async () => {
    // Start each case from an unclaimed epic so ordering doesn't leak.
    await beads.unassign(repo, epic);
    await withOperator("alice");
  });

  it("claims the target for the requesting operator without changing status or stage", async () => {
    const res = await post("claimy", epic);
    expect(res.status).toBe(200);

    const bead = await beads.show(repo, epic);
    expect(bead.assignee).toBe("alice");
    // Assignee-only: the reservation must NOT flip the bead to in_progress — it stays open/backlog.
    expect(bead.status).toBe("open");
    expect(deriveStage(bead)).toBe("backlog");
  });

  it("re-claiming your own reservation is idempotent (no steal needed)", async () => {
    await beads.assign(repo, epic, "alice");
    const res = await post("claimy", epic);
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
  });

  it("releases the claim, clearing the assignee", async () => {
    await beads.assign(repo, epic, "alice");
    const res = await del("claimy", epic);
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(bead.assignee ?? "").toBe("");
    expect(bead.status).toBe("open");
  });

  it("409s when claiming an item held by another operator, naming the owner", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await post("claimy", epic);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("bob");
    expect(body.owner).toBe("bob");
    // The gate must reject before reassigning — bob keeps the claim.
    expect((await beads.show(repo, epic)).assignee).toBe("bob");
  });

  it("steals another operator's claim when { steal: true } is passed", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await post("claimy", epic, { steal: true });
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
  });

  it("409s when releasing another operator's claim without steal, naming the owner", async () => {
    await beads.assign(repo, epic, "bob");
    const res = await del("claimy", epic);
    expect(res.status).toBe(409);
    expect((await res.json()).owner).toBe("bob");
    expect((await beads.show(repo, epic)).assignee).toBe("bob");
  });

  it("409s a stolen release with no operator identity, keeping the owner's claim", async () => {
    // A steal nobody can be attributed to must not clear a teammate's reservation — POST/approve
    // already refuse an unattributable steal, and a release is no less consequential.
    await beads.assign(repo, epic, "bob");
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache();
    // Every fallback rung must miss too, or this wouldn't be the case under test: point git's
    // global config at an empty file so the host's user.name can't resolve one, AND strip
    // $USER/$USERNAME so resolveOperator's final osUser() rung can't either (mirrors operator.test).
    const restoreEnv = saveEnv(["GIT_CONFIG_GLOBAL", "USER", "USERNAME"]);
    process.env.GIT_CONFIG_GLOBAL = join(bdRepo.dir, "empty-gitconfig");
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      const res = await del("claimy", epic, { steal: true });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/ANTON_OPERATOR/);
      expect((await beads.show(repo, epic)).assignee).toBe("bob");
    } finally {
      restoreEnv();
      resetOperatorCache();
    }
  });

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
  });

  it("409s claim + release once an UNAPPROVED target has left backlog (in_progress)", async () => {
    // A bead claimed outside anton (`bd update --claim`) or by an older/manual run is in_progress
    // with an assignee but NO `approved` label, so the label-based approved gate would miss it. Its
    // live assignee is owned by that run's lifecycle — a human claim/release here must not steal or
    // clear it. Gate on the derived stage (backlog-only), not just the approved label.
    const runningEpic = await beads.create(repo, { title: "Running epic", type: "epic" });
    await beads.claim(repo, runningEpic, "bob");
    try {
      expect(deriveStage(await beads.show(repo, runningEpic))).toBe("implementing");

      const stealRes = await post("claimy", runningEpic, { steal: true });
      expect(stealRes.status).toBe(409);
      expect((await stealRes.json()).error).toMatch(/backlog/i);
      // The gate rejects before reassigning — bob keeps the claim.
      expect((await beads.show(repo, runningEpic)).assignee).toBe("bob");

      const releaseRes = await del("claimy", runningEpic, { steal: true });
      expect(releaseRes.status).toBe(409);
      expect((await beads.show(repo, runningEpic)).assignee).toBe("bob");
    } finally {
      await beads.delete(repo, runningEpic, { cascade: true });
    }
  });

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
  });

  it("422s a non-work type (molecule) without claiming it", async () => {
    const out = execFileSync("bd", ["create", "A molecule", "--type", "molecule", "--json"], {
      cwd: repo,
      encoding: "utf8",
    });
    const molecule = (JSON.parse(out).id ?? JSON.parse(out)[0]?.id) as string;
    const res = await post("claimy", molecule);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not a run target/i);
  });

  it("404s an unknown bead id without claiming anything", async () => {
    const res = await post("claimy", "claimy-nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("404s for an unknown slug", async () => {
    const res = await post("nope", epic);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});
