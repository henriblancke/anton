/**
 * The re-judgement pass on the patrol's cadence (anton-30vo), against REAL bd.
 *
 * Two claims, and the first is the one that decides whether this is worth having on a schedule at
 * all: a HEALTHY board produces NO proposals and the pass still succeeds. A pass that treated "found
 * nothing" as a failure to find something would go red every night on exactly the board anton is
 * trying to produce — so the empty result is asserted as an outcome, not just as an absence.
 *
 * The second is that the ask appears at all once a bead has been parked past the window, through the
 * patrol's ordinary judgment tier: one proposal, the parked bead itself untouched, and a second
 * patrol over the same board silent again.
 *
 * The fixture is deliberately boring — well-formed beads, no close-eligible epic, no commits naming
 * open work — so the first pass's silence is the board's property and not luck.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";
import { beads, type Bead } from "../beads/bd";
import { contractGaps } from "../beads/contract";
import { resetIssueSnapshots } from "../beads/snapshot";
import { REJUDGE_DEFERRED_DAYS } from "../gardener/detect";
import { isProposalBead } from "../gardener/detections";
import { makeGardenerHandler } from "./gardener";
import type { Clock } from "./queue";

describeBd("gardener re-judgement e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestProjectDb;
  let projectId: string;
  let restoreEnv: () => void;
  const clock: Clock = { now: () => Date.now() };
  const nudge = vi.fn();

  /** The live work the healthy board is made of — a card and the ticket under it. */
  let card: string;
  let ticket: string;
  /** Parked long before the window and untouched since — the one bead the re-judgement asks about. */
  let park: string;

  const board = (): Promise<Bead[]> => beads.list(repo, ["--status", "all"]);
  const proposals = async (): Promise<Bead[]> => (await board()).filter(isProposalBead);

  /** One patrol, driven to settlement; returns its settled job row. */
  const patrol = async () => {
    const jobId = await driveJob({
      db: tdb.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
      projectId,
    });
    return expectJobStatus(tdb.db, jobId, "done");
  };

  let healthy: Awaited<ReturnType<typeof patrol>>;
  /** What the healthy board carried, and what it propagated — both read before anything is parked. */
  let healthyProposals: Bead[];
  let healthyNudges: number;
  let afterPark: Awaited<ReturnType<typeof patrol>>;
  let filed: Bead[];

  beforeAll(async () => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;
    restoreEnv = saveEnv(["ANTON_SESSIONS_ROOT"]);
    process.env.ANTON_SESSIONS_ROOT = join(repoDir.dir, "sessions");

    card = await beads.create(repo, {
      title: "the feature that is being built",
      type: "feature",
      acceptance: "- [ ] it works",
    });
    ticket = await beads.create(repo, {
      title: "the ticket under it",
      type: "task",
      acceptance: "- [ ] it is done",
      deps: [`parent-child:${card}`],
    });

    tdb = makeProjectDb({ repoPath: repo });
    projectId = tdb.projectId;

    healthy = await patrol();
    healthyProposals = await proposals();
    healthyNudges = nudge.mock.calls.length;

    // Parking is a clock property, and a bead deferred now would be a decision made this second, so
    // the only way to seed a quarter of silence is to import one carrying an old `updated_at`
    // (mirrors the stale seeds in gardener.integration.test.ts).
    const prefix = ticket.slice(0, ticket.lastIndexOf("-"));
    park = `${prefix}-park`;
    const parkedAt = new Date(Date.now() - (REJUDGE_DEFERRED_DAYS + 30) * 86_400_000).toISOString();
    const jsonl = join(repoDir.dir, "parked.jsonl");
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        _type: "issue",
        id: park,
        title: "the idea that was parked",
        description: "## Acceptance Criteria\n\n- [ ] it is still wanted",
        status: "deferred",
        issue_type: "task",
        priority: 2,
        created_at: parkedAt,
        updated_at: parkedAt,
      })}\n`,
    );
    execFileSync("bd", ["import", jsonl], { cwd: repo, stdio: "ignore" });

    afterPark = await patrol();
    filed = await proposals();

    // A third patrol over the same board: the claim is still true, so its own fingerprint is what
    // must keep it quiet.
    await patrol();
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    restoreEnv?.();
    repoDir.cleanup();
  });

  it("files nothing on a healthy board, and calls that a successful pass", async () => {
    expect(healthy.status).toBe("done");
    expect(healthy.outcome).toBe("noop");
    expect(healthy.outcomeNote).toBe("board clean");
    expect(healthyProposals).toEqual([]);
    // Nothing to propagate either: a clean board is the quietest thing on the remote.
    expect(healthyNudges).toBe(0);
  });

  it("asks about the bead parked past the window — one ask, on the patrol's own cadence", () => {
    expect(filed).toHaveLength(1);
    const [proposal] = filed;
    expect(proposal.labels?.some((l) => l.startsWith("gardener:aged-defer:"))).toBe(true);
    expect(proposal.title).toContain(park);
    expect(proposal.status).toBe("open");
    // bd round-trips the whole contract, so the board renders the ask like any other bead.
    expect(contractGaps([proposal], "blocking")).toEqual([]);
    // Provenance: the ask is reachable from the bead it is about.
    expect(beads.edgesOf([proposal])).toContainEqual({
      from: proposal.id,
      to: park,
      type: "discovered-from",
    });
    // And the pass says it asked, rather than reporting the silence a clean board earns.
    expect(afterPark.outcome).toBe("ok");
    expect(afterPark.outcomeNote).toContain("filed 1 proposal(s)");
  });

  it("leaves the parked bead parked: returning it is the approver's move", async () => {
    const after = await board();
    expect(after.find((b) => b.id === park)?.status).toBe("deferred");
    expect(after.find((b) => b.id === card)?.status).toBe("open");
    expect(after.find((b) => b.id === ticket)?.status).toBe("open");
  });

  it("asks once: a third patrol over the same board files no second ask", async () => {
    expect((await proposals()).map((p) => p.id)).toEqual(filed.map((p) => p.id));
  });
});
