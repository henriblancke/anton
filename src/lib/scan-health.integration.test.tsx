// @vitest-environment jsdom
/**
 * End-to-end proof of anton-bz1w's acceptance: replay three consecutive scans through the REAL
 * nightly-stringer handler + REAL runner (fake `stringer` writing a canned scan, fake `claude`
 * standing in for /scan-triage), then read the stored summaries back and RENDER the Health page
 * surfaces off them (`CodebaseSignalsSection` + `HealthRail`, `components/health/`) — the delta a
 * founder actually sees has to survive the whole path, not just the unit that computes it. Three,
 * not two: the first pass is a baseline scan of the whole repo, so the first comparison a founder
 * may be shown is the third point. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { render, screen } from "@testing-library/react";

import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { getJob, type Clock } from "@/lib/jobs/queue";
import { makeNightlyStringerHandler } from "@/lib/jobs/nightly-stringer";
import { listScanSummaries, scanHealth } from "@/lib/scan-health";
import { CodebaseSignalsSection } from "@/components/health/codebase-signals-section";
import { HealthRail } from "@/components/health/health-rail";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Night one. A project's first scan has no `--delta` baseline, so stringer emits everything already
 * in the repo: a standing total, not the arrival rate every later pass measures. Nothing may be
 * subtracted from it.
 */
const BASELINE_SCAN = JSON.stringify({
  signals: [
    { Source: "todos", Kind: "todo", FilePath: "old.ts", Line: 1, Title: "TODO old" },
    { Source: "todos", Kind: "todo", FilePath: "older.ts", Line: 4, Title: "TODO older" },
  ],
  metadata: {},
});

/** A day's worth of stringer output: one CVE and two TODOs — critical + low, security + debt. */
const NOISY_SCAN = JSON.stringify({
  signals: [
    { Source: "vuln", Kind: "vulnerability", FilePath: "package.json", Line: 1, Title: "CVE-1" },
    { Source: "todos", Kind: "todo", FilePath: "a.ts", Line: 3, Title: "TODO a" },
    { Source: "todos", Kind: "todo", FilePath: "b.ts", Line: 7, Title: "TODO b" },
  ],
  metadata: {},
});

/** The next night: the CVE is gone and only one new TODO arrived — the codebase is calming down. */
const QUIETER_SCAN = JSON.stringify({
  signals: [{ Source: "todos", Kind: "todo", FilePath: "c.ts", Line: 2, Title: "TODO c" }],
  metadata: {},
});

