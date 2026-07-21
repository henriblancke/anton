/**
 * Real-db + real-bd route test for POST /api/projects/[slug]/epics/[epicId]/approve. Mirrors the
 * graph route test's harness (temp anton.db + real bd repo). Skipped when `bd`/`git` are absent.
 *
 * This is the "claims" slice of `approve/route.integration.test.ts` — claim/steal/take-over and
 * enqueue-dedupe cases — split out so it runs in parallel with its sibling
 * `approve-*.route.integration.test.ts` file (anton-0oi).
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { jsonRequest } from "@/lib/testing/integration";
import {
  actAs,
  ctx,
  executeEpicJobs,
  parkJob,
  setupApproveSuite,
  type ApproveSuiteCtx,
} from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let POST: ApproveSuiteCtx["POST"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — claims (temp anton.db + real bd)", () => {
  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, POST, beads, resetOperatorCache } = s);
  });

  afterAll(() => {
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("does not enqueue a second run when a take-over re-approves an epic whose run parked", async () => {
    // Take over is steal-on-approve, so it goes through this route — but it must only move the
    // reservation. The enqueue dedupe covers `queued`/`running` only, so a parked prior run is
    // exactly the window where a re-approve could spawn a duplicate run under the new owner.
    const epic = await beads.create(repo, { title: "Parked-run epic", type: "epic" });
    const child = await beads.create(repo, { title: "Parked-run epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    actAs("bob");
    expect((await POST(jsonRequest("POST"), ctx("approvy", epic))).status).toBe(200);
    const first = await executeEpicJobs(epic);
    expect(first).toHaveLength(1);
    await parkJob(first[0].id);

    actAs("alice");
    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    // The reservation moves…
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
    // …and nothing else does: still one run, still parked (recoverable via resume, not a fresh run).
    const after = await executeEpicJobs(epic);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("parked");
    expect((await res.json()).jobId).toBeUndefined();
  });

  it("re-approving an already-approved target you own enqueues a run (the UI's Force run)", async () => {
    // Force run / Run epic post here with no body, so a re-approve that isn't a steal is the
    // operator asking for a run — it must enqueue. Gating every re-approve on the `approved` label
    // would 200 with no jobId and leave an approved epic unrunnable from the UI.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Approved already", type: "epic" });
    const child = await beads.create(repo, { title: "Approved already child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.approve(repo, epic); // labelled, with no job on THIS machine
    expect(await executeEpicJobs(epic)).toHaveLength(0);

    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(await executeEpicJobs(epic)).toHaveLength(1);
  });

  it("force-running twice reuses the live job rather than starting a second run", async () => {
    // The steal-scoped gate leans on the enqueue dedupe for the double-click case, so hold that
    // line here: a second Force run while the first is still queued must return the same job.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Double force", type: "epic" });
    const child = await beads.create(repo, { title: "Double force child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    const first = await POST(jsonRequest("POST"), ctx("approvy", epic));
    const second = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(second.status).toBe(200);
    expect((await second.json()).jobId).toBe((await first.json()).jobId);
    expect(await executeEpicJobs(epic)).toHaveLength(1);
  });

  it("409s a run target claimed by another operator, without approving it", async () => {
    // A teammate's claim is a soft-lock: approving would silently run their reservation. The route
    // reads the fresh bead (assignee set by another operator) and refuses without an explicit steal.
    const epic = await beads.create(repo, { title: "Claimed by teammate", type: "epic" });
    const child = await beads.create(repo, { title: "Claimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");

    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("someone-else");
    expect(body.owner).toBe("someone-else");
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
  });

  it("steals a teammate's claim on approve when { steal: true } is passed", async () => {
    // Stealing is the explicit override: it reassigns the claim to the approver and approves.
    const epic = await beads.create(repo, { title: "Stolen on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Stolen epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");

    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  });

  it("409s a steal-on-approve of an implementing target and leaves the reservation with its owner", async () => {
    // A steal only moves the reservation — it cannot halt a run already executing under the owner.
    // Taking over an implementing/in-review target would strand that live run under a new owner, so
    // the route rejects it (the takeOver gate suppresses only a *second* enqueue, never the first).
    // Mirrors the UI, which offers Take over solely on backlog targets (claim-control `canTakeOver`).
    const epic = await beads.create(repo, { title: "Running epic", type: "epic" });
    const child = await beads.create(repo, { title: "Running epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");
    await beads.approve(repo, epic);
    await beads.tag(repo, epic, ["stage:implementing"]);

    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("someone-else");
    expect(body.stage).toBe("implementing");
    // The reservation stays with its owner and no run is enqueued under the would-be stealer.
    expect((await beads.show(repo, epic)).assignee).toBe("someone-else");
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  });

  it("409s a steal when the owner's run starts between the stage gate and the claim swap", async () => {
    // The pre-lock stage gate can read backlog, then the owner's runner starts before the CAS:
    // it moves the bead to stage:implementing but leaves the assignee as the old owner, so a swap
    // matching on assignee alone would reassign a live run to the approver. The route re-derives the
    // stage under the claim lock to reject exactly that window. The pre-lock gate reads the bead off
    // the `bd list` the route forces up front (still backlog here), so simulate the runner starting
    // in the window after it by tagging the bead implementing just before the under-lock read lands.
    const epic = await beads.create(repo, { title: "Racing take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Racing take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");
    await beads.approve(repo, epic); // approved + backlog, owned by a teammate

    const realShow = beads.show.bind(beads);
    let raced = false;
    const spy = vi.spyOn(beads, "show").mockImplementation(async (cwd, id) => {
      if (id === epic && !raced) {
        raced = true; // the owner's runner "starts" between the pre-lock gate and this read
        await beads.tag(repo, epic, ["stage:implementing"]);
      }
      return realShow(cwd, id);
    });

    actAs("anton-test");
    try {
      const res = await POST(
        jsonRequest("POST", { steal: true }),
        ctx("approvy", epic),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.stage).toBe("implementing");
      // The reservation stays with its owner and nothing is enqueued under the would-be stealer.
      expect((await realShow(repo, epic)).assignee).toBe("someone-else");
      expect(await executeEpicJobs(epic)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("takes over an approved backlog target that gained a blocker after approval, without enqueuing", async () => {
    // A pure take-over only moves the reservation — it enqueues nothing — so the open-blocker gate
    // that guards a fresh approval must not reject it. Otherwise a target that gained a blocker AFTER
    // its original approval would sit stranded with the old owner until the blocker closes, even
    // though the UI offers Take over on exactly these approved backlog targets (claim-control).
    const epic = await beads.create(repo, { title: "Approved-then-blocked take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Approved-then-blocked take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");
    await beads.approve(repo, epic); // approved + backlog, owned by a teammate

    // A blocker lands only now — a normal (non-take-over) approval of this epic would 409 here.
    const blocker = await beads.create(repo, { title: "Late-arriving blocker", type: "task" });
    await beads.link(repo, child, blocker, "blocks");

    actAs("anton-test");
    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    // The reservation transfers to the new owner…
    expect((await beads.show(repo, epic)).assignee).toBe("anton-test");
    // …and no run is enqueued (a take-over suppresses the run despite the open blocker).
    expect((await res.json()).jobId).toBeUndefined();
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  });

  it("enqueues a local run when taking over an approved, ready target with no job on this instance", async () => {
    // The cross-instance take-over (anton-i71, PR #39): operator A approved on their machine, which
    // enqueued A's job in A's local anton.db — not this one. Here the target is approved + backlog,
    // owned by A, ready (no blockers), and this instance holds NO job for it. A take-over reassigns
    // the reservation to us; without a local enqueue the approved work would strand, because A's job
    // poisons itself once execute-epic sees the epic reassigned. So the take-over must enqueue a
    // fresh runnable job HERE, under the new owner.
    const epic = await beads.create(repo, { title: "Cross-instance take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Cross-instance take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");
    await beads.approve(repo, epic); // approved + backlog, owned by A, with no job on THIS machine
    expect(await executeEpicJobs(epic)).toHaveLength(0);

    actAs("anton-test");
    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    // The reservation transfers to the new owner…
    expect((await beads.show(repo, epic)).assignee).toBe("anton-test");
    // …and a runnable job is enqueued on this instance under the new owner (not stranded).
    expect((await res.json()).jobId).toBeTruthy();
    const jobs = await executeEpicJobs(epic);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
  });

  it("does not enqueue a second local job when taking over a ready target this instance already runs", async () => {
    // The same-instance counterpart: this instance already has an active job for the epic (a normal
    // approval enqueued it here). A take-over must reuse that job — reassigning the reservation, not
    // spawning a duplicate — since operator identity is machine-scoped and the existing job will run
    // under whoever holds the epic. `enqueueExecuteEpicIfAbsent` returns no new id when a job exists.
    const epic = await beads.create(repo, { title: "Same-instance take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Same-instance take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    actAs("bob");
    expect((await POST(jsonRequest("POST"), ctx("approvy", epic))).status).toBe(200);
    const first = await executeEpicJobs(epic);
    expect(first).toHaveLength(1);

    actAs("alice");
    const res = await POST(
      jsonRequest("POST", { steal: true }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
    // The existing job is reused — no new id, still exactly one job for the epic.
    expect((await res.json()).jobId).toBeUndefined();
    expect(await executeEpicJobs(epic)).toHaveLength(1);
    // Restore the default operator the following (actAs-less) tests rely on.
    actAs("anton-test");
  });

  it("auto-claims an unclaimed run target for the approver before enqueuing", async () => {
    // Closing the gap before the runtime execution-claim: approving an unclaimed target sets the
    // approver as assignee, so a teammate can't land a claim between approve and the runner.
    const epic = await beads.create(repo, { title: "Unclaimed on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Unclaimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  });

  it("approves an item already claimed by the requesting operator unchanged", async () => {
    // Re-approving your own claim is idempotent — no steal needed, assignee stays yours.
    const epic = await beads.create(repo, { title: "Self-claimed on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Self-claimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "anton-test");

    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  });

  // anton-u8wu (A2): approval enqueues the run off the local approve write, so it must not block on
  // the remote push. Hold the sync pending, prove POST responds 200 before it settles (off the
  // critical path), then reject it and prove the failure is logged and swallowed — never awaited,
  // never an unhandled rejection. The sync-status "failing"/unpushed recording lives in beads.sync
  // and is covered in bd.test.ts.
  it("fires the remote push off the response path and catches a rejected sync", async () => {
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Approve then fail", type: "epic" });
    const child = await beads.create(repo, { title: "Approve then fail child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Responds while the push is still in flight — proof it isn't awaited (an awaited sync would
    // hang the response until this test times out).
    const res = await POST(jsonRequest("POST"), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run
    expect(errSpy).toHaveBeenCalled(); // the failed push was logged, not silently swallowed

    syncSpy.mockRestore();
    errSpy.mockRestore();

    // The approve write landed locally regardless of the failed push.
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  });
});
