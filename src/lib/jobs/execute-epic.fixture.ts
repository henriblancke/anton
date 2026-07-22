/**
 * Shared fixture for the `execute-epic.*.integration.test.ts` suites. The e2e proof of "approved
 * epics run autonomously → worktree → PR → in-review" is large enough that its 25 cases are split
 * across several sibling files so they run in parallel (each drives a full REAL bd/git pipeline, so
 * one monolithic file was the suite's tall pole). Every split file builds an identical sandbox via
 * `createExecuteEpicSandbox()` here — one temp repo with a bare `origin`, fake `claude`/`gh`
 * binaries, a migrated in-memory anton.db, and an approved epic + two tickets — and exercises a
 * disjoint slice of the scenarios against it.
 *
 * Test-only. Skipped suites (no bd/git) never call this.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import { formatHumanNote } from "../beads/notes";
import * as schema from "../db/schema";
import { type Clock } from "./queue";
import { resetOperatorCache } from "../operator";
import { makeBdRepo, saveEnv } from "@/lib/testing/integration";

/** Fixed start-of-test wall clock. Reset before each case — see each suite's `beforeEach`. */
export const BASE_TIME_MS = 1_700_000_000_000;

/**
 * Reset ALL per-run DB state between cases — not just `jobs`. Every split suite shares one sandbox +
 * anton.db (they're expensive to build, so `beforeAll` builds them once), which means leaked `runs`/
 * `sessions` rows bleed across cases: an unfiltered `expect(runs).toHaveLength(1)` turns
 * order-dependent, and a lookup-by-epic-id can pick up a prior case's row. Delete children
 * (`sessions`) before parents (`runs`) to stay FK-safe. Every suite's `beforeEach` must call this
 * (alongside `clock.set(BASE_TIME_MS)`) — keeping it here means a future split can't silently drop
 * the reset the way clearing only `jobs` inline once did (anton-fj7c).
 */
export async function resetPerCaseState(tdb: TestDb): Promise<void> {
  await tdb.db.delete(schema.sessions);
  await tdb.db.delete(schema.runs);
  await tdb.db.delete(schema.jobs);
}

/** The operator's steer on ticket one; asserted to reach that ticket's dispatch prompt. */
export const HUMAN_NOTE = "STEER_MARKER_BFY4 — reuse the existing helper, do not add a new one";

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
}

/** Write an executable node script and return its path. */
export function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Wrap a fake-claude body so it reads the task prompt from stdin and the composed system prompt from
 * the file named by `--append-system-prompt-file` — matching the driver, which keeps both off argv so
 * no bead/contract text is visible in `ps` (anton-14tj). Inside `inner`, `fs`/`path` are required and
 * `prompt` (stdin), `append` (system-prompt file contents), `a` (argv), and `get(flag)` are in scope.
 */
export function fakeClaudeReadingStdin(inner: string): string {
  return `const fs=require('fs');const path=require('path');
const a=process.argv.slice(2);const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const sysFile=get('--append-system-prompt-file');
const append=sysFile?fs.readFileSync(sysFile,'utf8'):undefined;
let prompt='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{prompt+=c;});
process.stdin.on('end',()=>{
${inner}
});`;
}

/**
 * Advance `origin/main` ahead of the sandbox repo's LOCAL main by committing to a throwaway clone
 * of the bare remote and pushing. Leaves the sandbox repo's own main untouched (stale) so a run
 * that fetches origin/main sees a newer tip. Returns the new commit's sha.
 */
