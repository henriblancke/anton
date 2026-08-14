/**
 * Shadow mode's one load-bearing claim, proved against REAL bd (anton-lmps): a pass that shadows
 * several proposals leaves every bead it shadowed BYTE-IDENTICAL.
 *
 * The unit suites pin the record's shape with bd stubbed. Only a live board can prove the negative
 * that makes shadow worth shipping before the armed writes exist — that running `planApply` over a
 * real board, for kinds an operator has armed, changes nothing on it. So the whole board is
 * serialized bead by bead before the patrol and compared field by field after: not just statuses,
 * every field bd returns, because a shadow that quietly re-stamped `updated_at` would be a write.
 *
 * The fixture deliberately has NO close-eligible epic and no `blocks` edges, so the patrol's two
 * safe verbs have nothing to do and the diff is entirely the shadow's to answer for.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { beads, type Bead } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { GARDENER_DETECTION_KINDS, isProposalBead } from "../gardener/detections";
import { makeGardenerHandler } from "./gardener";
import type { Clock } from "./queue";

describeBd("gardener shadow pass e2e (real handler · real bd)", () => {
  let repoDir: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let projectId: string;
  let restoreEnv: () => void;
  const clock: Clock = { now: () => Date.now() };
  const nudge = vi.fn();

  /** Named by a commit and still open — the shipped-orphan ask (retire/close). */
  let shipped: string;
  /** Imported with 2025 stamps, so they are past the retirement window on any clock — stale asks. */
  let staleOpen: string;
  let staleInProgress: string;

  /** Every bead on the board, serialized whole — the "nothing moved" comparison. */
  const boardBytes = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await beads.list(repo, ["--status", "all"])).map((b) => [b.id, JSON.stringify(b)]),
    );

  let before: Record<string, string>;
  let after: Record<string, string>;
  let filed: Bead[];
  let log: string;

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

    // Staleness is a clock property and bd rejects `--days 0`, so the only way to seed it is to
    // import beads carrying an old `updated_at` (mirrors gardener.integration.test.ts).
    const prefix = shipped.slice(0, shipped.lastIndexOf("-"));
    staleOpen = `${prefix}-old1`;
    staleInProgress = `${prefix}-old2`;
    const jsonl = join(repoDir.dir, "stale.jsonl");
    writeFileSync(
      jsonl,
      [
        JSON.stringify({
          _type: "issue",
          id: staleOpen,
          title: "forgotten open bead",
          status: "open",
          issue_type: "task",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-02T00:00:00Z",
        }),
        JSON.stringify({
          _type: "issue",
          id: staleInProgress,
          title: "abandoned in progress",
          status: "in_progress",
          issue_type: "task",
          assignee: "someone",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-03T00:00:00Z",
        }),
        "",
      ].join("\n"),
    );
    execFileSync("bd", ["import", jsonl], { cwd: repo, stdio: "ignore" });

    // An orphan is a bead a COMMIT names while the bead is still open.
    writeFileSync(join(repo, "work.txt"), "shipped\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", `fix(${shipped}): work`], {
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
      // Every kind armed at `shadow`: whatever this board turns out to support, the pass shadows it.
      settingsJson: JSON.stringify({
        proposalAutonomy: Object.fromEntries(GARDENER_DETECTION_KINDS.map((k) => [k, "shadow"])),
      }),
    });

    before = await boardBytes();
    const jobId = await driveJob({
      db: tdb.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
      projectId,
    });
    await expectJobStatus(tdb.db, jobId, "done");

    after = await boardBytes();
    filed = (await beads.list(repo, ["--status", "all"])).filter(isProposalBead);
    const [session] = await tdb.db.select().from(schema.sessions);
    log = session?.logPath ? readFileSync(session.logPath, "utf8") : "";
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    tdb?.close();
    restoreEnv?.();
    repoDir.cleanup();
  });

  it("shadows several proposals, naming the ask and the verdict for each", () => {
    // Several, because one shadowed proposal proves nothing about a pass: the point is a whole
    // patrol's worth of judgment recorded in one place.
    expect(filed.length).toBeGreaterThanOrEqual(3);
    const lines = log.split("\n").filter((l) => l.includes("SHADOW"));
    expect(lines).toHaveLength(filed.length);
    for (const proposal of filed) {
      const line = lines.find((l) => l.includes(`SHADOW ${proposal.id} `));
      // The whole ask, and a verdict in planApply's words — never a bare "shadowed".
      expect(line).toMatch(/\([a-z-]+\) \S+ \S+/);
      expect(line).toMatch(/— (WOULD APPLY|WOULD REFUSE|ALREADY SETTLED|COULD NOT SHADOW): \S/);
    }
    // The kinds this board actually produces, named so a fixture that stops producing them fails
    // loudly rather than passing on an empty shadow.
    expect(log).toContain(`retire/close ${shipped}`);
    expect(log).toContain(`retire/defer ${staleOpen}`);
    expect(log).toContain(`retire/defer ${staleInProgress}`);
  });

  it("leaves every bead it shadowed byte-identical — the proposals are the only thing added", () => {
    const added = Object.keys(after).filter((id) => !(id in before));
    expect(added.sort()).toEqual(filed.map((p) => p.id).sort());
    for (const [id, bytes] of Object.entries(before)) {
      expect({ id, bytes }).toEqual({ id, bytes: after[id] });
    }
    // Named explicitly, because these are exactly the beads an armed pass WOULD have written to.
    expect(after[shipped]).toBe(before[shipped]);
    expect(after[staleOpen]).toBe(before[staleOpen]);
    expect(after[staleInProgress]).toBe(before[staleInProgress]);
  });

  it("still leaves the asks standing: a shadow decides nothing on the operator's behalf", async () => {
    // The record is commentary. Every proposal is still open, waiting for the same human approval it
    // would have waited for with shadow switched off.
    for (const proposal of filed) {
      expect(proposal.status).toBe("open");
      expect(beads.isAbandoned(proposal)).toBe(false);
    }
    expect(await beads.list(repo, ["--status", "all"])).toHaveLength(
      Object.keys(before).length + filed.length,
    );
  });
});
