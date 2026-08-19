/**
 * A full execute-epic run against a board anton believes lives on a shared Dolt server (anton-0tul):
 * the run must land byte-identically — worktree, per-ticket commits, PR, closes, claims — while
 * issuing not one `bd dolt pull/commit/push`. In server mode those calls reconcile nothing (every
 * writer is already on the one database) and they FAIL: the push executes ON the server, whose image
 * ships no ssh client or keys, so a `git+ssh://` remote is unreachable from there by construction.
 *
 * **How server mode is simulated, and why it has to be.** A real shared board needs a live
 * `dolt sql-server`, which neither this machine nor CI has — bd's embedded engine is in-process and
 * refuses `bd dolt start`/`test` outright. So the mode is simulated at ANTON's seam, using the two
 * caches the runtime already treats as fixed-for-the-process:
 *
 *   1. `.beads/metadata.json` is flipped to `dolt_mode: "server"` just long enough for
 *      `readBoardMode` to cache that verdict, then restored — so anton reads "server" for the whole
 *      file while bd keeps talking to the embedded board it actually has.
 *   2. `preflightSharedServer` is recorded through its injectable exec, standing in for the
 *      `bd dolt test` a reachable server would have answered.
 *
 * Both are public seams (`resetBoardModeCache` / `resetServerPreflight` undo them in `afterAll`),
 * and the property under test — does a run touch refs/dolt/data — is observed on the REAL bare
 * remote, not on a mock. Its embedded-mode mirror is in `execute-epic.lifecycle.integration.test.ts`,
 * which asserts the same run DOES publish `refs/dolt/data`.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beads, getSyncStatus, preflightSharedServer, resetServerPreflight } from "../beads/bd";
import { readBoardMode, resetBoardModeCache } from "../beads/board-mode";
import * as schema from "../db/schema";
import { getJob } from "./queue";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  createExecuteEpicSandbox,
  enqueueEpicJob,
  makeEpicRunner,
  resetPerCaseState,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

describeBd("execute-epic e2e — simulated server mode (real handler · real bd/git · fake claude/gh)", () => {
  let ctx: ExecuteEpicSandbox;
  let repo: string;
  let bare: string;

  /** Every ref on the bare remote — `refs/dolt/data` appears here only if a `bd dolt push` ran. */
  const remoteRefs = (): string =>
    execFileSync("git", ["-C", repo, "ls-remote", "origin"], { encoding: "utf8" });

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    repo = ctx.repo;
    bare = ctx.bare!;

    // Teach anton (only) that this board lives on a shared server — see the file header.
    const metadata = join(repo, ".beads", "metadata.json");
    const embedded = readFileSync(metadata, "utf8");
    writeFileSync(
      metadata,
      JSON.stringify({
        ...JSON.parse(embedded),
        dolt_mode: "server",
        dolt_server_host: "dolt.test.invalid",
        dolt_server_port: 3306,
        dolt_server_user: "beads",
      }),
    );
    resetBoardModeCache();
    expect(readBoardMode(repo).mode).toBe("server"); // the read that pins it for this process
    writeFileSync(metadata, embedded);

    // Stand in for the `bd dolt test` a reachable server answers, so the first pass doesn't reject.
    await preflightSharedServer(repo, async () => "");
  });

  afterAll(() => {
    resetBoardModeCache();
    resetServerPreflight();
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    ctx.clock.set(BASE_TIME_MS);
    await resetPerCaseState(ctx.tdb);
  });

  it("runs the epic to in-review without publishing refs/dolt/data", async () => {
    const { epicId, t1, t2, projectId, tdb } = ctx;
    // The remote starts with no Dolt data: nothing before this point synced, so the post-run check
    // below measures the run itself rather than an already-empty remote nobody could have filled.
    expect(remoteRefs()).not.toContain("refs/dolt/data");

    const runner = makeEpicRunner(ctx);
    const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epicId });
    expect(await tickToIdle(runner)).toBe(1);

    // The run landed exactly as it does on an embedded board — server mode changes propagation, not
    // the pipeline. (The lifecycle suite owns the full assertion set; these are the load-bearing few.)
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    const runs = await tdb.db.select().from(schema.runs);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(remoteRefs()).toContain(`refs/heads/anton/${epicId}`);

    // ...and it wrote plenty to the board while it did: claims, stage labels, closes. Those writes
    // are what a sync would have had to publish.
    const board = await beads.list(repo, ["--status", "all"]);
    expect(board.find((b) => b.id === t1)?.status).toBe("closed");
    expect(board.find((b) => b.id === t2)?.status).toBe("closed");
    const epic = await beads.show(repo, epicId);
    expect(beads.getPrRef(epic)).toBe("gh-42");
    expect(epic.labels ?? []).toContain("stage:in-review");

    // The point of the ticket: not one `bd dolt push` ran, so the git remote never gained the Dolt
    // channel a server-mode board does not use. Checked on the bare remote itself, not through bd.
    expect(remoteRefs()).not.toContain("refs/dolt/data");
    expect(
      execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }),
    ).not.toContain("refs/dolt/");

    // And the run's own sync calls settled as the terminal server-mode state rather than failing:
    // `beads.sync` is awaited on the critical path (lease publish, claim publish), so a rejection
    // here would have failed the run closed rather than merely logged.
    expect(getSyncStatus(repo)).toMatchObject({ state: "shared-server", unpushedCount: 0, lastError: null });
  });
});
