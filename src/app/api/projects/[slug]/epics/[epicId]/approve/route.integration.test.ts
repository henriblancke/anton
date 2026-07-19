/**
 * Real-db + real-bd route test for POST /api/projects/[slug]/epics/[epicId]/approve. Mirrors the
 * graph route test's harness (temp anton.db + real bd repo). Covers the readiness gate: a blocked
 * epic (open cross-epic blocker) must be rejected with 409 *before* any approve/enqueue happens,
 * so a dependent epic can't start before its blocker completes. Skipped when `bd`/`git` are absent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
let resetOperatorCache: typeof import("@/lib/operator").resetOperatorCache;

/** Set the resolved operator identity for the next route call (the identity is memoized). */
function actAs(name: string): void {
  process.env.ANTON_OPERATOR = name;
  resetOperatorCache();
}

/** Every execute-epic job queued for `epicId`, in any status. */
async function executeEpicJobs(epicId: string) {
  const { getDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const rows = await getDb().select().from(schema.jobs);
  return rows.filter(
    (r) =>
      r.type === "execute-epic" &&
      (JSON.parse(r.payloadJson ?? "{}") as { epicBeadId?: string }).epicBeadId === epicId,
  );
}

/** Park a job the way an exhausted retry budget would, without running the runner. */
async function parkJob(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDb().update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, id));
}