describeBd("scan health e2e (real handler · real bd · fake stringer/claude)", () => {
  let bdRepo: BdRepo;
  let sandbox: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  let restoreEnv: () => void;

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
    // it can't (anton-qor2), so a remote-less sandbox would park every scan replayed here.
    bdRepo = makeBdRepo({ bare: true, initialCommit: true });
    sandbox = bdRepo.dir;
    const binDir = join(sandbox, "bin");
    mkdirSync(binDir);

    // Fake stringer: replay whatever scan FAKE_SCAN_JSON holds, honouring `-o <file>`, and rewrite
    // the `--delta` baseline under the scanned repo the way the real one does — that file is how
    // anton tells an arrival rate from a whole-repo baseline scan, so a fake without it would prove
    // the delta path against a series that could never happen.
    const fakeStringer = writeBin(
      binDir,
      "stringer",
      `const fs=require('fs');const path=require('path');const a=process.argv.slice(2);
const oi=a.indexOf('-o');const out=oi>=0?a[oi+1]:null;
if(out)fs.writeFileSync(out,process.env.FAKE_SCAN_JSON||'{"signals":[]}');
const state=path.join(a[1],'.stringer','last-scan.json');
let n=0;try{n=JSON.parse(fs.readFileSync(state,'utf8')).n+1;}catch{}
fs.mkdirSync(path.dirname(state),{recursive:true});
fs.writeFileSync(state,JSON.stringify({n}));
process.exit(0);`,
    );

    // Fake /scan-triage: create one bead per signal via bd, then close with the report line §6
    // specifies — which is where the summary's created/deduped counts come from.
    const fakeClaude = writeBin(
      binDir,
      "claude",
      `const fs=require('fs');const cp=require('child_process');
let prompt='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{prompt+=c;});
process.stdin.on('end',()=>{
  if(process.env.ANTON_TEST_CLAUDE_ARGV)fs.appendFileSync(process.env.ANTON_TEST_CLAUDE_ARGV,JSON.stringify({prompt})+'\\n');
  const m=prompt.match(/scan file to triage is: (\\S+)/);
  let n=0;
  if(m){const scan=JSON.parse(fs.readFileSync(m[1],'utf8'));
    for(const s of (scan.signals||[])){
      n++;
      cp.execFileSync('bd',['create','Triaged: '+s.Title,'--type','task','--acceptance','fix it','--json'],{cwd:process.cwd()});
    }
  }
  const line='created: '+n+' ('+n+' features, 0 tickets) · epics: 1 attached, 0 created · deduped: 1 · dropped-as-noise: 0 · deferred (over cap): 0';
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:line,is_error:false})+'\\n');
  process.exit(0);
});`,
    );

    restoreEnv = saveEnv([
      "ANTON_STRINGER_BIN",
      "ANTON_CLAUDE_BIN",
      "ANTON_SESSIONS_ROOT",
      "ANTON_SCANS_ROOT",
      "ANTON_TEST_CLAUDE_ARGV",
      "FAKE_SCAN_JSON",
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
      repoPath: bdRepo.repo,
      defaultBranch: "main",
    });
  });

  afterAll(() => {
    tdb?.close();
    restoreEnv();
    bdRepo.cleanup();
  });

  it("replays three scans into a stored, charted delta", async () => {
    // Night one: the baseline pass — what was already in the repo.
    process.env.FAKE_SCAN_JSON = BASELINE_SCAN;
    expect((await getJob(tdb.db, await runScan()))?.status).toBe("done");

    // Night two, a day later: three signals, one of them a CVE.
    clock.advance(86_400_000);
    process.env.FAKE_SCAN_JSON = NOISY_SCAN;
    expect((await getJob(tdb.db, await runScan()))?.status).toBe("done");

    // Night three: one TODO and no CVE.
    clock.advance(86_400_000);
    process.env.FAKE_SCAN_JSON = QUIETER_SCAN;
    expect((await getJob(tdb.db, await runScan()))?.status).toBe("done");

    // 1. Every pass left a record, newest first.
    const summaries = await listScanSummaries(tdb.db, projectId);
    expect(summaries.length).toBe(3);
    const [third, second, first] = summaries;

    // Nothing preceded it, so it carries no delta — a first scan is not a scan with no change.
    expect(first.counts.total).toBe(2);
    expect(first.delta).toBeUndefined();
    expect(first.jobId).toBeTruthy();
    expect(first.sessionId).toBeTruthy();

    expect(second.counts.total).toBe(3);
    expect(second.counts.bySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 2 });
    expect(second.counts.byClass.security).toBe(1);
    expect(second.counts.byClass.debt).toBe(2);
    // Its predecessor is the BASELINE — a standing total. Subtracting it would chart "+1, problems
    // arriving faster" out of two quantities that were never the same measurement.
    expect(second.delta).toBeUndefined();
    // The triage session's own report line, parsed back off the health record.
    expect(second.triage).toEqual({ created: 3, deduped: 1 });

    // The first honest comparison: two incremental scans, one day apart.
    expect(third.counts.total).toBe(1);
    expect(third.counts.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 1 });
    expect(third.delta).toEqual({
      total: -2,
      bySeverity: { critical: -1, high: 0, medium: 0, low: -1 },
    });

    // 2. The board's view of the same rows — oldest → newest, delta on the latest.
    const health = scanHealth(summaries)!;
    expect(health.points.map((p) => p.total)).toEqual([2, 3, 1]);
    expect(health.latest.id).toBe(third.id);
    expect(health.delta?.total).toBe(-2);

    // 3. And what the founder actually reads: the severity split on the Health page's own section,
    //    and the charted delta on its vitals rail — the two surfaces that replaced the old panel.
    render(
      <>
        <CodebaseSignalsSection scanHealth={health} />
        <HealthRail
          slug="sandbox"
          health={{
            worthALook: [],
            housekeeping: [],
            hygiene: undefined,
            scanHealth: health,
            trajectory: undefined,
            stoppedCount: 0,
            staleServers: [],
          }}
        />
      </>,
    );
    expect(screen.getByText("1 low")).toBeTruthy();
    expect(screen.getByText(/−2 vs previous scan/)).toBeTruthy();
    expect(screen.getByTitle(/arriving more slowly/)).toBeTruthy();
    const chartLabel = screen.getByRole("img").getAttribute("aria-label")!;
    expect(chartLabel).toContain("3 (1 critical, 2 low)");
    expect(chartLabel).toContain("1 (1 low)");
  });

  it("hands the triage prompt this project's severity mapping", () => {
    const log = readFileSync(join(sandbox, "claude-argv.jsonl"), "utf8");
    const prompt = (JSON.parse(log.trim().split("\n").pop()!) as { prompt: string }).prompt;
    expect(prompt).toContain("This project's severity mapping");
    expect(prompt).toContain("| critical | risk:high | P0 |");
    expect(prompt).toContain("| low | risk:low | P3 |");
  });
});
