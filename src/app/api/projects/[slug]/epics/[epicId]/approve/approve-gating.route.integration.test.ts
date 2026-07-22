/**
 * Real-db + real-bd route test for POST /api/projects/[slug]/epics/[epicId]/approve. Mirrors the
 * graph route test's harness (temp anton.db + real bd repo). Covers the readiness gate: a blocked
 * epic (open cross-epic blocker) must be rejected with 409 *before* any approve/enqueue happens,
 * so a dependent epic can't start before its blocker completes. Skipped when `bd`/`git` are absent.
 *
 * This is the "gating" slice of `approve/route.integration.test.ts` — readiness/blocker/type/404
 * gates and the read-economy cases — split out so it runs in parallel with its sibling
 * `approve-*.route.integration.test.ts` file (anton-0oi).
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { jsonRequest } from "@/lib/testing/integration";
import { actAs, ctx, executeEpicJobs, setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let POST: ApproveSuiteCtx["POST"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — gating (temp anton.db + real bd)", () => {
  let blocked = "";
  // A ready epic used to prove the gate reads fresh beads, not a warm board snapshot.
  let ready = "";
  let readyChild = "";
  let externalBlockerChild = "";

  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, POST, beads, resetOperatorCache, blocked, ready, readyChild, externalBlockerChild } =
      s);
  });

  afterAll(() => {
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("409s a blocked epic without approving it", async () => {
    const res = await POST(jsonRequest("POST"), ctx("approvy", blocked));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    // The gate must reject *before* tagging: the epic stays un-approved.
    const bead = await beads.show(repo, blocked);
    expect(beads.isApproved(bead)).toBe(false);
  });

  it("re-reads beads before gating, so a blocker added behind a warm snapshot still 409s", async () => {
    // Warm the board snapshot while `ready` has no blockers — the cached view sees it as ready.
    const { allIssues } = await import("@/lib/beads/issues");
    await allIssues(repo);

    // Add the cross-epic `blocks` edge through the raw CLI (mirrors beads.link's args) so the
    // wrapper's snapshot invalidation never fires — exactly the stale-snapshot race under review.
    execFileSync("bd", ["link", readyChild, externalBlockerChild, "--type", "blocks"], {
      cwd: repo,
      stdio: "ignore",
    });

    const res = await POST(jsonRequest("POST"), ctx("approvy", ready));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    const bead = await beads.show(repo, ready);
    expect(beads.isApproved(bead)).toBe(false);
  });

  it("enqueues a standalone bug and applies the approved label", async () => {
    // A parentless bug is a run target (epic-of-one) — approval must label + enqueue it, not reject.
    const bug = await beads.create(repo, { title: "Loose bug", type: "bug" });
    const res = await POST(jsonRequest("POST"), ctx("approvy", bug));
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(beads.isApproved(await beads.show(repo, bug))).toBe(true);
  });

  it("defaults a bodyless approval to an immediate run; pacing is opt-in via immediate:false", async () => {
    // Bodyless callers (the ticket dialog's "Approve & run"/"Force run") predate the run-directly
    // flag (anton-d8i4) and promise an immediate run — a missing body must not silently become a
    // paced queue request on a budget-aware project. Only an explicit `immediate: false` opts in.
    const bodyless = await beads.create(repo, { title: "Bodyless-immediate bug", type: "bug" });
    const paced = await beads.create(repo, { title: "Opt-in paced bug", type: "bug" });

    expect((await POST(jsonRequest("POST"), ctx("approvy", bodyless))).status).toBe(200);
    expect((await POST(jsonRequest("POST", { immediate: false }), ctx("approvy", paced))).status).toBe(200);

    const payloadOf = async (id: string) => {
      const jobs = await executeEpicJobs(id);
      expect(jobs).toHaveLength(1);
      return JSON.parse(jobs[0].payloadJson ?? "{}") as { bypassBudget?: boolean };
    };
    expect((await payloadOf(bodyless)).bypassBudget).toBe(true);
    // `bypassBudget` is written only when true, so a paced enqueue carries no flag at all.
    expect((await payloadOf(paced)).bypassBudget).toBeUndefined();
  });

  it("returns the post-write approved + assignee in the 200 body, not the retained pre-write snapshot", async () => {
    // Read-after-write: the approve write only marks the board snapshot stale (retaining the
    // pre-write beads), so building the 200 body straight off the stale-tolerant getBoard would echo
    // the old unapproved/unclaimed values — and ClaimControl, which consumes `assignee`, would keep
    // showing no owner until a later poll. The route forces a fresh read before responding, so the
    // body must carry the just-written approval and the auto-claim.
    actAs("anton-test");
    const bug = await beads.create(repo, { title: "Fresh-body bug", type: "bug" });
    // Warm the snapshot with the pre-write (unapproved, unclaimed) bead, reproducing the stale-read race.
    const { allIssues } = await import("@/lib/beads/issues");
    await allIssues(repo);

    const res = await POST(jsonRequest("POST"), ctx("approvy", bug));
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.approved).toBe(true);
    expect(item.assignee).toBe("anton-test");
  });

  it("409s a standalone task blocked by an open prerequisite, without approving it", async () => {
    // A parentless task/bug is a run target, but a `blocks` edge still gates it — its blockers
    // aren't in the epic-graph rollup, so the route derives them from the target's own edges.
    // Approval enqueues immediately, so a still-blocked standalone must be rejected before labeling.
    const blocker = await beads.create(repo, { title: "Standalone blocker", type: "task" });
    const dependent = await beads.create(repo, { title: "Standalone dependent", type: "task" });
    await beads.link(repo, dependent, blocker, "blocks");

    const res = await POST(jsonRequest("POST"), ctx("approvy", dependent));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/blocked by/i);
    expect(body.error).toContain(blocker);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(false);
  });

  it("enqueues a standalone task once its blocker closes", async () => {
    // The same blocks edge stops gating once the prerequisite is done — the standalone becomes ready.
    const blocker = await beads.create(repo, { title: "Standalone blocker (closes)", type: "task" });
    const dependent = await beads.create(repo, { title: "Standalone dependent (ready)", type: "task" });
    await beads.link(repo, dependent, blocker, "blocks");
    await beads.close(repo, blocker);

    const res = await POST(jsonRequest("POST"), ctx("approvy", dependent));
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(true);
  });

  it("enqueues a real epic with no blockers and applies the approved label", async () => {
    const epic = await beads.create(repo, { title: "Free epic", type: "epic" });
    const child = await beads.create(repo, { title: "Free epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });

  it("422s a child ticket of an epic, points at its parent, and does not approve it", async () => {
    // A task WITH a parent runs via its epic's PR, never standalone — approving it must be rejected.
    const parentEpic = await beads.create(repo, { title: "Parent epic", type: "epic" });
    const child = await beads.create(repo, { title: "Child ticket", type: "task" });
    await beads.link(repo, child, parentEpic, "parent-child");
    const res = await POST(jsonRequest("POST"), ctx("approvy", child));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/child ticket/i);
    expect(body.error).toContain(parentEpic); // guidance names the epic to approve instead
    expect(beads.isApproved(await beads.show(repo, child))).toBe(false);
  });

  it("422s a non-work type (molecule) with an honest error and does not approve it", async () => {
    // `beads.create` only makes epic/task/bug; a non-work type needs the raw CLI.
    const out = execFileSync("bd", ["create", "A molecule", "--type", "molecule", "--json"], {
      cwd: repo,
      encoding: "utf8",
    });
    const molecule = JSON.parse(out).id as string;
    const res = await POST(jsonRequest("POST"), ctx("approvy", molecule));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not runnable/i);
    expect(beads.isApproved(await beads.show(repo, molecule))).toBe(false);
  });

  it("404s an unknown bead id without approving anything", async () => {
    const res = await POST(jsonRequest("POST"), ctx("approvy", "approvy-nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("404s with {error} for an unknown slug", async () => {
    const res = await POST(jsonRequest("POST"), ctx("nope", blocked));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  // anton-hwkx: read economy. Approve used to spend up to four `bd list`/`bd show` reads of its own
  // around the single write — a forced list + board build before it, an ownership `show`, then a
  // second forced list + board build after it — with every one of them queued behind the Dolt lock on
  // the operator's critical path. The trimmed path reads once and answers off state it already holds.
  it("spends at most two bd reads on a normal approve", async () => {
    // A target the operator already owns (the UI's Force run / re-approve): the CAS finds the
    // assignee already where it wants it, so the whole request is one forced `bd list` for the
    // readiness gate plus the CAS's one under-lock re-read — no board refresh, no ownership `show`.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Read-economy epic", type: "epic" });
    const child = await beads.create(repo, { title: "Read-economy epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "anton-test");

    // The remote push is fire-and-forget off the response path; stub it so its spawns aren't counted.
    const syncSpy = vi.spyOn(beads, "sync").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(beads, "list");
    const showSpy = vi.spyOn(beads, "show");
    // Count reads as of the approve write — the last step of the approve chain. What follows is the
    // enqueue's own cross-machine liveness gate (liveRunCheck, anton-jz1), a separate concern.
    let readsAtWrite = -1;
    const realTag = beads.tag.bind(beads);
    const tagSpy = vi.spyOn(beads, "tag").mockImplementation(async (cwd, id, labels) => {
      if (id === epic) readsAtWrite = listSpy.mock.calls.length + showSpy.mock.calls.length;
      return realTag(cwd, id, labels);
    });
    try {
      const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
      expect(res.status).toBe(200);
      expect(readsAtWrite).toBeLessThanOrEqual(2);
      expect(listSpy).toHaveBeenCalledTimes(1); // the readiness gate; the board build reuses it
    } finally {
      tagSpy.mockRestore();
      listSpy.mockRestore();
      showSpy.mockRestore();
      syncSpy.mockRestore();
    }
    // Behaviour is unchanged by the trim: the label landed and the reservation stands.
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  });

  it("reads once for the gate and never re-reads the board after the write", async () => {
    // An unclaimed target additionally pays the CAS write chain (assign + its post-write verify
    // read), which is the claim guard and stays. What must NOT come back is a second forced `bd list`
    // for the response: the write flags the snapshot pendingWrite, so the client's next poll blocks
    // on a fresh read anyway — and the 200 body still carries the just-written approval + assignee.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Read-economy unclaimed", type: "epic" });
    const child = await beads.create(repo, { title: "Read-economy unclaimed child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    const syncSpy = vi.spyOn(beads, "sync").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(beads, "list");
    try {
      const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
      expect(res.status).toBe(200);
      const { item } = await res.json();
      expect(item.approved).toBe(true);
      expect(item.assignee).toBe("anton-test");
      expect(listSpy).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
});
