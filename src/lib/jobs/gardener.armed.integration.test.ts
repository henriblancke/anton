/**
 * Armed mode's two load-bearing claims, proved against REAL bd (anton-4ab3): a pass with a kind
 * armed at `apply` MAKES the move, and running it again does nothing at all.
 *
 * The unit suites pin the loop's shape with bd stubbed. Only a live board can prove the pair that
 * makes arming safe to ship: that `applyProposal` driven by a pass really moves the subject through
 * bd's own verbs — and that the second pass is a NO-OP, because the move it would ask for is already
 * on the board. A patrol that re-asked, or re-applied, would turn a nightly schedule into a machine
 * for churning the same bead forever.
 *
 * Only `shipped-orphan` is armed. Every other kind stays at `propose`, so whatever else this fixture
 * yields is filed and left alone — which is also the shape an operator arms in real life: one kind
 * they trust, not the whole policy.
 *
 * Arming it takes two things, not one (anton-m29g): the setting, and a record. The fixture seeds the
 * kind's settled proposals on the real board below, because the earned floor is derived from the
 * board the pass itself reads — an operator who flips the setting on a kind the founder has never
 * accepted an ask from gets `propose`, and this suite would prove nothing about the armed walk.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  describeBd,
  makeBdRepo,
  nextBdSecond,
  saveEnv,
  type BdRepo,
} from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads, type Bead } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { appliedCloseReason } from "../gardener/apply";
import { EARNED_AUTONOMY_BARS, earnedAutonomyOfKind } from "../gardener/autonomy";
import { isProposalBead, proposalFingerprint } from "../gardener/detections";
import { proposalTrackRecord } from "../gardener/track-record";
import { makeGardenerHandler } from "./gardener";
import type { Clock } from "./queue";

describeBd("gardener armed pass e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let projectId: string;
  let restoreEnv: () => void;
  const clock: Clock = { now: () => Date.now() };
  const nudge = vi.fn();

  /** Named by a commit and still open — the shipped-orphan ask, and the one kind armed here. */
  let shipped: string;

  /** Every bead on the board, serialized whole — the "nothing moved" comparison. */
  const boardBytes = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await beads.list(repo, ["--status", "all"])).map((b) => [b.id, JSON.stringify(b)]),
    );

  const proposals = async (): Promise<Bead[]> =>
    (await beads.list(repo, ["--status", "all"])).filter(isProposalBead);

  /** The session log of the pass that opened session row `n` (0-based, in creation order). */
  const logOf = async (n: number): Promise<string> => {
    const rows = await tdb.db.select().from(schema.sessions);
    const path = rows[n]?.logPath;
    return path ? readFileSync(path, "utf8") : "";
  };

  let afterFirst: Record<string, string>;
  let afterSecond: Record<string, string>;
  let filed: Bead[];

  const runPatrol = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
      projectId,
    });

  /**
   * The record that has EARNED `shipped-orphan` its arming (anton-m29g): the founder's own accepted
   * asks, on the real board, closed through the very builder `applyProposal` closes an approved
   * proposal with.
   *
   * Real beads rather than a stub, because the floor reads the board this pass reads — a seed that
   * only looked settled would leave the kind at `propose` and every assertion below chasing a
   * missing apply. Each carries its own fingerprint, so none folds into another or into the ask the
   * patrol is about to file; all are applied, clearing the `history` tier's percentage outright.
   */
  const earnShippedOrphan = async (): Promise<void> => {
    const ids: string[] = [];
    for (let i = 0; i < EARNED_AUTONOMY_BARS.history.minSettled; i++) {
      ids.push(
        await beads.create(repo, {
          title: `a shipped-orphan ask the founder accepted (${i})`,
          type: "task",
          labels: [proposalFingerprint("shipped-orphan", `earned:${i}`)],
        }),
      );
    }
    await beads.batch(
      repo,
      ids.map((id) => ({
        op: "close" as const,
        id,
        reason: appliedCloseReason(`retired ${id}`, "approval"),
      })),
    );

    // Fail HERE if the seed stops earning the kind. Without it a broken record reads as an ordinary
    // unarmed pass, and the suite reports a missing apply rather than the missing precondition.
    const record = proposalTrackRecord(await beads.list(repo, ["--status", "all"]));
    expect(earnedAutonomyOfKind("shipped-orphan", record).eligible).toBe(true);
  };

  beforeAll(async () => {
    repoDir = makeBdRepo();
    repo = repoDir.repo;
    restoreEnv = saveEnv(["ANTON_SESSIONS_ROOT"]);
    process.env.ANTON_SESSIONS_ROOT = join(repoDir.dir, "sessions");

    shipped = await beads.create(repo, {
      title: "the work a commit already shipped",
      type: "task",
      acceptance: "- [ ] it shipped",
    });

    // An orphan is a bead a COMMIT names while the bead is still open.
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `fix(${shipped}): work`], {
      cwd: repo,
      stdio: "ignore",
    });

    tdb = makeTestDb();
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
      settingsJson: JSON.stringify({ proposalAutonomy: { "shipped-orphan": "apply" } }),
    });

    await earnShippedOrphan();

    // The subject was written a heartbeat ago, and this pass both files the ask and applies it: an
    // apply is only allowed when the subject's write can be ordered BEFORE the board read behind it
    // (apply-plan.ts `writtenSinceFiling`), which a shared stamp second makes impossible. A real
    // patrol judges commits from hours ago; only this fixture is fast enough to tie.
    await nextBdSecond();

    await expectJobStatus(tdb.db, await runPatrol(), "done");
    afterFirst = await boardBytes();
    filed = await proposals();

    resetIssueSnapshots();
    await expectJobStatus(tdb.db, await runPatrol(), "done");
    afterSecond = await boardBytes();
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    restoreEnv?.();
    repoDir.cleanup();
  });

  it("makes the move itself: the subject is retired and the ask is settled as applied", async () => {
    const subject = await beads.show(repo, shipped);
    expect(subject.status).toBe("closed");

    const [proposal] = filed.filter((p) => p.title.includes("close"));
    expect(proposal.status).toBe("closed");
    // Applied, never abandoned: a declined proposal suppresses its fingerprint forever, and this
    // question was answered by being DONE.
    expect(beads.isAbandoned(proposal)).toBe(false);
    expect(await logOf(0)).toContain(
      `APPLY ${proposal.id} (shipped-orphan) retire/close ${shipped} — APPLIED:`,
    );
  });

  it("says on the bead who did it — a policy write is not an approval", async () => {
    const [proposal] = filed.filter((p) => p.title.includes("close"));
    const settled = await beads.showWithComments(repo, proposal.id);
    expect(String(settled.notes)).toContain("applied by POLICY");
    // The setting is named, because that is what a founder who disagrees has to go and change.
    expect(String(settled.notes)).toContain("`shipped-orphan` is set to apply");
  });

  it("is a no-op on a re-run — the board it left is the board it finds", async () => {
    expect(Object.keys(afterSecond).sort()).toEqual(Object.keys(afterFirst).sort());
    for (const [id, bytes] of Object.entries(afterFirst)) {
      expect({ id, bytes }).toEqual({ id, bytes: afterSecond[id] });
    }
    // Not by luck of an empty detection either: the second pass had nothing to apply and said so by
    // saying nothing — no second ask about a bead the first pass already retired.
    expect(await logOf(1)).not.toContain("APPLY ");
  });
});
