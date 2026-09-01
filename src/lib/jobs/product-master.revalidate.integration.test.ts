/**
 * End-to-end proof of post-approval re-validation (anton-xg5y): the REAL product-master handler,
 * driven by a REAL JobRunner, against REAL bd — with the claude session stubbed to report NOTHING,
 * because this tier has no judgment in it at all.
 *
 * That stub is the point rather than a convenience. The pre-pass is deterministic: it re-runs the
 * approve gate's own validator over the board the pass already read, so a session that reports an
 * empty board must not stop approval rot from surfacing.
 *
 * What a founder needs proven, in order:
 *
 *   1. a SOUND approval is left alone — the pass has no noise floor here either;
 *   2. stripping the Acceptance off an approved target yields EXACTLY ONE proposal, carrying the
 *      specific violation as evidence, and the target is not silently unapproved or mutated;
 *   3. the ask is made ONCE — a second pass over the same rot files nothing;
 *   4. APPROVING it removes the `approved` label and NOTES WHY on the bead itself, so a target that
 *      drops out of the queue explains itself where a reader is looking;
 *   5. the check is CHEAP: three degraded targets cost exactly the reads one does, because the
 *      re-check reuses the pass's board snapshot instead of spawning `bd` per bead.
 *
 * Applying goes through `applyProposal` — the same function the approve route calls on a proposal
 * bead; the route around it only maps failures to HTTP statuses.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads, LABELS, type Bead } from "../beads/bd";
import { contractGaps } from "../beads/contract";
import { loadAllIssues } from "../beads/issues";
import { resetIssueSnapshots } from "../beads/snapshot";
import type { ClaudeResult } from "../claude/driver";
import { applyProposal } from "../gardener/apply";
import { isProposalBead, proposalPlanOf } from "../gardener/detections";
import { makeProductMasterHandler } from "./product-master";
import type { Clock } from "./queue";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

/** A complete ticket contract, as the ticket dialog keeps it: every section in the description. */
const contract = (acceptance: boolean): string =>
  [
    "## Goal",
    "keep the queue honest",
    ...(acceptance ? ["", "## Acceptance", "- [ ] the queue is honest"] : []),
    "",
    "## Context",
    "src/lib/jobs",
    "",
    "## Out of scope",
    "everything else",
    "",
    "## Verify",
    "the suite is green",
  ].join("\n");

