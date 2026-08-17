/**
 * Regression for anton-qor2: the nightly pass must measure the tree that SHIPPED.
 *
 * Drives the REAL handler + REAL runner against a checkout that is BEHIND its remote, with a fake
 * `stringer` that records every invocation. Two outcomes are allowed and no third: the checkout is
 * fast-forwarded and the scan measures (and names) the current tree, or the drift is recorded and
 * the pass stands down with its `--delta` window untouched — never a silent triage of the stale
 * tree. The 2026-08-06 pass did the third thing: it scanned a checkout 6 commits behind origin/main
 * and spent 87% of its signals, and its whole delta window, on code merged away hours earlier.
 *
 * No bd here: the scans are empty, so the pass returns before the board read and `bun run test`
 * gates on this rather than the report-only integration project.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveJob } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeNightlyStringerHandler } from "./nightly-stringer";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

suite("nightly-stringer scans the tree that shipped (real git · fake stringer)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let other: string;
  let tdb: TestDb;
  let projectId: string;
  let scanLog: string;
  const saved: Record<string, string | undefined> = {};

  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const head = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]);

  /** stringer's own `--delta` state, which a scan of the stale tree would have consumed. */
  const baselineFile = (): string => join(repo, ".stringer", "last-scan.json");
  const baseline = (): string | null =>
    existsSync(baselineFile()) ? readFileSync(baselineFile(), "utf8") : null;

  /** Every `stringer` invocation this pass made — empty proves the pass stood down before scanning. */
  const scans = (): string[] =>
    existsSync(scanLog) ? readFileSync(scanLog, "utf8").trim().split("\n").filter(Boolean) : [];

  const runScan = () =>
    driveJob({
      db: tdb.db,
      clock: new FakeClock(1_700_000_000_000),
      type: "nightly-stringer",
      handler: makeNightlyStringerHandler,
      projectId,
      config: { leaseMs: 30_000 },
    });

  /** Move origin/main ahead of `repo` — the drift every case below starts from. */
  const shipCommit = (): string => {
    writeFileSync(join(other, "shipped.ts"), "export const shipped = true;\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "ship it"]);
    git(other, ["push", "-q", "origin", "main"]);
    return head(other);
  };

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-qor2-"));
    bare = join(sandbox, "remote.git");
    repo = join(sandbox, "repo");
    other = join(sandbox, "other");
    scanLog = join(sandbox, "stringer-invocations.log");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });

    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "anton-test"]);
    git(repo, ["remote", "add", "origin", bare]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" });
    git(other, ["config", "user.email", "t@example.com"]);
    git(other, ["config", "user.name", "anton-test"]);

    // A window already open, so "the next pass still sees it" is an assertion and not a vacuous truth.
    mkdirSync(join(repo, ".stringer"), { recursive: true });
    writeFileSync(baselineFile(), JSON.stringify({ n: 1 }));

    // Fake stringer: records that it ran, writes an empty scan (so the pass returns before the
    // board read), and advances the --delta baseline on its way out as the real one does.
    const bin = join(sandbox, "stringer");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs=require('fs');const path=require('path');const a=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_STRINGER_LOG,JSON.stringify(a)+'\\n');
const oi=a.indexOf('-o');if(oi>=0)fs.writeFileSync(a[oi+1],JSON.stringify({signals:[],metadata:{}}));
if(a.includes('--delta')){const s=path.join(a[1],'.stringer','last-scan.json');
  let m=0;try{m=JSON.parse(fs.readFileSync(s,'utf8')).n+1;}catch{}
  fs.mkdirSync(path.dirname(s),{recursive:true});fs.writeFileSync(s,JSON.stringify({n:m}));}
process.exit(0);`,
    );
    chmodSync(bin, 0o755);

    for (const key of [
      "ANTON_STRINGER_BIN",
      "ANTON_SESSIONS_ROOT",
      "ANTON_SCANS_ROOT",
      "FAKE_STRINGER_LOG",
    ]) {
      saved[key] = process.env[key];
    }
    process.env.ANTON_STRINGER_BIN = bin;
    process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
    process.env.ANTON_SCANS_ROOT = join(sandbox, "scans");
    process.env.FAKE_STRINGER_LOG = scanLog;

    tdb = makeTestDb();
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });
  });

  afterEach(() => {
    tdb?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** The one session this pass wrote, and its log. */
  const sessionLog = async (): Promise<string> => {
    const sessions = await tdb.db.select().from(schema.sessions);
    return readFileSync(sessions[0]!.logPath!, "utf8");
  };

  it("fast-forwards a stale checkout and records the SHA it scanned on the trend point", async () => {
    const stale = head(repo);
    const shipped = shipCommit();

    const jobId = await runScan();

    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    // Measured the shipped tree, not the one the checkout happened to hold.
    expect(head(repo)).toBe(shipped);
    expect(scans().length).toBe(1);

    const [summary] = await tdb.db.select().from(schema.scanSummaries);
    expect(summary?.scannedSha).toBe(shipped);

    const log = await sessionLog();
    expect(log).toContain(shipped);
    expect(log).toContain(`checkout fast-forwarded ${stale} → ${shipped}`);
  });

  it("stands down on a dirty stale checkout: drift recorded, --delta window untouched, nothing triaged", async () => {
    shipCommit();
    // Someone's work in progress — anton neither stashes it nor measures around it.
    writeFileSync(join(repo, "README.md"), "# sandbox\nwip\n");
    const stale = head(repo);
    const window = baseline();

    const jobId = await runScan();

    // Parked for a human rather than retried: no attempt can clean someone else's tree.
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("parked");
    expect(job?.lastError).toContain("checkout drift");

    // stringer never ran, so the window this pass would have consumed is still there for the next.
    expect(scans()).toEqual([]);
    expect(baseline()).toBe(window);
    expect(head(repo)).toBe(stale);

    // No point on the trend: a pass that measured nothing must not chart a clean scan.
    expect(await tdb.db.select().from(schema.scanSummaries)).toEqual([]);

    const log = await sessionLog();
    expect(log).toContain("checkout drift");
    expect(log).toContain("uncommitted change");
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions[0]?.status).toBe("failed");
  });
});
