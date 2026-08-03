/**
 * Replay proof of anton-ol1l: a STORED stringer scan (`nightly-stringer.routing.scan.json`) driven
 * through the REAL nightly-stringer handler against a REAL bd board that already holds the work its
 * signals belong to — an open feature owning one signal's file, and the same underlying issue
 * already raised under two producer namespaces.
 *
 * The triage agent is faked, but not hand-waved: the fake reads ONLY the `## Board context` section
 * anton resolves into the prompt and applies skills/scan-triage's routing rules to it (§4.0 route
 * into the owning feature, §2 cross-producer dedup). So what the suite proves is the contract
 * between the two — anton hands over a board the rules can be executed against, and the rules,
 * executed, land the signal inside the structure that owns it instead of beside it.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads, type Bead } from "../beads/bd";
import { getLatestScanSummary } from "../scan-health";
import { BOARD_CONTEXT_HEADING } from "../board-context";
import * as schema from "../db/schema";
import type { Clock } from "./queue";
import { makeNightlyStringerHandler } from "./nightly-stringer";

const STORED_SCAN = fileURLToPath(new URL("./nightly-stringer.routing.scan.json", import.meta.url));

/** The two signals in the stored scan, by the file each one lands on. */
const OWNED_FILE = "src/lib/auth/session.ts"; // inside the open feature's touch surface
const COLLIDING_FILE = "src/lib/runs.ts"; // already raised by stringer AND by the gardener
const SHARED_HASH = "8000d8e1"; // the same underlying issue, fingerprinted under both namespaces

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

/**
 * The triage agent, replayed. It parses the board-context lines anton rendered and follows the
 * skill: a producer bead already covering the signal's file is a cross-link (never a second bead);
 * otherwise the owning feature takes it as a child when `attach:child`, and as a `discovered-from`
 * sibling under the same epic when the feature's run has been captured.
 */
const FAKE_TRIAGE = String.raw`
const fs=require('fs');const cp=require('child_process');const crypto=require('crypto');
let prompt='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{prompt+=c;});
process.stdin.on('end',()=>{
  if(process.env.ANTON_TEST_CLAUDE_ARGV)fs.appendFileSync(process.env.ANTON_TEST_CLAUDE_ARGV,JSON.stringify({prompt})+'\n');
  const bd=(...a)=>cp.execFileSync('bd',a,{cwd:process.cwd(),encoding:'utf8'});
  const lines=prompt.split('\n');
  const fields=l=>l.replace(/^- /,'').split(' · ');
  const touchesOf=p=>{const t=p.find(x=>x.startsWith('touches: '));
    return t?t.slice(9).split(', ').filter(x=>x&&!x.startsWith('(')):[];};
  const features=lines.filter(l=>/^- \S+ · attach:/.test(l)).map(fields);
  const producers=lines.filter(l=>/^- \S+ · (open|in_progress|blocked|deferred) · (stringer|gardener|pm):/.test(l)).map(fields);
  const scan=JSON.parse(fs.readFileSync(/scan file to triage is: (\S+)/.exec(prompt)[1],'utf8'));

  let created=0,deduped=0,crossLinked=0,routed=0;
  for(const s of (scan.signals||[])){
    const file=s.FilePath;
    const fp=s.Source+':'+crypto.createHash('sha1').update(s.Source+':'+file).digest('hex').slice(0,8);
    // 2. Already raised by SOME producer? Cross-link the collision, create nothing.
    const holders=producers.filter(p=>touchesOf(p).includes(file));
    if(holders.length){
      deduped++;
      for(let i=1;i<holders.length;i++){
        try{bd('link',holders[0][0],holders[i][0],'--type','related');crossLinked++;}catch(e){}
      }
      continue;
    }
    // 4.0 Route into the open feature whose touch surface owns the file.
    const owner=features.find(p=>touchesOf(p).includes(file));
    const epic=owner?((owner.find(x=>x.startsWith('epic:'))||'epic:none').slice(5)):'none';
    const body=id=>['## Goal','Pay down '+s.Title,'','## Context','touches: '+file+':'+s.Line,
      'routed: '+id+' — '+file+' is inside its touch surface','','## Out of scope','- unrelated cleanup',
      '','## Verify','re-scan clean'].join('\n');
    if(owner&&owner[1]==='attach:child'){
      const out=JSON.parse(bd('create','Triaged: '+s.Title,'--type','task','--acceptance','- [ ] '+s.Title,
        '--labels','domain:eng,source:stringer,risk:low,size:S,stringer:'+fp,'--description',body(owner[0]),'--json'));
      const id=(Array.isArray(out)?out[0]:out).id;
      bd('link',id,owner[0],'--type','parent-child');
      created++;routed++;
    }else if(owner){
      const out=JSON.parse(bd('create','Triaged: '+s.Title,'--type','feature','--acceptance','- [ ] '+s.Title,
        '--labels','domain:eng,source:stringer,risk:low,size:S,stringer:'+fp,'--description',body(owner[0]),'--json'));
      const id=(Array.isArray(out)?out[0]:out).id;
      if(epic!=='none')bd('link',id,epic,'--type','parent-child');
      bd('link',id,owner[0],'--type','discovered-from');
      created++;routed++;
    }
    // No owner and no epic match in this fixture: nothing else to file.
  }
  const e=o=>process.stdout.write(JSON.stringify(o)+'\n');
  e({type:'result',subtype:'success',is_error:false,result:
    'created: '+created+' (0 features, '+created+' tickets) · epics: 0 attached, 0 created · routed-into-existing: '+routed+
    ' · deduped: '+deduped+' (cross-linked: '+crossLinked+') · dropped-as-noise: 0 · deferred (over cap): 0'});
  process.exit(0);
});`;

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