describeBd("post-approval re-validation e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestProjectDb;
  let projectId: string;
  const clock: Clock = { now: () => 1_700_000_000_000 };

  /** Approved work whose Acceptance gets edited away mid-suite — the rot this feature is about. */
  let rotting: string;
  /** Approved work that stays sound: it must come out of every pass untouched and unasked-about. */
  let sound: string;
  /** Two more degraded approvals, added late — the cost-per-bead measurement. */
  let extras: string[] = [];

  const fakeClaude = async (): Promise<ClaudeResult> =>
    ({ ok: true, text: `Nothing to report:\n\n\`\`\`json\n{"proposals":[]}\n\`\`\`` }) as ClaudeResult;

  const board = (): Promise<Bead[]> => loadAllIssues(repo);
  const show = (id: string): Promise<Bead> => beads.show(repo, id);

  /** Every degraded-approval ask standing on the board, whatever its status. */
  const asks = async (): Promise<Bead[]> =>
    (await beads.list(repo, ["--status", "all"]))
      .filter(isProposalBead)
      .filter((b) => proposalPlanOf(b)?.kind === "degraded-approval");

  /** One pass, driven to settlement — counting the bd READS it made along the way. */
  const pass = async (): Promise<{ lists: number; shows: number }> => {
    const lists = vi.spyOn(beads, "list");
    const shows = vi.spyOn(beads, "show");
    const withComments = vi.spyOn(beads, "showWithComments");
    try {
      const jobId = await driveJob({
        db: tdb.db,
        clock,
        type: "product-master",
        handler: ({ db, clock: c }) =>
          makeProductMasterHandler({ db, clock: c, nudge: vi.fn(), runClaude: fakeClaude }),
        projectId,
      });
      await expectJobStatus(tdb.db, jobId, "done");
      return {
        lists: lists.mock.calls.length,
        shows: shows.mock.calls.length + withComments.mock.calls.length,
      };
    } finally {
      lists.mockRestore();
      shows.mockRestore();
      withComments.mockRestore();
    }
  };

  /** An approved run target the gate is happy with. */
  const approvedTarget = async (title: string): Promise<string> => {
    const id = await beads.create(repo, { title, type: "task", description: contract(true) });
    await beads.approve(repo, id);
    return id;
  };

  /** Take the rubric away, exactly as an edit through the ticket dialog would. */
  const stripAcceptance = (id: string): Promise<void> =>
    beads.update(repo, id, { description: contract(false) });

  beforeAll(async () => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;

    rotting = await approvedTarget("export the ledger");
    sound = await approvedTarget("rotate the signing key");

    tdb = makeProjectDb({ repoPath: repo });
    projectId = tdb.projectId;
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    repoDir?.cleanup();
  });

  it("files nothing while every approval still holds", async () => {
    expect(contractGaps(await board(), "blocking")).toEqual([]);
    await pass();
    expect(await asks()).toEqual([]);
  });

  it("files exactly one proposal once an approved target loses its Acceptance", async () => {
    await stripAcceptance(rotting);
    // Precondition, stated rather than assumed: the approve gate would now refuse this target.
    expect(contractGaps([await show(rotting)], "blocking")).not.toEqual([]);

    await pass();

    const filed = await asks();
    expect(filed).toHaveLength(1);
    expect(proposalPlanOf(filed[0])).toMatchObject({ move: "unapprove", subjects: [rotting] });
    expect(filed[0].labels).toContain("source:pm");
    // The specific violation travels as evidence, not just "something is wrong".
    expect(filed[0].description).toMatch(/no Acceptance criteria/);
    expect(filed[0].description).toContain(rotting);

    // Never silently unapproved, and never silently repaired: the ask is the whole change.
    const subject = await show(rotting);
    expect(beads.isApproved(subject)).toBe(true);
    expect(subject.status).toBe("open");
    // …and the sound approval was not dragged into it.
    expect(beads.isApproved(await show(sound))).toBe(true);
  });

  it("asks once: a second pass over the same rot files nothing new", async () => {
    const standing = (await asks()).map((b) => b.id);
    await pass();
    expect((await asks()).map((b) => b.id)).toEqual(standing);
  });

  it("removes the approved label on approval, and notes why on the bead itself", async () => {
    const [proposal] = await asks();
    const result = await applyProposal(repo, proposal, await board(), "approval");
    expect(result.changed).toEqual([rotting]);

    const subject = await show(rotting);
    expect(beads.isApproved(subject)).toBe(false);
    expect(subject.labels ?? []).not.toContain(LABELS.approved);
    // The reason lives where a reader will be: on the bead that left the queue.
    expect(String(subject.notes ?? "")).toMatch(/approval withdrawn/);
    expect(String(subject.notes ?? "")).toMatch(/no Acceptance criteria/);
    // Nothing else about it moved — this move takes a label, not the work.
    expect(subject.status).toBe("open");
    expect(subject.description).toBe(contract(false));

    // The ask is settled, not abandoned: the board changed, so the check has nothing left to find.
    const settled = await show(proposal.id);
    expect(settled.status).toBe("closed");
    expect(beads.isAbandoned(settled)).toBe(false);
  });

  it("costs the same reads for three degraded approvals as for one", async () => {
    // Re-approving the bead whose Acceptance is still missing puts exactly one rotted approval back
    // on the board — the baseline this measures against.
    await beads.approve(repo, rotting);
    const one = await pass();
    expect((await asks()).filter((b) => b.status !== "closed")).toHaveLength(1);

    extras = [await approvedTarget("archive the exports"), await approvedTarget("purge the cache")];
    for (const id of extras) await stripAcceptance(id);

    const three = await pass();

    // Three asks standing — the pass really did have three times the work to judge…
    expect((await asks()).filter((b) => b.status !== "closed")).toHaveLength(3);
    // …and it paid for it with the SAME reads: the re-check runs off the snapshot the pass already
    // took, so its cost is one board read however many approvals are on the board.
    expect(three.lists).toBe(one.lists);
    expect(three.shows).toBe(one.shows);
    expect(three.shows).toBe(0);
  });
});
