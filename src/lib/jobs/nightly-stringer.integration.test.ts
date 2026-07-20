/**
 * End-to-end proof of anton-3t2.3's acceptance: "Nightly scan findings are triaged into beads
 * automatically per project." Drives the REAL nightly-stringer handler + REAL runner against a temp
 * repo, using a fake `stringer` (writes a canned scan) and fake `claude` (creates a bead via bd,
 * as /scan-triage would). Skipped without bd + git.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { JobRunner } from "./runner";
import { makeNightlyStringerHandler } from "./nightly-stringer";

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

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("nightly-stringer e2e (real handler · real bd · fake stringer/claude)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-ns-"));
    repo = join(sandbox, "repo");
    binDir = join(sandbox, "bin");
    mkdirSync(repo);
    mkdirSync(binDir);
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });

    // Fake stringer: honor `-o <file>`, write a canned scan whose signal count is controlled by
    // FAKE_STRINGER_SIGNALS (0 → an empty scan, exercising the no-op path).
    const fakeStringer = writeBin(
      binDir,
      "stringer",
      `const fs=require('fs');const a=process.argv.slice(2);
const oi=a.indexOf('-o');const out=oi>=0?a[oi+1]:null;
const n=Number(process.env.FAKE_STRINGER_SIGNALS||'0');
const signals=Array.from({length:n},(_,i)=>({Source:'todo',Kind:'todo',FilePath:'x.ts',Line:i+1,Title:'TODO '+i}));
if(out)fs.writeFileSync(out,JSON.stringify({signals,metadata:{}}));
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

    const set = (k: string, v: string) => {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    };
    set("ANTON_STRINGER_BIN", fakeStringer);
    set("ANTON_CLAUDE_BIN", fakeClaude);
    set("ANTON_SESSIONS_ROOT", join(sandbox, "sessions"));
    set("ANTON_SCANS_ROOT", join(sandbox, "scans"));
    set("ANTON_TEST_CLAUDE_ARGV", join(sandbox, "claude-argv.jsonl"));

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
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("scans, triages signals into beads, records a session", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "3";
    const beadsBefore = (await beads.list(repo, ["--status", "all"])).length;

    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
    runner.registerHandler("nightly-stringer", makeNightlyStringerHandler({ db: tdb.db, clock }));
    const jobId = await runner.enqueue({ type: "nightly-stringer", projectId, payload: { projectId } });
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();

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
  }, 60_000);

  it("is a no-op when the scan has no new signals (claude not invoked)", async () => {
    process.env.FAKE_STRINGER_SIGNALS = "0";
    rmSync(join(sandbox, "claude-argv.jsonl"), { force: true });
    const beadsBefore = (await beads.list(repo, ["--status", "all"])).length;

    const runner = new JobRunner({ db: tdb.db, clock, config: { maxConcurrent: 1, leaseMs: 30_000 } });
    runner.registerHandler("nightly-stringer", makeNightlyStringerHandler({ db: tdb.db, clock }));
    const jobId = await runner.enqueue({ type: "nightly-stringer", projectId, payload: { projectId } });
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();

    expect((await getJob(tdb.db, jobId))?.status).toBe("done");
    // No beads created, claude never ran (no argv file written).
    expect((await beads.list(repo, ["--status", "all"])).length).toBe(beadsBefore);
    expect(existsSync(join(sandbox, "claude-argv.jsonl"))).toBe(false);
  }, 60_000);
});