suite("POST /api/projects/[slug]/epics/[epicId]/approve (temp anton.db + real bd)", () => {
  let blocked = "";
  // A ready epic used to prove the gate reads fresh beads, not a warm board snapshot.
  let ready = "";
  let readyChild = "";
  let externalBlockerChild = "";

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-approve-route-"));
    process.env.ANTON_DB = join(workDir, "anton.db");
    // Pin a deterministic operator identity so the claim soft-lock (owner check + auto-claim) is
    // assertable without depending on the host's global git user.name.
    process.env.ANTON_OPERATOR = "anton-test";

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
    ({ resetOperatorCache } = await import("@/lib/operator"));
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

    // A second, initially-ready epic plus a standalone blocker whose child we later wire in via a
    // raw `bd` call, simulating another process adding a cross-epic edge behind the board snapshot.
    ready = await beads.create(repo, { title: "Ready epic", type: "epic" });
    const externalBlocker = await beads.create(repo, { title: "External blocker epic", type: "epic" });
    readyChild = await beads.create(repo, { title: "Ticket in ready", type: "task" });
    externalBlockerChild = await beads.create(repo, { title: "Ticket in external blocker", type: "task" });
    await beads.link(repo, readyChild, ready, "parent-child");
    await beads.link(repo, externalBlockerChild, externalBlocker, "parent-child");

    await getDb().insert(schema.projects).values({
      id: randomUUID(),
      slug: "approvy",
      name: "approvy",
      repoPath: repo,
    });
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("409s a blocked epic without approving it", async () => {
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", blocked));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    // The gate must reject *before* tagging: the epic stays un-approved.
    const bead = await beads.show(repo, blocked);
    expect(beads.isApproved(bead)).toBe(false);
  }, 60_000);

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

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", ready));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/blocked by/i);

    const bead = await beads.show(repo, ready);
    expect(beads.isApproved(bead)).toBe(false);
  }, 60_000);

  it("enqueues a standalone bug and applies the approved label", async () => {
    // A parentless bug is a run target (epic-of-one) — approval must label + enqueue it, not reject.
    const bug = await beads.create(repo, { title: "Loose bug", type: "bug" });
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", bug));
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(beads.isApproved(await beads.show(repo, bug))).toBe(true);
  }, 60_000);

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

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", bug));
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.approved).toBe(true);
    expect(item.assignee).toBe("anton-test");
  }, 60_000);

  it("409s a standalone task blocked by an open prerequisite, without approving it", async () => {
    // A parentless task/bug is a run target, but a `blocks` edge still gates it — its blockers
    // aren't in the epic-graph rollup, so the route derives them from the target's own edges.
    // Approval enqueues immediately, so a still-blocked standalone must be rejected before labeling.
    const blocker = await beads.create(repo, { title: "Standalone blocker", type: "task" });
    const dependent = await beads.create(repo, { title: "Standalone dependent", type: "task" });
    await beads.link(repo, dependent, blocker, "blocks");

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", dependent));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/blocked by/i);
    expect(body.error).toContain(blocker);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(false);
  }, 60_000);

  it("enqueues a standalone task once its blocker closes", async () => {
    // The same blocks edge stops gating once the prerequisite is done — the standalone becomes ready.
    const blocker = await beads.create(repo, { title: "Standalone blocker (closes)", type: "task" });
    const dependent = await beads.create(repo, { title: "Standalone dependent (ready)", type: "task" });
    await beads.link(repo, dependent, blocker, "blocks");
    await beads.close(repo, blocker);

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", dependent));
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, dependent))).toBe(true);
  }, 60_000);

  it("enqueues a real epic with no blockers and applies the approved label", async () => {
    const epic = await beads.create(repo, { title: "Free epic", type: "epic" });
    const child = await beads.create(repo, { title: "Free epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  }, 60_000);

  it("does not enqueue a second run when a take-over re-approves an epic whose run parked", async () => {
    // Take over is steal-on-approve, so it goes through this route — but it must only move the
    // reservation. The enqueue dedupe covers `queued`/`running` only, so a parked prior run is
    // exactly the window where a re-approve could spawn a duplicate run under the new owner.
    const epic = await beads.create(repo, { title: "Parked-run epic", type: "epic" });
    const child = await beads.create(repo, { title: "Parked-run epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    actAs("bob");
    expect((await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic))).status).toBe(200);
    const first = await executeEpicJobs(epic);
    expect(first).toHaveLength(1);
    await parkJob(first[0].id);

    actAs("alice");
    const res = await POST(
      new Request("http://t/", { method: "POST", body: JSON.stringify({ steal: true }) }),
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
  }, 60_000);

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

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();
    expect(await executeEpicJobs(epic)).toHaveLength(1);
  }, 60_000);

  it("force-running twice reuses the live job rather than starting a second run", async () => {
    // The steal-scoped gate leans on the enqueue dedupe for the double-click case, so hold that
    // line here: a second Force run while the first is still queued must return the same job.
    actAs("anton-test");
    const epic = await beads.create(repo, { title: "Double force", type: "epic" });
    const child = await beads.create(repo, { title: "Double force child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    const first = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    const second = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(second.status).toBe(200);
    expect((await second.json()).jobId).toBe((await first.json()).jobId);
    expect(await executeEpicJobs(epic)).toHaveLength(1);
  }, 60_000);

  it("422s a child ticket of an epic, points at its parent, and does not approve it", async () => {
    // A task WITH a parent runs via its epic's PR, never standalone — approving it must be rejected.
    const parentEpic = await beads.create(repo, { title: "Parent epic", type: "epic" });
    const child = await beads.create(repo, { title: "Child ticket", type: "task" });
    await beads.link(repo, child, parentEpic, "parent-child");
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", child));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/child ticket/i);
    expect(body.error).toContain(parentEpic); // guidance names the epic to approve instead
    expect(beads.isApproved(await beads.show(repo, child))).toBe(false);
  }, 60_000);

  it("422s a non-work type (molecule) with an honest error and does not approve it", async () => {
    // `beads.create` only makes epic/task/bug; a non-work type needs the raw CLI.
    const out = execFileSync("bd", ["create", "A molecule", "--type", "molecule", "--json"], {
      cwd: repo,
      encoding: "utf8",
    });
    const molecule = JSON.parse(out).id as string;
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", molecule));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not runnable/i);
    expect(beads.isApproved(await beads.show(repo, molecule))).toBe(false);
  }, 60_000);

  it("409s a run target claimed by another operator, without approving it", async () => {
    // A teammate's claim is a soft-lock: approving would silently run their reservation. The route
    // reads the fresh bead (assignee set by another operator) and refuses without an explicit steal.
    const epic = await beads.create(repo, { title: "Claimed by teammate", type: "epic" });
    const child = await beads.create(repo, { title: "Claimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("someone-else");
    expect(body.owner).toBe("someone-else");
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(false);
  }, 60_000);

  it("steals a teammate's claim on approve when { steal: true } is passed", async () => {
    // Stealing is the explicit override: it reassigns the claim to the approver and approves.
    const epic = await beads.create(repo, { title: "Stolen on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Stolen epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");

    const res = await POST(
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ steal: true }),
        headers: { "content-type": "application/json" },
      }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  }, 60_000);

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
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ steal: true }),
        headers: { "content-type": "application/json" },
      }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("someone-else");
    expect(body.stage).toBe("implementing");
    // The reservation stays with its owner and no run is enqueued under the would-be stealer.
    expect((await beads.show(repo, epic)).assignee).toBe("someone-else");
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  }, 60_000);

  it("409s a steal when the owner's run starts between the stage gate and the claim swap", async () => {
    // The pre-lock stage gate can read backlog, then the owner's runner starts before the CAS:
    // it moves the bead to stage:implementing but leaves the assignee as the old owner, so a swap
    // matching on assignee alone would reassign a live run to the approver. The route re-derives the
    // stage under the claim lock to reject exactly that window. Simulate it by returning the backlog
    // snapshot for the pre-lock read, then tagging the bead implementing before the under-lock read.
    const epic = await beads.create(repo, { title: "Racing take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Racing take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "someone-else");
    await beads.approve(repo, epic); // approved + backlog, owned by a teammate

    const realShow = beads.show.bind(beads);
    let raced = false;
    const spy = vi.spyOn(beads, "show").mockImplementation(async (cwd, id) => {
      const bead = await realShow(cwd, id);
      if (id === epic && !raced) {
        raced = true; // first read (the pre-lock gate) sees backlog; the runner then "starts"
        await beads.tag(repo, epic, ["stage:implementing"]);
      }
      return bead;
    });

    actAs("anton-test");
    try {
      const res = await POST(
        new Request("http://t/", {
          method: "POST",
          body: JSON.stringify({ steal: true }),
          headers: { "content-type": "application/json" },
        }),
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
  }, 60_000);

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
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ steal: true }),
        headers: { "content-type": "application/json" },
      }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    // The reservation transfers to the new owner…
    expect((await beads.show(repo, epic)).assignee).toBe("anton-test");
    // …and no run is enqueued (a take-over suppresses the run despite the open blocker).
    expect((await res.json()).jobId).toBeUndefined();
    expect(await executeEpicJobs(epic)).toHaveLength(0);
  }, 60_000);

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
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ steal: true }),
        headers: { "content-type": "application/json" },
      }),
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
  }, 60_000);

  it("does not enqueue a second local job when taking over a ready target this instance already runs", async () => {
    // The same-instance counterpart: this instance already has an active job for the epic (a normal
    // approval enqueued it here). A take-over must reuse that job — reassigning the reservation, not
    // spawning a duplicate — since operator identity is machine-scoped and the existing job will run
    // under whoever holds the epic. `enqueueExecuteEpicIfAbsent` returns no new id when a job exists.
    const epic = await beads.create(repo, { title: "Same-instance take-over", type: "epic" });
    const child = await beads.create(repo, { title: "Same-instance take-over child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    actAs("bob");
    expect((await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic))).status).toBe(200);
    const first = await executeEpicJobs(epic);
    expect(first).toHaveLength(1);

    actAs("alice");
    const res = await POST(
      new Request("http://t/", { method: "POST", body: JSON.stringify({ steal: true }) }),
      ctx("approvy", epic),
    );
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epic)).assignee).toBe("alice");
    // The existing job is reused — no new id, still exactly one job for the epic.
    expect((await res.json()).jobId).toBeUndefined();
    expect(await executeEpicJobs(epic)).toHaveLength(1);
    // Restore the default operator the following (actAs-less) tests rely on.
    actAs("anton-test");
  }, 60_000);

  it("auto-claims an unclaimed run target for the approver before enqueuing", async () => {
    // Closing the gap before the runtime execution-claim: approving an unclaimed target sets the
    // approver as assignee, so a teammate can't land a claim between approve and the runner.
    const epic = await beads.create(repo, { title: "Unclaimed on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Unclaimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  }, 60_000);

  it("approves an item already claimed by the requesting operator unchanged", async () => {
    // Re-approving your own claim is idempotent — no steal needed, assignee stays yours.
    const epic = await beads.create(repo, { title: "Self-claimed on approve", type: "epic" });
    const child = await beads.create(repo, { title: "Self-claimed epic child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
    await beads.assign(repo, epic, "anton-test");

    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(200);
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
  }, 60_000);

  it("404s an unknown bead id without approving anything", async () => {
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", "approvy-nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  }, 60_000);

  it("404s with {error} for an unknown slug", async () => {
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("nope", blocked));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
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
    const res = await POST(new Request("http://t/", { method: "POST" }), ctx("approvy", epic));
    expect(res.status).toBe(200);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run
    expect(errSpy).toHaveBeenCalled(); // the failed push was logged, not silently swallowed

    syncSpy.mockRestore();
    errSpy.mockRestore();

    // The approve write landed locally regardless of the failed push.
    expect(beads.isApproved(await beads.show(repo, epic))).toBe(true);
  }, 60_000);
});
