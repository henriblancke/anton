/**
 * Cross-machine double-run guard (anton-jz1). The machine-local `jobs` table can't stop machine B
 * from force-running an epic already running on machine A — its dedupe sees only B's own store. The
 * fix reads run-liveness from the SHARED beads board (a `run-lease:<expiry>` label) at enqueue.
 *
 * This test models exactly that: TWO job stores (two anton.db instances = two machines) over ONE
 * shared bead board (one real bd repo), asserting a single live run. Skipped when `bd`/`git` are
 * absent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { JobRunner } from "./runner";
import { systemClock } from "./queue";
import { beads } from "../beads/bd";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("bd") && has("git") ? describe : describe.skip;

let workDir: string;
let repo: string;
let epic: string;

/** A runner over its own store but pointed at the one shared board for liveness (anton-jz1). */
function machine(store: TestDb): JobRunner {
  store.db.insert(schema.projects).values({ id: "p1", slug: "p1", name: "p1", repoPath: repo }).run();
  return new JobRunner({
    db: store.db,
    clock: systemClock,
    liveRunCheck: async (_projectId, epicBeadId) =>
      beads.isRunLive(await beads.show(repo, epicBeadId), Date.now()),
  });
}

function executeEpicJobs(store: TestDb) {
  return store.db.select().from(schema.jobs).all().filter((j) => j.type === "execute-epic");
}

suite("cross-machine execute-epic dedupe over a shared board (anton-jz1)", () => {
  let A: TestDb;
  let B: TestDb;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-xmachine-"));
    repo = join(workDir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

    epic = await beads.create(repo, { title: "Shared epic", type: "epic" });
    const child = await beads.create(repo, { title: "Child", type: "task" });
    await beads.link(repo, child, epic, "parent-child");
  }, 60_000);

  afterEach(async () => {
    A?.close();
    B?.close();
    // Reset the shared board's lease so each test starts from a known (not-live) baseline.
    await beads.clearRunLease(repo, epic, beads.runLeaseLabels(await beads.show(repo, epic)));
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("machine B does not start a second run while a run is live on machine A", async () => {
    A = makeTestDb();
    B = makeTestDb();
    const rA = machine(A);
    const rB = machine(B);

    // Machine A starts a run: a job in A's store + a fresh run-lease published to the shared board
    // (what execute-epic does on start). The lease is the cross-machine "a run is live" signal.
    const jobA = await rA.enqueueExecuteEpic("p1", epic);
    expect(jobA).toBeTruthy();
    await beads.publishRunLease(repo, epic, Date.now() + 15 * 60_000);

    // Machine B force-runs the same epic. Its store has no job for the epic, but the shared board
    // shows A's live run, so B must NOT enqueue a second one.
    const jobB = await rB.enqueueExecuteEpic("p1", epic);
    expect(jobB).toBeUndefined();
    expect(executeEpicJobs(B)).toHaveLength(0);
    // A still owns its single live run.
    expect(executeEpicJobs(A)).toHaveLength(1);
  }, 60_000);

  it("machine A's own force run dedupes to its existing job despite the shared lease", async () => {
    A = makeTestDb();
    const rA = machine(A);

    const jobA = await rA.enqueueExecuteEpic("p1", epic);
    await beads.publishRunLease(repo, epic, Date.now() + 15 * 60_000);

    // A re-triggering its own live run returns the existing job (local dedupe wins before the
    // shared check), never a second row.
    const again = await rA.enqueueExecuteEpic("p1", epic);
    expect(again).toBe(jobA);
    expect(executeEpicJobs(A)).toHaveLength(1);
  }, 60_000);

  it("re-triggers once the prior run settles (lease cleared) — parked/failed/finished", async () => {
    B = makeTestDb();
    const rB = machine(B);

    // A run settled and cleared its lease on the way out (execute-epic's finally). With no live
    // lease on the board, machine B's force run starts a fresh run.
    await beads.clearRunLease(repo, epic, beads.runLeaseLabels(await beads.show(repo, epic)));
    expect(beads.isRunLive(await beads.show(repo, epic), Date.now())).toBe(false);

    const jobB = await rB.enqueueExecuteEpic("p1", epic);
    expect(jobB).toBeTruthy();
    expect(executeEpicJobs(B)).toHaveLength(1);
  }, 60_000);

  it("re-triggers when the lease has gone stale (a crashed machine stops refreshing)", async () => {
    B = makeTestDb();
    const rB = machine(B);

    // A machine that crashed mid-run leaves an EXPIRED lease behind (it stopped heartbeating).
    // That must read as not-live so the epic is re-triggerable — a stuck lease can't wedge it.
    await beads.publishRunLease(repo, epic, Date.now() - 1_000);
    expect(beads.isRunLive(await beads.show(repo, epic), Date.now())).toBe(false);

    const jobB = await rB.enqueueExecuteEpic("p1", epic);
    expect(jobB).toBeTruthy();
    expect(executeEpicJobs(B)).toHaveLength(1);

    // Cleanup the stale lease so it doesn't leak into other assertions on the shared board.
    await beads.clearRunLease(repo, epic, beads.runLeaseLabels(await beads.show(repo, epic)));
  }, 60_000);
});
