/**
 * End-to-end proof of the product-master pass's acceptance (anton-d2sx): the REAL handler, driven by
 * a REAL JobRunner, against REAL bd on a seeded fixture board. Skipped without bd/git.
 *
 * The claude session is the one thing stubbed — a canned report standing in for the judgment, which
 * is exactly the part a test cannot pin anyway. Everything downstream of it is real, and that is
 * what a founder actually needs proven:
 *
 *   1. each accepted claim becomes a REAL BEAD — bd round-trips its contract, its `pm:` fingerprint
 *      and its `discovered-from` provenance;
 *   2. NOTHING ELSE ON THE BOARD MOVED. The pass sees stale, low-scored and mis-ranked work and is
 *      entitled to touch none of it: the board is snapshotted before and after and compared bead by
 *      bead. That assertion is the whole safety case for arming this job;
 *   3. a healthy board yields ZERO proposals — the pass has no noise floor;
 *   4. the pass asks ONCE, and a DECLINE is permanent: an abandoned proposal keeps its fingerprint,
 *      and that is the memory a later pass reads;
 *   5. APPROVING a kill actually writes: `applyProposal` — the function the approve route calls —
 *      defers the subject against real bd and settles the ask. The one pm kind that changes board
 *      state has to be proven end to end, not just through the mocked bd seam.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads, type Bead } from "../beads/bd";
import type { ClaudeResult } from "../claude/driver";
import { contractGaps } from "../beads/contract";
import { loadAllIssues } from "../beads/issues";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { applyProposal } from "../gardener/apply";
import { isProposalBead, proposalPlanOf } from "../gardener/detections";
import { makeProductMasterHandler } from "./product-master";
import type { Clock } from "./queue";

describeBd("product-master pass e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let projectId: string;
  const clock: Clock = { now: () => 1_700_000_000_000 };
  const nudge = vi.fn();

  /** Untouched, low-scored work — the kill candidate. */
  let dying: string;
  /** A P4 bead that blocks a P0 one — the ranking candidate. */
  let misranked: string;
  /** A ticket carrying several concerns — the split candidate. */
  let oversized: string;
  /** Healthy work the pass has no claim about; it must come out of every pass unchanged. */
  let healthy: string;
  /**
   * The subject of the kill this suite APPLIES at the end. Seeded here rather than in that test so
   * bd's write stamp on it predates the pass that files the ask by more than a second: the evidence
   * fence orders the two, and stamps landing in the same whole second cannot be ordered at all.
   */
  let doomed: string;
  /**
   * The misfiled trio (anton-02po), seeded for the same stamp reason as {@link doomed}: a ticket
   * riding the card that does NOT run its surface, and the card that does. Both are real board
   * cards, which is exactly what the gardener's re-parents refuse — a home that is wrong rather
   * than missing is the product master's claim to make.
   */
  let wrongCard: string;
  let rightCard: string;
  let misfiled: string;

  /** What the stubbed session reports this pass — set per phase. */
  let reported = `{"proposals":[]}`;
  const fakeClaude = async (): Promise<ClaudeResult> =>
    ({ ok: true, text: `Judgment:\n\n\`\`\`json\n${reported}\n\`\`\`` }) as ClaudeResult;

  /** id → status for every bead on the board — the "nothing else moved" comparison. */
  const boardStatuses = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await beads.list(repo, ["--status", "all"])).map((b) => [b.id, b.status ?? ""]),
    );

  const proposals = async (): Promise<Bead[]> =>
    (await beads.list(repo, ["--status", "all"])).filter(isProposalBead);

  /** One pass, driven to settlement. */
  const pass = async (at: Clock = clock): Promise<string> => {
    const jobId = await driveJob({
      db: tdb.db,
      clock: at,
      type: "product-master",
      handler: ({ db, clock: c }) =>
        makeProductMasterHandler({ db, clock: c, nudge, runClaude: fakeClaude }),
      projectId,
    });
    await expectJobStatus(tdb.db, jobId, "done");
    return jobId;
  };

  let before: Record<string, string>;
  let filed: Bead[];

  beforeAll(async () => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;

    dying = await beads.create(repo, {
      title: "speculative export pipeline",
      type: "task",
      acceptance: "- [ ] exports something",
      labels: ["review-score:3"],
    });
    misranked = await beads.create(repo, {
      title: "auth token refresh",
      type: "task",
      acceptance: "- [ ] refreshes",
    });
    oversized = await beads.create(repo, {
      title: "rewrite billing, reporting and the admin UI",
      type: "task",
      acceptance: "- [ ] all three",
      labels: ["size:L"],
    });
    healthy = await beads.create(repo, {
      title: "a perfectly ordinary ticket",
      type: "task",
      acceptance: "- [ ] does its one thing",
    });
    doomed = await beads.create(repo, {
      title: "a half-built importer nobody asked for",
      type: "task",
      acceptance: "- [ ] imports something",
      labels: ["review-score:2"],
    });

    wrongCard = await beads.create(repo, {
      title: "reporting exports",
      type: "feature",
      acceptance: "- [ ] exports report data",
    });
    rightCard = await beads.create(repo, {
      title: "billing invoices",
      type: "feature",
      acceptance: "- [ ] renders invoices",
    });
    misfiled = await beads.create(repo, {
      title: "invoice line-item rounding",
      type: "task",
      acceptance: "- [ ] rounds line items",
    });
    await beads.reparent(repo, misfiled, wrongCard);

    tdb = makeTestDb();
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });

    before = await boardStatuses();

    reported = JSON.stringify({
      proposals: [
        {
          kind: "kill",
          bead: dying,
          summary: "no evidence this is still wanted",
          evidence: [`${dying} scored 3 on its only review and nothing depends on it`],
        },
        {
          kind: "reprioritize",
          bead: misranked,
          priority: "P0",
          summary: "it gates the work above it",
          evidence: [`${misranked} sits at P2 while the beads it unblocks are P0`],
        },
        {
          kind: "split",
          bead: oversized,
          pieces: ["billing rewrite", "reporting rewrite", "admin UI rewrite"],
          summary: "three unrelated concerns in one contract",
          evidence: [`${oversized} is size:L and names three surfaces`],
        },
      ],
    });
    await pass();
    filed = await proposals();

    // A second pass reporting exactly the same judgment: the fingerprints it filed are what must
    // keep it quiet.
    await pass();
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    repoDir.cleanup();
  });

  it("files one proposal per claim, each a real bead bd round-trips whole", async () => {
    expect(filed).toHaveLength(3);
    for (const proposal of filed) {
      expect(proposal.status).toBe("open");
      expect(contractGaps([proposal], "blocking")).toEqual([]);
      expect(contractGaps([proposal], "advisory")).toEqual([]);
      expect(proposal.title).toMatch(/^Product master: /);
    }
  });

  it("fingerprints each claim in the pm namespace, keyed to the bead and the move", () => {
    const byKind = Object.fromEntries(
      filed.map((p) => [proposalPlanOf(p)?.kind, proposalPlanOf(p)]),
    );
    expect(Object.keys(byKind).sort()).toEqual(["low-value", "mispriority", "oversized"]);
    expect(byKind["low-value"]).toMatchObject({ move: "retire", retireAs: "defer", subjects: [dying] });
    expect(byKind["mispriority"]).toMatchObject({ move: "reprioritize", detail: "P0" });
    expect(byKind["oversized"]).toMatchObject({ move: "split", subjects: [oversized] });
    for (const proposal of filed) {
      expect(proposal.labels?.some((l) => /^pm:[a-z-]+:[0-9a-f]{12}$/.test(l))).toBe(true);
      expect(proposal.labels).toContain("source:pm");
    }
  });

  it("carries its evidence and the split's decomposition sketch onto the bead", () => {
    const split = filed.find((p) => proposalPlanOf(p)?.kind === "oversized") as Bead;
    expect(split.description).toContain("three surfaces");
    for (const piece of ["billing rewrite", "reporting rewrite", "admin UI rewrite"]) {
      expect(split.description).toContain(piece);
    }
    // Approve is refused for a split, so the bead has to say declining is what settles it.
    expect(split.description).toMatch(/Approve is refused/);
  });

  it("hangs provenance off the bead each proposal is about", async () => {
    for (const proposal of filed) {
      const subject = proposalPlanOf(proposal)?.subjects[0] as string;
      expect(beads.edgesOf([proposal])).toContainEqual({
        from: proposal.id,
        to: subject,
        type: "discovered-from",
      });
    }
  });

  it("mutates NOTHING on the board: the only ids it added are its own proposals", async () => {
    const after = await boardStatuses();
    const added = Object.keys(after).filter((id) => !(id in before));
    expect(added.sort()).toEqual((await proposals()).map((p) => p.id).sort());
    for (const [id, status] of Object.entries(after)) {
      if (added.includes(id)) continue;
      expect({ id, status }).toEqual({ id, status: before[id] });
    }
    // Named explicitly — these are exactly the beads the pass had a proposal ABOUT.
    const live = await beads.list(repo, ["--status", "all"]);
    const byId = new Map(live.map((b) => [b.id, b]));
    expect(byId.get(dying)?.status).toBe("open");
    expect(beads.isDeferred(byId.get(dying) as Bead)).toBe(false);
    // The priority the pass wanted is a PROPOSAL, not a write.
    expect(byId.get(misranked)?.priority).toBe(byId.get(healthy)?.priority);
  });

  it("nudges the sync coalescer, because it filed beads other machines have to see", () => {
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: repo });
  });

  it("asks once: a second pass reporting the same judgment files nothing new", async () => {
    expect((await proposals()).map((p) => p.id).sort()).toEqual(filed.map((p) => p.id).sort());
  });

  it("stays quiet once a human declines: the abandoned bead IS the memory", async () => {
    const declined = filed[0];
    await beads.abandon(repo, declined.id, "not a priority for us");
    expect(beads.isAbandoned(await beads.show(repo, declined.id))).toBe(true);

    await pass();

    const now = await proposals();
    expect(now.map((p) => p.id).sort()).toEqual(filed.map((p) => p.id).sort());
    // Specifically: the declined claim was NOT re-filed under a fresh id.
    expect(now.filter((p) => p.status !== "closed")).toHaveLength(filed.length - 1);
  });

  it("files zero proposals when the pass judges the board healthy", async () => {
    reported = `{"proposals":[]}`;
    const standing = (await proposals()).map((p) => p.id).sort();

    await pass();

    expect((await proposals()).map((p) => p.id).sort()).toEqual(standing);
  });

  /**
   * The other half of the acceptance: a kill is the one pm kind that WRITES board state, and until
   * here nothing proved that write lands against real bd. `applyProposal` is the same function the
   * approve route calls; the route around it only maps failures to HTTP statuses.
   */
  it("applies an approved kill through the 1t3n verbs: deferred, never closed", async () => {
    reported = JSON.stringify({
      proposals: [
        {
          kind: "kill",
          bead: doomed,
          summary: "nothing downstream wants this",
          evidence: [`${doomed} scored 2 and nothing depends on it`],
        },
      ],
    });
    // Real time, unlike the frozen clock the rest of the suite runs on: the evidence fence dates the
    // filing against bd's own stamps, and a 2023 filing over a bead bd stamped today would read as
    // work rewritten since the ask and refuse it.
    await pass({ now: () => Date.now() });

    const proposal = (await proposals()).find(
      (p) => proposalPlanOf(p)?.subjects[0] === doomed,
    ) as Bead;
    expect(proposalPlanOf(proposal)).toMatchObject({ kind: "low-value", retireAs: "defer" });

    const result = await applyProposal(repo, proposal, await loadAllIssues(repo), "approval");
    expect(result.changed).toEqual([doomed]);

    // Deferred, not closed: a product judgment must stay reversible with `bd undefer`.
    const subject = await beads.show(repo, doomed);
    expect(beads.isDeferred(subject)).toBe(true);
    expect(subject.status).not.toBe("closed");
    expect(beads.isAbandoned(subject)).toBe(false);

    // Applied, not declined — the distinction a later pass reads to know the ask was answered.
    const settled = await beads.show(repo, proposal.id);
    expect(settled.status).toBe("closed");
    expect(beads.isAbandoned(settled)).toBe(false);
  });

  /**
   * The home claim end to end (anton-02po). Its subject already rides a real board card — the state
   * both gardener re-parents refuse to touch — so this is the only path by which anton can move work
   * that has a home into a better one, and the only proof the whole chain (claim → refusals →
   * fingerprint → bead → evidence fence → `bd update --parent`) actually lands against real bd.
   */
  it("applies an approved home claim: the parent really moves on the board", async () => {
    reported = JSON.stringify({
      proposals: [
        {
          kind: "rehome",
          bead: misfiled,
          home: rightCard,
          summary: "it is invoice work filed under the reporting card",
          evidence: [
            `${misfiled}'s Acceptance is about invoice line items, which is ${rightCard}'s contract`,
            `${wrongCard} carries reporting exports and names no invoice surface`,
          ],
        },
      ],
    });
    // Real time, like the kill above: the evidence fence dates the filing against bd's own stamps.
    await pass({ now: () => Date.now() });

    const proposal = (await proposals()).find(
      (p) => proposalPlanOf(p)?.kind === "misfiled",
    ) as Bead;
    expect(proposalPlanOf(proposal)).toMatchObject({
      kind: "misfiled",
      move: "reparent",
      subjects: [misfiled],
      target: rightCard,
    });
    expect(proposal.labels?.some((l) => /^pm:misfiled:[0-9a-f]{12}$/.test(l))).toBe(true);
    expect(contractGaps([proposal], "blocking")).toEqual([]);
    expect(proposal.title).toBe(`Product master: re-parent ${misfiled} under ${rightCard}`);
    // Provenance hangs off BOTH beads the move concerns, not just the one it writes to.
    const edges = beads.edgesOf([proposal]);
    for (const to of [misfiled, rightCard]) {
      expect(edges).toContainEqual({ from: proposal.id, to, type: "discovered-from" });
    }
    // Still a proposal, not a write: nothing moved until the founder approved it.
    expect(beads.parentOf(await beads.show(repo, misfiled))).toBe(wrongCard);

    const result = await applyProposal(repo, proposal, await loadAllIssues(repo), "approval");
    expect(result.changed).toEqual([misfiled]);

    expect(beads.parentOf(await beads.show(repo, misfiled))).toBe(rightCard);
    const settled = await beads.show(repo, proposal.id);
    expect(settled.status).toBe("closed");
    expect(beads.isAbandoned(settled)).toBe(false);
  });

  it("refuses a claim about a bead that is not there, rather than filing an ask that can only fail", async () => {
    reported = JSON.stringify({
      proposals: [
        {
          kind: "kill",
          bead: "anton-does-not-exist",
          summary: "kill the imaginary bead",
          evidence: ["it does not exist"],
        },
      ],
    });
    const standing = (await proposals()).map((p) => p.id).sort();

    await pass();

    expect((await proposals()).map((p) => p.id).sort()).toEqual(standing);
  });
});
