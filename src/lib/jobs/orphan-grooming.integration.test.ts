/**
 * End-to-end proof of anton-3t2.4's acceptance: "Orphan tickets are periodically grouped under an
 * epic." Drives the REAL orphan-grooming handler + REAL bd against a temp repo. Skipped without bd.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeOrphanGroomingHandler, ORPHAN_EPIC_LABEL } from "./orphan-grooming";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

// Orphans grooming buckets are the NON-runnable loose types (a parentless task/bug is a runnable
// standalone target that grooming must leave alone — anton-cmz), so loose tickets default to `chore`.
function createTicket(repo: string, title: string, parent?: string, type = "chore"): string {
  const args = ["create", title, "--type", type, "--acceptance", "x", "--json"];
  if (parent) args.push("--parent", parent);
  const raw = execFileSync("bd", args, { cwd: repo, encoding: "utf8" });
  const p = JSON.parse(raw);
  return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
}

const suite = has("bd") ? describe : describe.skip;

suite("orphan-grooming e2e (real handler · real bd)", () => {
  let sandbox: string;
  let repo: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let orphanA: string;
  let orphanB: string;
  let childTicket: string;
  let realEpic: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-og-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);

    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });
    // A real epic with a child (NOT an orphan) + two loose tickets (orphans).
    realEpic = await beads.create(repo, { title: "Real epic", type: "epic", description: "## Goal\nx" });
    childTicket = createTicket(repo, "Child of real epic", realEpic);
    orphanA = createTicket(repo, "Loose ticket A");
    orphanB = createTicket(repo, "Loose ticket B");

    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });
  }, 60_000);

  afterAll(() => {
    tdb?.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("buckets loose tickets under a grooming epic; leaves parented ones alone", async () => {
    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1 } });
    runner.registerHandler("orphan-grooming", makeOrphanGroomingHandler({ db: tdb.db, clock }));
    await runner.enqueue({ type: "orphan-grooming", projectId, payload: { projectId } });
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();

    const board = await beads.list(repo, ["--status", "all"]);

    // A grooming epic was created and labeled.
    const groomingEpic = board.find(
      (b) => beads.isEpic(b) && (b.labels?.includes(ORPHAN_EPIC_LABEL) ?? false),
    );
    expect(groomingEpic).toBeTruthy();

    // Both orphans are now children of it.
    const parentOf = (id: string) => {
      const b = board.find((x) => x.id === id);
      const inline = (b?.parent ?? b?.parent_id) as string | undefined;
      if (inline) return inline;
      const edge = beads
        .edgesOf(board)
        .find((e) => e.type === "parent-child" && e.from === id);
      return edge?.to;
    };
    expect(parentOf(orphanA)).toBe(groomingEpic!.id);
    expect(parentOf(orphanB)).toBe(groomingEpic!.id);

    // The already-parented ticket kept its original epic.
    expect(parentOf(childTicket)).toBe(realEpic);
  }, 60_000);

  it("is idempotent — a second run with no new orphans reuses the epic and adds nothing", async () => {
    const before = await beads.list(repo, ["--status", "all"]);
    const epicCountBefore = before.filter((b) => beads.isEpic(b)).length;

    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1 } });
    runner.registerHandler("orphan-grooming", makeOrphanGroomingHandler({ db: tdb.db, clock }));
    await runner.enqueue({ type: "orphan-grooming", projectId, payload: { projectId } });
    await runner.tickOnce();
    await runner.whenIdle();

    const after = await beads.list(repo, ["--status", "all"]);
    const epicCountAfter = after.filter((b) => beads.isEpic(b)).length;
    expect(epicCountAfter).toBe(epicCountBefore); // no new grooming epic

    // A freshly-added orphan gets bucketed under the SAME grooming epic on the next run.
    const orphanC = createTicket(repo, "Loose ticket C");
    await runner.enqueue({ type: "orphan-grooming", projectId, payload: { projectId } });
    await runner.tickOnce();
    await runner.whenIdle();
    const final = await beads.list(repo, ["--status", "all"]);
    expect(final.filter((b) => beads.isEpic(b)).length).toBe(epicCountBefore); // still one grooming epic
    const groomingEpic = final.find(
      (b) => beads.isEpic(b) && (b.labels?.includes(ORPHAN_EPIC_LABEL) ?? false),
    )!;
    const c = final.find((x) => x.id === orphanC);
    const cParent =
      ((c?.parent ?? c?.parent_id) as string | undefined) ??
      beads.edgesOf(final).find((e) => e.type === "parent-child" && e.from === orphanC)?.to;
    expect(cParent).toBe(groomingEpic.id);
  }, 60_000);
});
