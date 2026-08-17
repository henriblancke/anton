/**
 * End-to-end proof of anton-3t2.3's acceptance: "Nightly scan findings are triaged into beads
 * automatically per project." Drives the REAL nightly-stringer handler + REAL runner against a temp
 * repo, using a fake `stringer` (writes a canned scan) and fake `claude` (creates a bead via bd,
 * as /scan-triage would). Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeNightlyStringerHandler } from "./nightly-stringer";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

describeBd("nightly-stringer e2e (real handler · real bd · fake stringer/claude)", () => {
  let bdRepo: BdRepo;
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let restoreEnv: () => void;

  /** One nightly-stringer job, driven to settlement against the suite's db/repo. */
  const runScan = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "nightly-stringer",
      handler: makeNightlyStringerHandler,
      projectId,
      config: { leaseMs: 30_000 },
    });

  beforeAll(async () => {
    // `bare`: the pass refreshes the checkout against origin before it scans and stands down when
    // it can't (anton-qor2), so a remote-less sandbox would park every case here.
    bdRepo = makeBdRepo({ bare: true, initialCommit: true });
    sandbox = bdRepo.dir;
    repo = bdRepo.repo;
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);

    // Fake stringer: honor `-o <file>`, write a canned scan whose signal count is controlled by
    // FAKE_STRINGER_SIGNALS (0 → an empty scan, exercising the no-op path). FAKE_STRINGER_STDERR
    // replays real stringer stderr, e.g. a collector that died while the scan still exits 0.
    const fakeStringer = writeBin(
      binDir,
      "stringer",
      `const fs=require('fs');const path=require('path');const a=process.argv.slice(2);
const oi=a.indexOf('-o');const out=oi>=0?a[oi+1]:null;
const n=Number(process.env.FAKE_STRINGER_SIGNALS||'0');
const signals=Array.from({length:n},(_,i)=>({Source:'todo',Kind:'todo',FilePath:'x.ts',Line:i+1,Title:'TODO '+i}));
if(out)fs.writeFileSync(out,JSON.stringify({signals,metadata:{}}));
// Advance the --delta baseline on the way out, as the real stringer does: the window a scan saw
// is gone from the next one unless the caller puts this file back.
if(a.includes('--delta')){const state=path.join(a[1],'.stringer','last-scan.json');
  let m=0;try{m=JSON.parse(fs.readFileSync(state,'utf8')).n+1;}catch{}
  fs.mkdirSync(path.dirname(state),{recursive:true});fs.writeFileSync(state,JSON.stringify({n:m}));}
if(process.env.FAKE_STRINGER_STDERR)process.stderr.write(process.env.FAKE_STRINGER_STDERR+'\\n');
process.exit(0);`,
    );

    // Fake claude for /scan-triage: parse the scan file path from the prompt, create one bead per
    // signal via bd (proving triage → beads), dump args for assertions.
    const fakeClaude = writeBin(
      binDir,
      "claude",
      `const fs=require('fs');const cp=require('child_process');
// Prompt arrives on stdin, never on argv (anton-14tj).
let prompt='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{prompt+=c;});
process.stdin.on('end',()=>{
  if(process.env.ANTON_TEST_CLAUDE_ARGV)fs.appendFileSync(process.env.ANTON_TEST_CLAUDE_ARGV,JSON.stringify({prompt})+'\\n');
  // Triage dying before it writes a bead — a quota abort reports is_error while still exiting 0.
  if(process.env.FAKE_CLAUDE_FAIL){
    process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',result:'usage limit reached',is_error:true})+'\\n');
    process.exit(0);
  }
  const m=prompt.match(/scan file to triage is: (\\S+)/);
  if(m){const scan=JSON.parse(fs.readFileSync(m[1],'utf8'));
    for(const s of (scan.signals||[])){
      cp.execFileSync('bd',['create','Triaged: '+s.Title,'--type','task','--acceptance','fix it','--json'],{cwd:process.cwd()});
    }
  }
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  e({type:'result',subtype:'success',result:'created beads',is_error:false});
  process.exit(0);
});`,
    );

    restoreEnv = saveEnv([
      "ANTON_STRINGER_BIN",
      "ANTON_CLAUDE_BIN",
      "ANTON_SESSIONS_ROOT",
      "ANTON_SCANS_ROOT",
      "ANTON_TEST_CLAUDE_ARGV",
    ]);
    process.env.ANTON_STRINGER_BIN = fakeStringer;
    process.env.ANTON_CLAUDE_BIN = fakeClaude;
    process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
    process.env.ANTON_SCANS_ROOT = join(sandbox, "scans");
    process.env.ANTON_TEST_CLAUDE_ARGV = join(sandbox, "claude-argv.jsonl");

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
  });

  afterAll(() => {
    tdb?.close();
    restoreEnv();
    bdRepo.cleanup();
  });

  it("scans, triages signals into beads, records a session", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "3";
    const beadsBefore = (await beads.list(repo, ["--status", "all"])).length;

    const jobId = await runScan();

    expect((await getJob(tdb.db, jobId))?.status).toBe("done");

    // 3 signals → 3 new beads created by the triage claude.
    const beadsAfter = await beads.list(repo, ["--status", "all"]);
    expect(beadsAfter.length).toBe(beadsBefore + 3);
    expect(beadsAfter.filter((b) => b.title.startsWith("Triaged:")).length).toBe(3);

    // claude received the /scan-triage prompt pointing at the scan file.
    const inv = readFileSync(join(sandbox, "claude-argv.jsonl"), "utf8").trim().split("\n").pop()!;
    const prompt = (JSON.parse(inv) as { prompt: string }).prompt;
    expect(prompt).toContain("scan-triage");
    expect(prompt).toContain("scan file to triage is:");

    // Session recorded + done.
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions.some((s) => s.kind === "nightly-stringer" && s.status === "done")).toBe(true);
  });

  it("is a no-op when the scan has no new signals (claude not invoked)", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "0";
    rmSync(join(sandbox, "claude-argv.jsonl"), { force: true });
    const beadsBefore = (await beads.list(repo, ["--status", "all"])).length;

    const jobId = await runScan();

    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    // No beads created, claude never ran (no argv file written).
    expect((await beads.list(repo, ["--status", "all"])).length).toBe(beadsBefore);
    expect(existsSync(join(sandbox, "claude-argv.jsonl"))).toBe(false);
  });

  // The scan consumed a --delta window it never reported: left advanced, the retry would find
  // nothing new and close the pass green over findings nobody triaged.
  it("puts the --delta baseline back when triage dies, so the retry re-triages the same window", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "2";
    process.env.FAKE_CLAUDE_FAIL = "1";
    const state = join(repo, ".stringer", "last-scan.json");
    const readState = () => (existsSync(state) ? readFileSync(state, "utf8") : null);
    const before = readState();
    const beadsBefore = (await beads.list(repo, ["--status", "all"])).length;
    const sessionsBefore = new Set((await tdb.db.select().from(schema.sessions)).map((s) => s.id));

    let jobId: string;
    try {
      jobId = await runScan();
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
    }

    // Rescheduled behind the quota cool-off, no beads written — and the window is back where the
    // pass found it, so the post-quota retry is the one that triages these signals.
    const failed = await getJob(tdb.db, jobId);
    expect(failed?.status).not.toBe("done");
    expect(failed?.lastError).toContain("usage-limit");
    expect(readState()).toBe(before);
    expect((await beads.list(repo, ["--status", "all"])).length).toBe(beadsBefore);

    // The session says what it unwound, so an operator reads the retry's rescan as intended.
    const sessions = await tdb.db.select().from(schema.sessions);
    const session = sessions.find((s) => !sessionsBefore.has(s.id))!;
    expect(readFileSync(session.logPath!, "utf8")).toContain("--delta baseline restored");

    // ...and the retry gets all the way to beads.
    expect((await getJob(tdb.db, await runScan()))?.status).toBe("done");
    expect((await beads.list(repo, ["--status", "all"])).length).toBe(beadsBefore + 2);
  });

  it("warns on the session when a collector died, even with no signals to triage (anton-uspu)", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "0";
    process.env.FAKE_STRINGER_STDERR =
      `time=2026-07-26T19:26:45Z level=ERROR msg="collector failed" name=gitlog ` +
      `error="opening repo: core.repositoryformatversion does not support extension: worktreeconfig" duration=4ms`;
    const before = new Set((await tdb.db.select().from(schema.sessions)).map((s) => s.id));

    // finally: a leaked FAKE_STRINGER_STDERR would fake a collector failure in every later test.
    let jobId: string;
    try {
      jobId = await runScan();
    } finally {
      delete process.env.FAKE_STRINGER_STDERR;
    }

    // The scan itself is still a success — only the loss is surfaced.
    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    const sessions = await tdb.db.select().from(schema.sessions);
    const session = sessions.find((s) => !before.has(s.id))!;
    expect(session.status).toBe("done");
    const log = readFileSync(session.logPath!, "utf8");
    expect(log).toContain(`WARNING: collector "gitlog" failed`);
    expect(log).toContain("extensions.worktreeConfig");
  });
});
