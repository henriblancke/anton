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
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads, type Bead } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { isProposalBead } from "../gardener/detections";
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