describeBd("nightly-stringer routing replay (real handler · real bd · stored scan)", () => {
  let bdRepo: BdRepo;
  let sandbox: string;
  let repo: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let restoreEnv: () => void;
  let epicId: string;
  let featureId: string;
  let stringerBeadId: string;
  let gardenerBeadId: string;

  const runScan = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "nightly-stringer",
      handler: makeNightlyStringerHandler,
      projectId,
      config: { leaseMs: 30_000 },
    });

  /** The prompt of the most recent fake-triage invocation. */
  const lastPrompt = (): string => {
    const lines = readFileSync(join(sandbox, "claude-argv.jsonl"), "utf8").trim().split("\n");
    return (JSON.parse(lines[lines.length - 1]) as { prompt: string }).prompt;
  };

  const board = () => beads.list(repo, ["--status", "all"]);
  const triaged = (all: Bead[]) => all.filter((b) => b.title.startsWith("Triaged:"));
  const hasEdge = (all: Bead[], from: string, to: string, type: string) =>
    beads
      .edgesOf(all)
      .some((e) => e.type === type && ((e.from === from && e.to === to) || (e.from === to && e.to === from)));

  beforeAll(async () => {
    bdRepo = makeBdRepo({ initialCommit: true });
    sandbox = bdRepo.dir;
    repo = bdRepo.repo;
    const binDir = join(sandbox, "bin");
    mkdirSync(binDir);

    // Fake stringer: replay the STORED scan file byte-for-byte at whatever path anton asked for.
    const fakeStringer = writeBin(
      binDir,
      "stringer",
      `const fs=require('fs');const a=process.argv.slice(2);const oi=a.indexOf('-o');
if(oi>=0)fs.copyFileSync(process.env.FAKE_SCAN_FIXTURE,a[oi+1]);
process.exit(0);`,
    );
    const fakeClaude = writeBin(binDir, "claude", FAKE_TRIAGE);

    restoreEnv = saveEnv([
      "ANTON_STRINGER_BIN",
      "ANTON_CLAUDE_BIN",
      "ANTON_SESSIONS_ROOT",
      "ANTON_SCANS_ROOT",
      "ANTON_TEST_CLAUDE_ARGV",
      "FAKE_SCAN_FIXTURE",
    ]);
    process.env.ANTON_STRINGER_BIN = fakeStringer;
    process.env.ANTON_CLAUDE_BIN = fakeClaude;
    process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
    process.env.ANTON_SCANS_ROOT = join(sandbox, "scans");
    process.env.ANTON_TEST_CLAUDE_ARGV = join(sandbox, "claude-argv.jsonl");
    process.env.FAKE_SCAN_FIXTURE = join(sandbox, "stored-scan.json");
    copyFileSync(STORED_SCAN, process.env.FAKE_SCAN_FIXTURE);

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

    // ── the board the scan lands on ──
    epicId = await beads.create(repo, {
      title: "Auth is trustworthy",
      type: "epic",
      acceptance: "- [ ] every session path is reviewed and covered",
      labels: ["area:auth"],
    });
    featureId = await beads.create(repo, {
      title: "Harden the session helpers",
      type: "feature",
      acceptance: "- [ ] refresh path covered by tests",
      context: `touches: ${OWNED_FILE}, src/lib/auth/token.ts`,
      labels: ["domain:eng", "risk:high", "size:M"],
    });
    await beads.link(repo, featureId, epicId, "parent-child");
    // A working-layer child: a CHILDLESS feature runs itself off its own Acceptance, so it may not
    // take a first child (§3.2) — this is what makes the feature an `attach:child` candidate.
    const childId = await beads.create(repo, {
      title: "Cover refreshSession",
      type: "task",
      acceptance: "- [ ] unit test for the refresh branch",
    });
    await beads.link(repo, childId, featureId, "parent-child");

    stringerBeadId = await beads.create(repo, {
      title: "Collapse the duplicated RunDetail shape",
      type: "task",
      acceptance: "- [ ] one declaration of RunDetail",
      context: `touches: ${COLLIDING_FILE}`,
      labels: ["domain:eng", "source:stringer", `stringer:duplication:${SHARED_HASH}`],
    });
    gardenerBeadId = await beads.create(repo, {
      title: "Duplicate run detail types flagged by the hygiene patrol",
      type: "task",
      acceptance: "- [ ] one declaration of RunDetail",
      context: `touches: ${COLLIDING_FILE}`,
      labels: ["domain:eng", `gardener:duplicate:${SHARED_HASH}`],
    });
  });

  afterAll(() => {
    tdb?.close();
    restoreEnv();
    bdRepo.cleanup();
  });

  it("routes a signal into the open feature that owns its file, and cross-links the collision", async () => {
    const before = await board();

    await expectJobStatus(tdb.db, await runScan(), "done");

    // anton resolved the board INTO the prompt — the verdict the routing rule keys on.
    const prompt = lastPrompt();
    expect(prompt).toContain(BOARD_CONTEXT_HEADING);
    expect(prompt).toContain(`${featureId} · attach:child · epic:${epicId}`);
    expect(prompt).toContain(`touches: ${OWNED_FILE}`);
    expect(prompt).toContain(`${stringerBeadId} · open · stringer:duplication:${SHARED_HASH}`);
    expect(prompt).toContain(`${gardenerBeadId} · open · gardener:duplicate:${SHARED_HASH}`);

    const after = await board();
    // Two signals in, ONE bead out: the owned one landed, the already-raised one did not.
    expect(after.length).toBe(before.length + 1);
    const [landed] = triaged(after);
    expect(landed).toBeDefined();
    expect(landed.title).toContain("refreshSession");

    // It landed INSIDE the feature that owns the file, with the reason it was routed there.
    expect(hasEdge(after, landed.id, featureId, "parent-child")).toBe(true);
    expect(landed.description).toContain(`routed: ${featureId}`);
    expect(landed.description).toContain(OWNED_FILE);

    // The cross-namespace collision was cross-linked, not duplicated.
    expect(hasEdge(after, stringerBeadId, gardenerBeadId, "related")).toBe(true);
    expect(triaged(after).some((b) => b.title.includes("RunDetail"))).toBe(false);

    // The §6 report still parses into the health record: one created, one deduped.
    const summary = await getLatestScanSummary(tdb.db, projectId);
    expect(summary?.triage).toEqual({ created: 1, deduped: 1 });
  });

  it("pulls the board before deriving the routing context", async () => {
    // The context is only as fresh as this checkout's local Dolt working set. A bead another machine
    // pushed since the last sync is an invisible fingerprint AND an invisible touch surface, so an
    // unpulled read is exactly how an unattended scan re-raises work that is already on the board.
    const sessions = await tdb.db.select().from(schema.sessions);
    const latest = sessions.sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0];
    const log = readFileSync(latest.logPath!, "utf8");

    expect(log).toContain("[stringer] board pull before read");
    expect(log.indexOf("board pull before read")).toBeLessThan(log.indexOf("board context:"));
  });

  it("files a discovered-from sibling instead when the owning feature's run has been captured", async () => {
    // The debt bead from the first pass is closed (so the signal is fresh again), and the feature is
    // now mid-run — a ticket added to it now would never be implemented.
    const landed = triaged(await board())[0];
    await beads.close(repo, landed.id);
    await beads.tag(repo, featureId, ["approved", "stage:implementing"]);

    const before = await board();
    await expectJobStatus(tdb.db, await runScan(), "done");

    const prompt = lastPrompt();
    expect(prompt).toContain(`${featureId} · attach:no (approved`);

    const after = await board();
    expect(after.length).toBe(before.length + 1);
    const sibling = triaged(after).find((b) => b.status !== "closed")!;
    expect(sibling.issue_type).toBe("feature");
    // Its own run target, under the same outcome, with provenance back to the feature it came from.
    expect(hasEdge(after, sibling.id, epicId, "parent-child")).toBe(true);
    expect(hasEdge(after, sibling.id, featureId, "discovered-from")).toBe(true);
    expect(hasEdge(after, sibling.id, featureId, "parent-child")).toBe(false);
  });

  it("tells the agent the board is unreadable rather than handing it silence", async () => {
    rmSync(join(repo, ".beads"), { recursive: true, force: true });

    await expectJobStatus(tdb.db, await runScan(), "done");

    const prompt = lastPrompt();
    expect(prompt).toContain("**UNAVAILABLE**");
    expect(prompt).toContain("Do NOT treat this as an empty board");
  });
});