export function pushFreshBaseCommit(sandbox: string, bare: string, marker: string): string {
  const clone = mkdtempSync(join(sandbox, "fresh-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: clone, stdio: "ignore" });
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "ignore" });
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "anton-test"]);
  writeFileSync(join(clone, `${marker}.md`), `${marker}\n`);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", marker]);
  g(["push", "-q", "origin", "main"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
}

export interface ExecuteEpicSandbox {
  /** Temp dir holding `repo`, `remote.git`, `bin`, worktrees, and sessions. */
  sandbox: string;
  /** The working repo — `cwd` for bd/git and the project's `repoPath`. */
  repo: string;
  /** The bare remote wired as both git `origin` and the Dolt remote. */
  bare: string;
  /** Dir on PATH-substitute for the fake `claude`/`gh` bins; extra fakes are written here too. */
  binDir: string;
  /** Fresh in-memory anton.db (schema-migrated). */
  tdb: TestDb;
  /** Injectable wall clock the runner reads. */
  clock: FakeClock;
  /** The seeded project row's id. */
  projectId: string;
  /** The approved epic + its two child tickets (t1 carries `agent:nextjs` + a human note). */
  epicId: string;
  t1: string;
  t2: string;
  /** Path to the default success-path fake claude bin (tests reset ANTON_CLAUDE_BIN to it). */
  successClaude: string;
  /** Restores every env var this fixture set. Call in `afterAll`. */
  restoreEnv: () => void;
  /** Removes the temp sandbox and closes the db. Call in `afterAll`. */
  cleanup: () => void;
}

/**
 * Build the shared execute-epic e2e sandbox: a bare-remote-backed bd/git repo, fake `claude`/`gh`
 * binaries wired through env, a migrated in-memory anton.db with a `sandbox` project, and an
 * approved epic with two tickets (t1 tagged `agent:nextjs` and carrying a human steer note).
 */
export async function createExecuteEpicSandbox(): Promise<ExecuteEpicSandbox> {
  // Bare remote + working repo pushed to it; the git `origin` doubles as the Dolt remote (as
  // `anton setup` wires it), so the run's explicit beads.sync is exercised too.
  const bdRepo = makeBdRepo({ bare: true, initialCommit: true });
  const sandbox = bdRepo.dir;
  const repo = bdRepo.repo;
  const bare = bdRepo.bare!;
  const binDir = join(sandbox, "bin");
  mkdirSync(binDir);

  const epicId = await beads.create(repo, {
    title: "Ship feature X",
    type: "epic",
    description: "## Goal\nShip X.\n\n## Acceptance\nWorks.",
  });
  await beads.approve(repo, epicId);

  // Two tickets under the epic; t1 carries an agent tag to exercise agent-prompt loading.
  const c1 = execFileSync(
    "bd",
    ["create", "Ticket one", "--type", "task", "--parent", epicId, "--labels", "agent:nextjs", "--acceptance", "work file exists", "--json"],
    { cwd: repo, encoding: "utf8" },
  );
  const c2 = execFileSync(
    "bd",
    ["create", "Ticket two", "--type", "task", "--parent", epicId, "--acceptance", "work file exists", "--json"],
    { cwd: repo, encoding: "utf8" },
  );
  const idOf = (raw: string): string => {
    const p = JSON.parse(raw);
    const b = Array.isArray(p) ? p[0] : (p.issue ?? p);
    return b.id as string;
  };
  const t1 = idOf(c1);
  const t2 = idOf(c2);

  // A human steer left on t1 between the gates (anton-bfy4) — the run must carry it into that
  // ticket's dispatch prompt, and only that ticket's.
  await beads.note(repo, t1, formatHumanNote(HUMAN_NOTE, "Henri Blancke", new Date(0)));

  // Fake claude: make a change in the worktree, dump its stdin prompt / append-system-prompt-file
  // contents (so a test can assert the composed system prompt reached it AND that neither is on
  // argv), emit valid stream-json, succeed.
  const fakeClaude = writeBin(
    binDir,
    "claude",
    fakeClaudeReadingStdin(`fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'work '+Date.now()+' '+Math.random()+'\\n');
const dump=process.env.ANTON_TEST_CLAUDE_ARGV;
if(dump){fs.appendFileSync(dump,JSON.stringify({prompt,append,argv:a})+'\\n');}
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'s'});
e({type:'assistant',message:{content:[{type:'text',text:'implemented the ticket'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'s',num_turns:1,total_cost_usd:0.01,is_error:false});
process.exit(0);`),
  );
  const successClaude = fakeClaude;
  // Fake gh: echo a PR url.
  const fakeGh = writeBin(binDir, "gh", `console.log('https://github.com/acme/repo/pull/42');process.exit(0);`);

  // Env overrides scoped to this suite (restored in afterAll via the returned restorer).
  const restoreEnv = saveEnv([
    "ANTON_CLAUDE_BIN",
    "ANTON_GH_BIN",
    "ANTON_WORKTREES_ROOT",
    "ANTON_SESSIONS_ROOT",
    "ANTON_TEST_CLAUDE_ARGV",
    "ANTON_OPERATOR",
  ]);
  process.env.ANTON_CLAUDE_BIN = fakeClaude;
  process.env.ANTON_GH_BIN = fakeGh;
  process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
  process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
  process.env.ANTON_TEST_CLAUDE_ARGV = join(sandbox, "claude-argv.jsonl");
  process.env.ANTON_OPERATOR = "test-operator"; // claims must land on the human operator
  resetOperatorCache();

  // Test DB + project row.
  const tdb = makeTestDb();
  const clock = new FakeClock(BASE_TIME_MS);
  const projectId = randomUUID();
  await tdb.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: repo,
    defaultBranch: "main",
    // testCommand asserts claude ran before tests → proves ordering claude→tests.
    // seedPrompt asserts the operator seed layers into the composed system prompt.
    settingsJson: JSON.stringify({
      testCommand: "test -f AGENT_WORK.md",
      seedPrompt: "SEED_MARKER_QZX — prefer server components in this repo.",
    }),
  });

  return {
    sandbox,
    repo,
    bare,
    binDir,
    tdb,
    clock,
    projectId,
    epicId,
    t1,
    t2,
    successClaude,
    restoreEnv,
    cleanup: () => {
      tdb.close();
      bdRepo.cleanup();
    },
  };
}
