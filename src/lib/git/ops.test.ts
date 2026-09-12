/**
 * Integration tests for openPullRequest idempotency (anton-kh6). Uses REAL git against a temp
 * repo + bare `origin`, and a stateful fake `gh` (ANTON_GH_BIN) that models `pr create` failing
 * on a duplicate and `pr list --head <branch>` resolving the branch's PR. Proves a resumed
 * execute-epic run that re-reaches the PR step reuses the existing PR instead of erroring on
 * `gh pr create`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_TIMEOUT_ENV,
  commitAll,
  commitMarker,
  DEFAULT_DIFF_PATCH_CHARS,
  deletionPatch,
  diffAgainstBase,
  findOpenPullRequest,
  listDirBlobsAtRev,
  lookupOpenPullRequest,
  markPullRequestDraft,
  needsHooksPathOverrideForMerge,
  openPullRequest,
  pullRequestState,
  pushBranch,
  readFileAtRev,
  readPathHistory,
  distanceBehindUpstream,
  readPreservedCommitFor,
  readWorktreeState,
  resolveFreshBase,
  resolveHooksPathOverride,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  worktreeHasCommitFor,
  worktreeHasPreservedCommitFor,
  worktreeTipIsPreservedCommitFor,
  branchAddedCommit,
  describeCommit,
  branchContainsCommit,
  branchSatisfiesTicket,
  readSatisfiedClaims,
  satisfiedMarkerSubject,
  satisfiedMarkerTarget,
  SATISFIES_TRAILER,
} from "./ops";
import { GH_BIN_ENV } from "./ops";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

suite("openPullRequest idempotency (real git · fake gh)", () => {
  let sandbox: string;
  let repo: string;
  let ghState: string;
  let prevGh: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-ops-"));
    repo = join(sandbox, "repo");
    const bare = join(sandbox, "remote.git");
    const binDir = join(sandbox, "bin");
    ghState = join(sandbox, "gh-state.json");
    mkdirSync(repo);
    mkdirSync(binDir);

    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["remote", "add", "origin", bare]);
    g(["push", "-q", "-u", "origin", "main"]);
    g(["checkout", "-q", "-b", "anton/epic-1"]);
    writeFileSync(join(repo, "work.md"), "work\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1"]);

    // Stateful fake gh: `pr create` records the branch's PR (and fails if one already exists);
    // `pr view <branch> --json ...` returns the recorded PR as JSON, else exits non-zero.
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs=require('fs');
const STATE=${JSON.stringify(ghState)};
const a=process.argv.slice(2);
const read=()=>{try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}catch{return{};}};
const write=s=>fs.writeFileSync(STATE,JSON.stringify(s));
const get=f=>{const i=a.indexOf(f);return i>=0?a[i+1]:undefined;};
const branches=s=>Object.keys(s).filter(k=>k!=='__next');
if(a[0]==='pr'&&a[1]==='create'){
  const branch=get('--head');const s=read();
  if(s[branch]){process.stderr.write('a pull request for branch already exists\\n');process.exit(1);}
  const n=(s.__next||42);s[branch]={number:n,url:'https://github.com/acme/repo/pull/'+n,state:'OPEN',isDraft:false,title:get('--title'),body:get('--body')};s.__next=n+1;write(s);
  process.stdout.write(s[branch].url+'\\n');process.exit(0);
}
if(a[0]==='pr'&&a[1]==='edit'){
  const sel=a[2];const s=read();
  if(s.__editFails){process.stderr.write('HTTP 403: Resource not accessible by integration\\n');process.exit(1);}
  const key=branches(s).find(k=>k===sel||String(s[k].number)===sel||s[k].url===sel);
  if(!key){process.stderr.write('no pull requests found\\n');process.exit(1);}
  s[key].title=get('--title');s[key].body=get('--body');write(s);process.exit(0);
}
if(a[0]==='pr'&&a[1]==='list'){
  // Like the real gh: exit 0 with an empty array when the branch has no open PR.
  const branch=get('--head');const s=read();const pr=s[branch];
  process.stdout.write(JSON.stringify(pr&&pr.state==='OPEN'?[pr]:[])+'\\n');process.exit(0);
}
if(a[0]==='pr'&&a[1]==='view'){
  const branch=a[2];const s=read();const pr=s[branch];
  if(!pr){process.stderr.write('no pull requests found\\n');process.exit(1);}
  process.stdout.write(JSON.stringify(pr)+'\\n');process.exit(0);
}
if(a[0]==='pr'&&a[1]==='ready'){
  const sel=a[2];const s=read();
  const key=branches(s).find(k=>k===sel||String(s[k].number)===sel||s[k].url===sel);
  if(!key){process.stderr.write('no pull requests found\\n');process.exit(1);}
  s[key].isDraft=a.includes('--undo');write(s);process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
    prevGh = process.env[GH_BIN_ENV];
    process.env[GH_BIN_ENV] = fakeGh;
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("opens a PR the first time, then reuses the same PR on a resumed run", async () => {
    const opts = {
      repoPath: repo,
      branch: "anton/epic-1",
      base: "main",
      title: "Epic 1",
      body: "body",
    };

    const first = await openPullRequest(opts);
    expect(first.number).toBe(42);
    expect(first.ref).toBe("gh-42");

    // Second call (resume) must NOT error on `gh pr create` — it reuses the existing PR.
    const second = await openPullRequest(opts);
    expect(second.number).toBe(42);
    expect(second.ref).toBe("gh-42");
    expect(second.url).toBe(first.url);
  });

  it("drafts an orphaned PR, then hands it back ready when the run re-reaches the PR step", async () => {
    // The park→resume round trip (anton-3apm): a run that parks on its review gate drafts the PR it
    // finds on the branch so un-reviewed work can't be merged, and the resumed run that passes the
    // gate must leave a MERGEABLE PR behind — a draft that stays a draft is a stuck epic.
    const opts = { repoPath: repo, branch: "anton/epic-1", base: "main", title: "Epic 1", body: "b" };
    const opened = await openPullRequest(opts);
    expect(opened.isDraft).toBe(false);

    expect(await markPullRequestDraft(repo, opened.ref)).toBe(true);
    expect(await findOpenPullRequest(repo, "anton/epic-1")).toMatchObject({
      number: 42,
      isDraft: true,
    });

    const resumed = await openPullRequest(opts);
    expect(resumed.number).toBe(42);
    expect(resumed.isDraft).toBe(false);
    expect(await findOpenPullRequest(repo, "anton/epic-1")).toMatchObject({ isDraft: false });
  });

  it("rewrites the reused PR's title and body with the current attempt's", async () => {
    // A retry that lost the bead ref re-runs its review and can produce a different advisory set.
    // The PR body is where those advisories meet the founder at the merge gate, so a reused PR that
    // kept the first attempt's body would show findings nobody reported and hide the ones that hold.
    const opts = { repoPath: repo, branch: "anton/epic-1", base: "main", title: "Epic 1", body: "round 1" };
    await openPullRequest(opts);

    await openPullRequest({ ...opts, title: "Epic 1 (retry)", body: "round 2 · advisory: unguarded route" });

    expect(JSON.parse(readFileSync(ghState, "utf8"))["anton/epic-1"]).toMatchObject({
      title: "Epic 1 (retry)",
      body: "round 2 · advisory: unguarded route",
    });
  });

  it("reports a refused refresh as bodyStale rather than passing the PR off as current", async () => {
    // `gh pr edit` can fail on a token's permissions or a network blip. The body is the only place
    // this run's advisory findings are written, so the caller has to be TOLD they never landed —
    // silently returning the reused PR loses them between the review and the merge gate.
    const opts = { repoPath: repo, branch: "anton/epic-1", base: "main", title: "Epic 1", body: "round 1" };
    const opened = await openPullRequest(opts);
    expect(opened.bodyStale).toBeFalsy();

    const state = JSON.parse(readFileSync(ghState, "utf8"));
    writeFileSync(ghState, JSON.stringify({ ...state, __editFails: true }));

    const reused = await openPullRequest({ ...opts, body: "round 2 · advisory: unguarded route" });

    expect(reused.number).toBe(42);
    expect(reused.bodyStale).toBe(true);
    expect(JSON.parse(readFileSync(ghState, "utf8"))["anton/epic-1"].body).toBe("round 1");
  });

  it("rewrites the body of a drafted orphan as it readies it", async () => {
    const opts = { repoPath: repo, branch: "anton/epic-1", base: "main", title: "Epic 1", body: "round 1" };
    const opened = await openPullRequest(opts);
    await markPullRequestDraft(repo, opened.ref);

    const readied = await openPullRequest({ ...opts, body: "round 2" });

    expect(readied.isDraft).toBe(false);
    expect(JSON.parse(readFileSync(ghState, "utf8"))["anton/epic-1"]).toMatchObject({ body: "round 2" });
  });

  it("reports a draft flip gh refused rather than assuming it landed", async () => {
    // The caller says "still open, draft it by hand" on a false — so a silent true would be the lie.
    expect(await markPullRequestDraft(repo, "gh-999")).toBe(false);
    expect(await markPullRequestDraft(repo, "gh-")).toBe(false);
  });

  it("finds no PR for a branch that has none", async () => {
    expect(await lookupOpenPullRequest(repo, "anton/never-opened")).toEqual({});
    expect(await findOpenPullRequest(repo, "anton/never-opened")).toBeUndefined();
  });

  it("reports a lookup gh could not answer as failed, not as 'no PR'", async () => {
    // `gh` exits non-zero on an expired token or a network blip exactly as it would for a branch
    // with no PR. A caller that drafts an orphaned PR before parking must not read the two as one:
    // it would report "no PR was opened" over a live PR carrying un-reviewed work.
    const failing = join(sandbox, "bin", "gh-failing");
    writeFileSync(failing, `#!/usr/bin/env node\nprocess.stderr.write('HTTP 401\\n');process.exit(1);\n`);
    chmodSync(failing, 0o755);
    const ok = process.env[GH_BIN_ENV];
    process.env[GH_BIN_ENV] = failing;
    try {
      expect(await lookupOpenPullRequest(repo, "anton/epic-1")).toEqual({ failed: true });
    } finally {
      process.env[GH_BIN_ENV] = ok;
    }
  });
});

/**
 * Regression coverage for the worktree push path (review finding): `pushBranch`/`openPullRequest`
 * must run `git push` from the WORKTREE, never from the base repo checkout — a project's own
 * `pre-push` hook can inspect the working tree it runs in (a "did you forget to commit a fix"
 * staleness check, as seen in a real downstream project), and that hook sees whatever happens to be
 * checked out at the cwd `git push` was invoked from. Proven with a REAL pre-push hook recording its
 * own cwd's checked-out branch, exercised against a base repo deliberately left on an unrelated
 * branch — the exact shape of anton's real usage, where the base repo checkout persists across runs
 * on whatever branch the last run left it on.
 */
suite("push runs from the worktree, not the base repo (real git · real pre-push hook)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let hookLog: string;

  const g = (args: string[], cwd = repo) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-push-cwd-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    hookLog = join(sandbox, "hook.log");
    mkdirSync(repo);
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["remote", "add", "origin", bare]);
    g(["push", "-q", "-u", "origin", "main"]);

    // A real pre-push hook — client-side, in the pushing repo's own .git/hooks — that records the
    // branch checked out at ITS OWN cwd (git sets it before invoking hooks), exactly what a
    // project's stale-working-tree gate reads.
    const hooksDir = join(repo, ".git", "hooks");
    const hookPath = join(hooksDir, "pre-push");
    writeFileSync(hookPath, `#!/usr/bin/env sh\ngit rev-parse --abbrev-ref HEAD >> "${hookLog}"\n`);
    chmodSync(hookPath, 0o755);

    // The feature branch, checked out only in a SEPARATE worktree — mirroring anton, where the run's
    // branch lives in `.anton-worktrees/...` and the base repo checkout is never moved onto it.
    g(["worktree", "add", "-q", "-b", "anton/epic-1", join(sandbox, "worktree")]);
    writeFileSync(join(sandbox, "worktree", "work.md"), "work\n");
    g(["add", "-A"], join(sandbox, "worktree"));
    g(["commit", "-q", "-m", "t1"], join(sandbox, "worktree"));

    // The base repo checkout is left on `main` — whatever an unrelated prior run left it on, same as
    // execute-epic's `repoPath` in production. This is the exact mismatch the review flagged: pushing
    // `-C repo` would run the hook with `main` checked out while pushing `anton/epic-1`.
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("pushBranch runs the pre-push hook against the worktree's checkout, not the base repo's", async () => {
    await pushBranch(join(sandbox, "worktree"), "anton/epic-1");

    expect(readFileSync(hookLog, "utf8").trim()).toBe("anton/epic-1");
    // The base repo's own checkout never moved off main — proof the push didn't need it to.
    expect(
      execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe("main");
  });

  it("pushBranch against the base repo would have failed the hook — pinning what the bug looked like", async () => {
    // The regression this guards: pushing `-C repo` (the base checkout, still on main) runs the hook
    // with the WRONG branch checked out. Exercised directly against the old call shape so a revert of
    // the worktreePath plumbing is caught even if a caller stops passing it.
    await pushBranch(repo, "anton/epic-1");

    expect(readFileSync(hookLog, "utf8").trim()).toBe("main");
    expect(readFileSync(hookLog, "utf8").trim()).not.toBe("anton/epic-1");
  });

  it("openPullRequest pushes from worktreePath when given one, leaving the base repo checkout untouched", async () => {
    process.env[GH_BIN_ENV] = writeBin(
      join(sandbox, "bin"),
      "gh",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){process.stdout.write('https://github.com/acme/repo/pull/1\\n');process.exit(0);}
process.exit(0);`,
    );

    await openPullRequest({
      repoPath: repo,
      worktreePath: join(sandbox, "worktree"),
      branch: "anton/epic-1",
      base: "main",
      title: "Epic 1",
      body: "body",
    });

    expect(readFileSync(hookLog, "utf8").trim()).toBe("anton/epic-1");
    expect(
      execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe("main");
  });

  it("openPullRequest falls back to pushing from repoPath when no worktreePath is given", async () => {
    process.env[GH_BIN_ENV] = writeBin(
      join(sandbox, "bin"),
      "gh",
      `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write('[]\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){process.stdout.write('https://github.com/acme/repo/pull/1\\n');process.exit(0);}
process.exit(0);`,
    );
    // No separate worktree here — the branch is checked out directly in `repo` itself (a distinct
    // branch, since `anton/epic-1` is already checked out in the sibling worktree from `beforeEach`
    // and git refuses to check out a branch twice) — the shape every caller with no worktree of its
    // own is in.
    g(["checkout", "-q", "-b", "anton/no-worktree"]);

    await openPullRequest({
      repoPath: repo,
      branch: "anton/no-worktree",
      base: "main",
      title: "No worktree",
      body: "body",
    });

    expect(readFileSync(hookLog, "utf8").trim()).toBe("anton/no-worktree");
  });
});

suite("resolveHooksPathOverride (real git)", () => {
  let sandbox: string;
  let repo: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-hookspath-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "anton-test"], { stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns undefined when core.hooksPath is unset", async () => {
    expect(await resolveHooksPathOverride(repo)).toBeUndefined();
  });

  it("absolutizes a relative core.hooksPath against the repo", async () => {
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky/_"], { stdio: "ignore" });
    expect(await resolveHooksPathOverride(repo)).toBe(join(repo, ".husky/_"));
  });

  it("passes an absolute core.hooksPath through unchanged", async () => {
    const abs = join(sandbox, "shared-hooks");
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", abs], { stdio: "ignore" });
    expect(await resolveHooksPathOverride(repo)).toBe(abs);
  });

  // `core.hooksPath` accepts `~/…`; a plain `--get` returns it literally, and naively resolving
  // that against repoPath produces a nonexistent `<repo>/~/…` path.
  it("expands a ~-prefixed core.hooksPath to $HOME, not a literal ~ under the repo", async () => {
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", "~/anton-hookspath-test-home"], {
      stdio: "ignore",
    });
    const resolved = await resolveHooksPathOverride(repo);
    expect(resolved).not.toContain("~");
    expect(resolved).toBe(join(homedir(), "anton-hookspath-test-home"));
  });

  // An `includeIf "onbranch:…"` selecting a DIFFERENT hooksPath for the worktree's branch must be
  // read from the WORKTREE, not the base repo — which may sit on an unrelated branch (main) for the
  // run's whole duration and would silently miss the conditional.
  it("reads core.hooksPath from the worktree's own branch-conditional includeIf, not the base repo's", async () => {
    const includeFile = join(sandbox, "onbranch-hooks.gitconfig");
    writeFileSync(includeFile, "[core]\n\thooksPath = .hooks-for-feature\n");
    execFileSync(
      "git",
      ["-C", repo, "config", `includeIf.onbranch:anton/**.path`, includeFile],
      { stdio: "ignore" },
    );

    // Base repo stays on `main` — the includeIf does not match here, so core.hooksPath is unset.
    expect(await resolveHooksPathOverride(repo)).toBeUndefined();

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    mkdirSync(join(worktree, ".hooks-for-feature"));
    // Queried with the worktree given: the includeIf matches ITS checked-out branch.
    expect(await resolveHooksPathOverride(repo, worktree)).toBe(
      join(worktree, ".hooks-for-feature"),
    );
  });

  // A relative core.hooksPath pointing at a directory TRACKED in git has its own copy per
  // worktree/branch (unlike Husky's generated, gitignored `.husky/_`). The override
  // must prefer the worktree's own copy when one exists on disk, not hardwire the base repo's.
  it("prefers the worktree's own copy of a tracked relative hooksPath over the base repo's", async () => {
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "pre-commit"), "base version\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".githooks"], { stdio: "ignore" });

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // The worktree's own tracked copy diverges — this PR's own change to the hooks, say.
    writeFileSync(join(worktree, ".githooks", "pre-commit"), "feature version\n");

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(worktree, ".githooks"));
  });

  // The Husky case stays correct: a GENERATED directory has no copy in a cold worktree at all, so
  // there is nothing to prefer — the base repo is still the right (only) source. Husky 9's installer
  // writes `.husky/_/.gitignore` (`*`) itself on `prepare` — that file is never committed either, so
  // the base repo tracks NOTHING under `.husky/_` at all (checking gitignore state instead would miss
  // this: the rule ignores the directory's contents without ever naming the directory itself, and a
  // cold clone that never ran `prepare` has no `.gitignore` there to consult in the first place — PR
  // #263 review).
  it("falls back to the base repo's copy when the worktree has none (generated hooks, never committed)", async () => {
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init", "--allow-empty"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky/_"], { stdio: "ignore" });
    // Simulates a local `prepare` install: materialized on disk, but never `git add`ed.
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", ".gitignore"), "*\n");
    writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/usr/bin/env sh\nexit 0\n");

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // Cold worktree: nothing under .husky/_ was ever committed, so nothing was checked out here.

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(repo, ".husky", "_"));
  });

  // A TRACKED hooks directory absent from the worktree is a different situation from Husky's
  // generated one above: the feature branch itself deleted or migrated it, so git would run no hook
  // at all — falling back to the base repo's stale copy would revive a hook the branch intentionally
  // removed, and could block landing the very PR that deletes it (PR #263 review).
  it("does not fall back to the base repo's copy of a tracked hooks dir the worktree's branch deleted", async () => {
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "pre-commit"), "base version\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".githooks"], { stdio: "ignore" });

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // The feature branch deletes the tracked hooks directory entirely.
    execFileSync("git", ["-C", worktree, "rm", "-rq", ".githooks"], { stdio: "ignore" });
    execFileSync("git", ["-C", worktree, "commit", "-q", "-m", "remove hooks"], { stdio: "ignore" });

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(worktree, ".githooks"));
  });

  // A core.hooksPath containing a pathspec metacharacter must be matched LITERALLY, not as a glob —
  // otherwise a coincidentally-matching tracked file elsewhere in the repo makes an untracked,
  // generated directory look tracked, and the override wrongly refuses to fall back to it (PR #263
  // review, round 2).
  it("treats a hooksPath containing a pathspec metacharacter as a literal name, not a glob", async () => {
    // `.hooks*` never exists anywhere — but `.hooks-config` is tracked, and would match the glob
    // `.hooks*` under a naive (non-literal) `ls-files` query.
    mkdirSync(join(repo, ".hooks-config"));
    writeFileSync(join(repo, ".hooks-config", "settings"), "\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".hooks*"], { stdio: "ignore" });

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // `.hooks*` was never tracked itself — only the unrelated `.hooks-config` was — so this is the
    // Husky-style "generated, never committed" case and must fall back to a base-repo path, never the
    // nonexistent worktree path a glob match on `.hooks-config` would wrongly justify skipping.
    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(repo, ".hooks*"));
  });

  // A relative core.hooksPath validly climbs out of the repo via `..` (git-config(1) places no
  // restriction on it) — a shared hooks directory living beside several checkouts, say. Such a path
  // can never be in ANY checkout's index, and `git ls-files` REJECTS a pathspec outside the
  // repository outright (exit 128), rather than answering "not tracked" (exit 1) — so the tracked-hook
  // probe must never even run for it, or it throws and aborts the commit/push (PR #263 review,
  // round 3).
  it("falls back to the base repo's copy of a hooksPath that climbs outside the repo via ..", async () => {
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init", "--allow-empty"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", "../shared-hooks"], {
      stdio: "ignore",
    });
    mkdirSync(join(sandbox, "shared-hooks"));
    writeFileSync(join(sandbox, "shared-hooks", "pre-push"), "#!/usr/bin/env sh\nexit 0\n");

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // The worktree has no sibling `shared-hooks` of its own — only the one beside the base repo.

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(sandbox, "shared-hooks"));
  });

  // A directory name that merely BEGINS with two dots, like `..hooks`, is not a `..` traversal —
  // `path.relative` can legitimately return it unchanged for a same-level name, and a naive
  // `startsWith("..")` would misclassify it as escaping the repo, skip the tracked-hooks probe, and
  // wrongly revive the base repo's stale copy of a directory the worktree's branch actually deleted
  // on purpose (PR #263 review, round 4) — the same real-tracked-deletion case as the `.githooks`
  // test above, just with a name shaped like a traversal.
  it("does not mistake a same-level directory name starting with '..' for a parent traversal", async () => {
    mkdirSync(join(repo, "..hooks"));
    writeFileSync(join(repo, "..hooks", "pre-commit"), "base version\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", "..hooks"], { stdio: "ignore" });

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", worktree, "rm", "-rq", "..hooks"], { stdio: "ignore" });
    execFileSync("git", ["-C", worktree, "commit", "-q", "-m", "remove hooks"], { stdio: "ignore" });

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(worktree, "..hooks"));
  });

  // `.git` is git's one built-in case where a relative core.hooksPath resolves to a REAL directory
  // in the base repo but a plain FILE in every linked worktree (a "gitfile" pointer to the shared
  // gitdir, per gitrepository-layout(5)) — `existsSync` alone accepts that file as the hooks
  // directory and silently runs no hook at all from a worktree push, while the base repo's own
  // `.git` keeps working fine (PR #263 review, round 5).
  it("resolves core.hooksPath=.git to the base repo's real directory, not the worktree's gitfile", async () => {
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init", "--allow-empty"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".git"], { stdio: "ignore" });

    const worktree = join(sandbox, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "anton/epic-1", worktree], {
      stdio: "ignore",
    });
    // Confirm the setup actually reproduces the collision: the worktree's .git is a file, not a dir.
    expect(statSync(join(worktree, ".git")).isDirectory()).toBe(false);

    expect(await resolveHooksPathOverride(repo, worktree)).toBe(join(repo, ".git"));
  });

  // A quoted core.hooksPath keeps leading/trailing whitespace verbatim (git-config(1)) — the shared
  // `git()` helper's blanket stdout.trim() would silently rewrite
  // ".hooks " to a directory (".hooks") that doesn't exist.
  it("preserves leading/trailing whitespace in a literal core.hooksPath", async () => {
    const literalName = ".hooks ";
    mkdirSync(join(repo, literalName));
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", literalName], { stdio: "ignore" });
    // Confirm git itself really did store and echo it with the trailing space, so this test would
    // fail loudly if a future git version's quoting behavior ever changed.
    expect(
      execFileSync("git", ["-C", repo, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
      }),
    ).toBe(`${literalName}\n`);

    expect(await resolveHooksPathOverride(repo)).toBe(join(repo, literalName));
  });
});

// A caller merging a fetched ref into its own worktree needs a NARROWER answer than
// resolveHooksPathOverride's "what does the current checkout need": whether THIS merge's own
// post-merge fires correctly with no override, or needs one supplied. Getting this wrong in either
// direction breaks a real case (PR #263 review, rounds 6-8):
// - a tracked hooksPath the incoming ref is about to introduce/change needs NO override (native
//   per-worktree resolution already gets it right once the merge lands; a pre-merge value is stale)
// - a generated hooksPath (Husky's `.husky/_`) no ref ever tracks DOES need the base repo's override
//   (no fetch ever introduces it, so there's nothing for native resolution to pick up either)
suite("needsHooksPathOverrideForMerge (real git)", () => {
  let sandbox: string;
  let repo: string;
  let remote: string;
  let worktree: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-mergehooks-"));
    repo = join(sandbox, "repo");
    remote = join(sandbox, "remote.git");
    worktree = join(sandbox, "worktree");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "anton-test"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init", "--allow-empty"], {
      stdio: "ignore",
    });
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "branch", "feature"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "push", "-q", "origin", "main", "feature"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "review-copy", worktree, "feature"], {
      stdio: "ignore",
    });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns false when core.hooksPath is unset", async () => {
    execFileSync("git", ["-C", worktree, "fetch", "-q", "origin", "feature"], { stdio: "ignore" });
    expect(await needsHooksPathOverrideForMerge(repo, worktree, "origin/feature")).toBe(false);
  });

  it("returns false when core.hooksPath is absolute (already fully resolved)", async () => {
    execFileSync("git", ["-C", worktree, "config", "core.hooksPath", join(sandbox, "abs-hooks")], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", worktree, "fetch", "-q", "origin", "feature"], { stdio: "ignore" });
    expect(await needsHooksPathOverrideForMerge(repo, worktree, "origin/feature")).toBe(false);
  });

  it("returns false when the incoming ref itself tracks the relative hooksPath", async () => {
    execFileSync("git", ["-C", worktree, "config", "core.hooksPath", ".githooks"], {
      stdio: "ignore",
    });
    // A reviewer's push to `feature` adds a tracked hooks directory this worktree doesn't have yet.
    const clone = join(sandbox, "reviewer-push");
    execFileSync("git", ["clone", "-q", remote, clone], { stdio: "ignore" });
    execFileSync("git", ["-C", clone, "checkout", "-q", "feature"], { stdio: "ignore" });
    execFileSync("git", ["-C", clone, "config", "user.email", "t@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", clone, "config", "user.name", "anton-test"], { stdio: "ignore" });
    mkdirSync(join(clone, ".githooks"));
    writeFileSync(join(clone, ".githooks", "post-merge"), "#!/bin/sh\nexit 0\n");
    execFileSync("git", ["-C", clone, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", clone, "commit", "-q", "-m", "reviewer adds hooks"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", clone, "push", "-q", "origin", "feature"], { stdio: "ignore" });

    execFileSync("git", ["-C", worktree, "fetch", "-q", "origin", "feature"], { stdio: "ignore" });
    expect(await needsHooksPathOverrideForMerge(repo, worktree, "origin/feature")).toBe(false);
  });

  it("returns true when the relative hooksPath is generated and no ref tracks it", async () => {
    execFileSync("git", ["-C", worktree, "config", "core.hooksPath", ".husky/_"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", worktree, "fetch", "-q", "origin", "feature"], { stdio: "ignore" });
    // `.husky/_` is never committed to any ref (Husky's own installer writes it locally on
    // `prepare`), so this must say "override needed" even though nothing was fetched to introduce it.
    expect(await needsHooksPathOverrideForMerge(repo, worktree, "origin/feature")).toBe(true);
  });
});

/**
 * Proves the replacement for the deleted symlink-into-the-worktree + `info/exclude` bridge (PR
 * #263): a relative `core.hooksPath` configured in the base repo still fires from a worktree push,
 * with nothing materialized in the worktree's own working tree at all.
 */
suite("pushBranch fires a relative core.hooksPath configured in the base repo (real git)", () => {
  let sandbox: string;
  let repo: string;
  let worktree: string;
  let bare: string;
  let hookLog: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-hookspath-push-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    worktree = join(sandbox, "worktree");
    hookLog = join(sandbox, "hook.log");
    mkdirSync(repo);
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    const g = (args: string[], cwd = repo) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    g(["remote", "add", "origin", bare]);

    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["push", "-q", "-u", "origin", "main"]);

    // Relative hooksPath, resolved in the BASE repo — never materialized in the worktree. Set only
    // AFTER the initial `main` push above, so the hook log captures only the test's own push.
    mkdirSync(join(repo, ".githooks"));
    const hookPath = join(repo, ".githooks", "pre-push");
    writeFileSync(hookPath, `#!/usr/bin/env sh\ngit rev-parse --abbrev-ref HEAD >> "${hookLog}"\n`);
    chmodSync(hookPath, 0o755);
    g(["config", "core.hooksPath", ".githooks"]);

    g(["worktree", "add", "-q", "-b", "anton/epic-1", worktree]);
    writeFileSync(join(worktree, "work.md"), "work\n");
    g(["add", "-A"], worktree);
    g(["commit", "-q", "-m", "t1"], worktree);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fires the base repo's relative-hooksPath pre-push hook when pushing from the worktree", async () => {
    const hooksPath = await resolveHooksPathOverride(repo);
    await pushBranch(worktree, "anton/epic-1", hooksPath);

    expect(readFileSync(hookLog, "utf8").trim()).toBe("anton/epic-1");
    // Nothing materialized inside the worktree — no symlink, no bridged directory.
    expect(existsSync(join(worktree, ".githooks"))).toBe(false);
  });
});

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

describe("pullRequestState (fake gh)", () => {
  let sandbox: string;
  let binDir: string;
  let prevGh: string | undefined;

  // Fake gh whose `pr view <selector> --json state` echoes the state passed in via ANTON_TEST_PR_STATE,
  // or exits non-zero (as the real gh does for an unknown PR) when it's set to "__error__".
  function installFakeGh(): void {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  const st=process.env.ANTON_TEST_PR_STATE;
  if(!st||st==='__error__'){process.stderr.write('no pull requests found\\n');process.exit(1);}
  process.stdout.write(JSON.stringify({state:st})+'\\n');process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-prstate-"));
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    installFakeGh();
    prevGh = process.env[GH_BIN_ENV];
    process.env[GH_BIN_ENV] = join(binDir, "gh");
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    delete process.env.ANTON_TEST_PR_STATE;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("maps gh states to open / merged / closed, strips the gh- ref prefix", async () => {
    process.env.ANTON_TEST_PR_STATE = "OPEN";
    expect(await pullRequestState(sandbox, "gh-42")).toBe("open");
    process.env.ANTON_TEST_PR_STATE = "MERGED";
    expect(await pullRequestState(sandbox, "gh-42")).toBe("merged");
    process.env.ANTON_TEST_PR_STATE = "CLOSED";
    expect(await pullRequestState(sandbox, "gh-42")).toBe("closed");
  });

  it("returns 'unknown' when gh errors, and for an empty/unparseable ref", async () => {
    process.env.ANTON_TEST_PR_STATE = "__error__";
    expect(await pullRequestState(sandbox, "gh-42")).toBe("unknown");
    // Empty ref (nothing to look up) short-circuits to unknown without invoking gh.
    expect(await pullRequestState(sandbox, "")).toBe("unknown");
    // An unexpected state string also degrades to unknown rather than a bogus value.
    process.env.ANTON_TEST_PR_STATE = "DRAFT_WEIRD";
    expect(await pullRequestState(sandbox, "gh-42")).toBe("unknown");
  });
});

suite("worktreeHasCommitFor (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-hascommit-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("detects a ticket's commit by its `<id>: …` subject, ignoring other commits", async () => {
    writeFileSync(join(repo, "work.md"), "work\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "anton-jz1.2: implement the thing"]);

    // The committed ticket is present; a sibling ticket that never committed here is absent — the
    // exact cross-machine-resume signal execute-epic skips/re-runs on.
    expect(await worktreeHasCommitFor(repo, "anton-jz1.2")).toBe(true);
    expect(await worktreeHasCommitFor(repo, "anton-jz1.3")).toBe(false);
    // A prefix collision must NOT false-positive: `anton-jz1.2` is not a commit for `anton-jz1`.
    expect(await worktreeHasCommitFor(repo, "anton-jz1")).toBe(false);
  });

  it("returns false in a repo with no matching commit (fresh cross-machine worktree)", async () => {
    expect(await worktreeHasCommitFor(repo, "anton-jz1.2")).toBe(false);
  });

  /**
   * What the resumed ticket's CONTINUATION block is written from (anton-16pq). Nothing preserved
   * means no block at all, so "absent" has to be the answer for a branch that carries only other
   * tickets' commits — a fresh ticket's prompt must not gain a paragraph.
   */
  describe("readPreservedCommitFor", () => {
    it("reads the preserved commit's sha, subject and files", async () => {
      writeFileSync(join(repo, "half-written.md"), "partial\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: Ship the thing\n\nINCOMPLETE — stopped at its budget"]);

      const preserved = await readPreservedCommitFor(repo, "anton-d9");

      expect(preserved?.subject).toBe("WIP anton-d9: Ship the thing");
      expect(preserved?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(preserved?.files).toEqual(["half-written.md"]);
    });

    // The marker form: the agent committed the work itself, so the preserved commit is EMPTY and
    // the prompt must not present its diff as what was kept. `newestEmpty` is what says so.
    it("reports no files and an empty newest commit for a marker commit", async () => {
      g(["commit", "-q", "--allow-empty", "-m", "WIP anton-d9: Ship the thing"]);

      const preserved = await readPreservedCommitFor(repo, "anton-d9");
      expect(preserved?.files).toEqual([]);
      expect(preserved?.newestEmpty).toBe(true);
    });

    // A net-zero range is NOT a marker: attempt one's added file is removed by attempt two, so the
    // aggregate `baseline..newest` diff is `[]` even though the newest commit itself is non-empty.
    // `newestEmpty: false` is what lets the prompt tell the two apart (PR #255 review).
    it("distinguishes a non-empty newest commit whose range nets to nothing from a marker", async () => {
      g(["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(repo, "toggle.md"), "added\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: first attempt (adds the file)"]);
      rmSync(join(repo, "toggle.md"));
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: second attempt (removes it)"]);

      const preserved = await readPreservedCommitFor(repo, "anton-d9", "main");
      // The added-then-removed file leaves no net change across the range…
      expect(preserved?.files).toEqual([]);
      // …but the newest commit is a real removal, not an empty marker.
      expect(preserved?.newestEmpty).toBe(false);
    });

    // A ticket can time out more than once; the freshest preserve is the tree the agent is looking
    // at, so the newest match is the tip — but every earlier attempt's delta is on the branch too and
    // must come along in `files`/`earlier`, or the resume is pointed at only the newest delta.
    it("collects every preserved attempt when a ticket timed out twice", async () => {
      writeFileSync(join(repo, "first.md"), "first\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: first attempt"]);
      writeFileSync(join(repo, "second.md"), "second\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: second attempt"]);

      const preserved = await readPreservedCommitFor(repo, "anton-d9");

      expect(preserved?.subject).toBe("WIP anton-d9: second attempt");
      expect(preserved?.files?.sort()).toEqual(["first.md", "second.md"]);
      expect(preserved?.earlier.map((c) => c.subject)).toEqual(["WIP anton-d9: first attempt"]);
    });

    // A first timeout can leave the agent's OWN commits with an EMPTY marker recording them, and a
    // second a non-empty WIP commit. The self-committed work lives BENEATH the marker, so a
    // per-marker union misses it — the fork point makes `files` the whole delta (PR #255 review).
    it("spans self-committed work beneath an empty marker when the fork point is known", async () => {
      g(["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(repo, "self.md"), "self\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "the agent's own subject"]);
      g(["commit", "-q", "--allow-empty", "-m", "WIP anton-d9: first attempt (marker)"]);
      writeFileSync(join(repo, "wip.md"), "wip\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: second attempt"]);

      const preserved = await readPreservedCommitFor(repo, "anton-d9", "main");

      expect(preserved?.baseline).toMatch(/^[0-9a-f]{40}$/);
      // The self-committed file AND the second attempt's — not just the WIP commits' own deltas.
      expect(preserved?.files?.sort()).toEqual(["self.md", "wip.md"]);
      expect(preserved?.earlier.map((c) => c.subject)).toEqual([
        "WIP anton-d9: first attempt (marker)",
      ]);
    });

    // `git()`'s `stdout.trim()` would strip a leading-space filename emitted at the start of the
    // diff; the untrimmed reads keep it, on both the fork-point and the fallback path (PR #255).
    it("preserves leading whitespace in a changed path", async () => {
      g(["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(repo, " lead.md"), "x\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "WIP anton-d9: whitespace path"]);

      expect((await readPreservedCommitFor(repo, "anton-d9", "main"))?.files).toEqual([" lead.md"]);
      expect((await readPreservedCommitFor(repo, "anton-d9"))?.files).toEqual([" lead.md"]);
    });

    it("is undefined for a ticket nothing was preserved for, and for the delivery subject", async () => {
      writeFileSync(join(repo, "work.md"), "work\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "anton-d9: Ship the thing"]);

      expect(await readPreservedCommitFor(repo, "anton-d9")).toBeUndefined();
      expect(await readPreservedCommitFor(repo, "anton-other")).toBeUndefined();
    });
  });

  // Adoption of self-committed work asks whether the TIP is the marker — a marker deeper in history
  // does not cover the self-commits above it, so history-wide presence is the wrong question (PR #255).
  describe("worktreeTipIsPreservedCommitFor", () => {
    it("is true only when the branch tip is this ticket's marker", async () => {
      g(["commit", "-q", "--allow-empty", "-m", "WIP anton-d9: Ship the thing"]);

      expect(await worktreeTipIsPreservedCommitFor(repo, "anton-d9")).toBe(true);
      // A prefix collision must not false-positive.
      expect(await worktreeTipIsPreservedCommitFor(repo, "anton-d")).toBe(false);
    });

    it("is false when the marker sits BELOW newer self-commits, though history still carries it", async () => {
      g(["commit", "-q", "--allow-empty", "-m", "WIP anton-d9: first attempt (marker)"]);
      writeFileSync(join(repo, "more.md"), "more\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "the agent's own subject"]);

      // History-wide would say yes; the tip check — the one adoption must use — says no, because the
      // marker no longer covers the self-commit above it.
      expect(await worktreeHasPreservedCommitFor(repo, "anton-d9")).toBe(true);
      expect(await worktreeTipIsPreservedCommitFor(repo, "anton-d9")).toBe(false);
    });
  });
});

/**
 * PR #227 review: the held-ticket park may only offer "abandon it, the commit stays in the pull
 * request" for a commit this machine actually has. anton's branch names are deterministic per
 * target, so the name a block note records is the same on every machine — only git can say whether
 * the commit behind it is here.
 */
suite("branchContainsCommit (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const head = () =>
    execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-branchhas-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("answers for a branch that is not checked out, by short sha", async () => {
    g(["checkout", "-q", "-b", "anton/anton-x7la"]);
    writeFileSync(join(repo, "work.md"), "work\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "anton-od4: implement the thing"]);
    const sha = head();
    // Back on main: the run's checkout need not exist for the repository to answer for its branch.
    g(["checkout", "-q", "main"]);

    expect(await branchContainsCommit(repo, "anton/anton-x7la", sha)).toBe(true);
    // The commit is on the run's branch only — main, the base a fresh worktree is cut from, lacks it.
    expect(await branchContainsCommit(repo, "main", sha)).toBe(false);
  });

  it("fails closed for a branch this machine never had, and for an unknown sha", async () => {
    // The cross-machine resume: same deterministic branch name, no such branch (and no such object)
    // in this clone.
    expect(await branchContainsCommit(repo, "anton/anton-x7la", "0123456")).toBe(false);
    expect(await branchContainsCommit(repo, "main", "0123456")).toBe(false);
  });
});

/**
 * anton-nuft: a `satisfied` self-report names a commit as the evidence its step is already done, and
 * the gate settles on the branch rather than the claim. The commit has to be one the run's branch
 * ADDED — a commit of the base is on the branch too, and naming it is a zero-diff false success
 * dressed as evidence.
 */
suite("branchAddedCommit (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const head = () =>
    execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const commitFile = (name: string, subject: string) => {
    writeFileSync(join(repo, name), `${name}\n`);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", subject]);
    return head();
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-branchadded-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    commitFile("README.md", "init");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("accepts a commit the run's branch added over its base, by short sha", async () => {
    g(["checkout", "-q", "-b", "anton/anton-e0y2"]);
    const earlier = commitFile("shared.ts", "anton-6l0q: the change that covers both steps");
    g(["checkout", "-q", "main"]);

    expect(await branchAddedCommit(repo, "anton/anton-e0y2", "main", earlier)).toBe(true);
  });

  it("refuses a commit of the base, even though the branch contains it", async () => {
    const fork = head();
    g(["checkout", "-q", "-b", "anton/anton-e0y2"]);
    commitFile("work.ts", "anton-6l0q: implement the thing");
    // Merged-in base work is on the branch too, and just as little this run's own.
    g(["checkout", "-q", "main"]);
    const landed = commitFile("main.ts", "someone else: landed on main");
    g(["checkout", "-q", "anton/anton-e0y2"]);
    g(["merge", "-q", "--no-edit", "main"]);

    expect(await branchContainsCommit(repo, "anton/anton-e0y2", fork)).toBe(true);
    expect(await branchAddedCommit(repo, "anton/anton-e0y2", "main", fork)).toBe(false);
    expect(await branchAddedCommit(repo, "anton/anton-e0y2", "main", landed)).toBe(false);
  });

  it("fails closed for an unknown sha, a missing branch, and an unreadable base", async () => {
    g(["checkout", "-q", "-b", "anton/anton-e0y2"]);
    const own = commitFile("work.ts", "anton-6l0q: implement the thing");

    expect(await branchAddedCommit(repo, "anton/anton-e0y2", "main", "0123456")).toBe(false);
    expect(await branchAddedCommit(repo, "anton/anton-x7la", "main", own)).toBe(false);
    expect(await branchAddedCommit(repo, "anton/anton-e0y2", "origin/main", own)).toBe(false);
  });
});

/**
 * anton-8h4b: a satisfied step is recorded against the FULL sha and subject of the commit it named,
 * so the record outlives the abbreviation the agent read off `git log`.
 */
suite("describeCommit (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const rev = (ref: string) =>
    execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-describe-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "init\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "anton-t1: Ticket one\n\nA body the subject must not carry."]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("resolves an abbreviated sha to its full form and subject line", async () => {
    const full = rev("HEAD");
    expect(await describeCommit(repo, full.slice(0, 7))).toEqual({
      sha: full,
      subject: "anton-t1: Ticket one",
    });
  });

  it("answers undefined for a sha the repository does not have", async () => {
    expect(await describeCommit(repo, "0123456")).toBeUndefined();
    expect(await describeCommit(join(sandbox, "nowhere"), rev("HEAD"))).toBeUndefined();
  });
});

suite("readPathHistory (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const commit = (msg: string) => {
    g(["add", "-A"]);
    g(["commit", "-q", "-m", msg]);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-pathhist-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    commit("init");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("resolves a single rename to its destination", async () => {
    writeFileSync(join(repo, "old.ts"), "export const x = 1;\n".repeat(20));
    commit("add old.ts");
    g(["mv", "old.ts", "new.ts"]);
    commit("rename old.ts -> new.ts");

    expect(await readPathHistory(repo, "old.ts")).toEqual({
      renamedTo: ["new.ts"],
      renames: 1,
      deleted: false,
    });
  });

  it("reports a removal with no rename paired to it as deleted", async () => {
    writeFileSync(join(repo, "gone.ts"), "export const gone = true;\n");
    commit("add gone.ts");
    g(["rm", "-q", "gone.ts"]);
    commit("remove gone.ts");

    expect(await readPathHistory(repo, "gone.ts")).toEqual({
      renamedTo: [],
      renames: 0,
      deleted: true,
    });
  });

  // `--follow` walks backwards from the file living at the path NOW, switching to the old name at
  // every rename — so a file renamed INTO the path hides the deletion of what used to be there
  // (PR #223 review). Reading the pathname's own history is the only way to see it.
  it("sees a removal an incoming rename hides, only with the follow off", async () => {
    writeFileSync(join(repo, "cited.ts"), "export const cited = 1;\n".repeat(20));
    writeFileSync(join(repo, "other.ts"), "export const other = 2;\n".repeat(20));
    commit("add cited.ts and other.ts");
    g(["rm", "-q", "cited.ts"]);
    commit("delete cited.ts");
    g(["mv", "other.ts", "cited.ts"]);
    commit("rename other.ts -> cited.ts");

    expect(await readPathHistory(repo, "cited.ts")).toEqual({
      renamedTo: [],
      renames: 0,
      deleted: false,
    });
    expect(await readPathHistory(repo, "cited.ts", { follow: false })).toEqual({
      renamedTo: [],
      renames: 0,
      deleted: true,
    });
  });

  it("counts a path renamed to the same destination twice as two renames", async () => {
    // The destination is deleted and the source recreated in between, so both removals read
    // `R old.ts new.ts` — one destination, two unrelated incarnations of the same name.
    writeFileSync(join(repo, "old.ts"), "export const x = 1;\n".repeat(20));
    commit("add old.ts");
    g(["mv", "old.ts", "new.ts"]);
    commit("rename old.ts -> new.ts (first)");
    g(["rm", "-q", "new.ts"]);
    writeFileSync(join(repo, "old.ts"), "export const y = 2;\n".repeat(20));
    commit("drop new.ts, recreate old.ts");
    g(["mv", "old.ts", "new.ts"]);
    commit("rename old.ts -> new.ts (second)");

    expect(await readPathHistory(repo, "old.ts")).toMatchObject({
      renamedTo: ["new.ts"],
      renames: 2,
    });
  });
});

suite("resolveFreshBase (real git)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;

  const g = (cwd: string, args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-freshbase-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    mkdirSync(repo);

    // `-b main` on the bare remote so its HEAD points at refs/heads/main. Without it, hosts
    // whose default branch is `master` leave clones of this remote (see the "other" clone below)
    // with no `main` checked out, so later commits land on an unborn `master` and
    // `git push origin main` fails with "src refspec main does not match any".
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(repo, ["config", "user.email", "t@example.com"]);
    g(repo, ["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "-q", "-m", "init"]);
    g(repo, ["remote", "add", "origin", bare]);
    g(repo, ["push", "-q", "-u", "origin", "main"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fetches and returns origin/<base> when origin is ahead", async () => {
    // Advance origin/main via a second clone so the local repo's remote-tracking ref is stale.
    const other = join(sandbox, "other");
    execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" });
    g(other, ["config", "user.email", "t@example.com"]);
    g(other, ["config", "user.name", "anton-test"]);
    writeFileSync(join(other, "next.md"), "next\n");
    g(other, ["add", "-A"]);
    g(other, ["commit", "-q", "-m", "ahead"]);
    g(other, ["push", "-q", "origin", "main"]);

    const aheadTip = execFileSync("git", ["-C", bare, "rev-parse", "main"]).toString().trim();

    const ref = await resolveFreshBase(repo, "main");
    expect(ref).toBe("origin/main");
    // The fetch updated the remote-tracking ref to origin's new tip.
    const tracked = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"]).toString().trim();
    expect(tracked).toBe(aheadTip);
  });

  it("logs a warning and falls back to local <base> when the fetch fails", async () => {
    // Break the remote URL so `git fetch origin` fails, but hasRemote() still reports a remote.
    g(repo, ["remote", "set-url", "origin", join(sandbox, "does-not-exist.git")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ref = await resolveFreshBase(repo, "main");

    expect(ref).toBe("main");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("origin/main");
  });

  it("returns local <base> without fetching when there is no origin remote", async () => {
    g(repo, ["remote", "remove", "origin"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ref = await resolveFreshBase(repo, "main");

    expect(ref).toBe("main");
    // No remote → no fetch attempt → no warning.
    expect(warn).not.toHaveBeenCalled();
  });
});

suite("distanceBehindUpstream concurrency (real git)", () => {
  let sandbox: string;
  let repo: string;
  let bare: string;

  const g = (cwd: string, args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-distbehind-"));
    repo = join(sandbox, "repo");
    bare = join(sandbox, "remote.git");
    mkdirSync(repo);
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(repo, ["config", "user.email", "t@example.com"]);
    g(repo, ["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "-q", "-m", "init"]);
    g(repo, ["remote", "add", "origin", bare]);
    // `-u` sets branch.main.remote/.merge so distanceBehindUpstream has an upstream to read.
    g(repo, ["push", "-q", "-u", "origin", "main"]);

    // Advance origin by one commit so the local tracking ref is a step behind.
    const other = join(sandbox, "other");
    execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" });
    g(other, ["config", "user.email", "t@example.com"]);
    g(other, ["config", "user.name", "anton-test"]);
    writeFileSync(join(other, "next.md"), "next\n");
    g(other, ["add", "-A"]);
    g(other, ["commit", "-q", "-m", "ahead"]);
    g(other, ["push", "-q", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // The breaker poll and the execute-epic preflight fetch the SAME upstream tracking ref from one
  // process; unserialized, the loser of git's per-ref lock returns `unreachable`, which the stale
  // gate treats as indeterminate and lets a behind checkout start. Serialized, every concurrent read
  // returns the one true verdict.
  it("returns a single deterministic verdict under many concurrent reads (no ref-lock race)", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => distanceBehindUpstream(repo)),
    );
    for (const r of results) {
      expect(r).toEqual({ state: "behind", behind: 1, upstream: "origin/main" });
    }
  });
});

suite("diffAgainstBase (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-diffbase-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", "anton/epic-1"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns the branch's changed files and patch against the base", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add a and b"]);

    const diff = await diffAgainstBase(repo, "main");

    expect(diff.files).toEqual(["a.ts", "b.ts"]);
    expect(diff.patch).toContain("+export const a = 1;");
    expect(diff.patch).toContain("+export const b = 2;");
    expect(diff.truncated).toBe(false);
  });

  it("diffs from the merge base, so later base commits are not attributed to the run", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add a"]);

    // The base moves on after the run branched (another PR merged) — not this run's work.
    g(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "other.ts"), "export const other = 0;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "someone else"]);
    g(["checkout", "-q", "anton/epic-1"]);

    const diff = await diffAgainstBase(repo, "main");

    expect(diff.files).toEqual(["a.ts"]);
    expect(diff.patch).not.toContain("other.ts");
  });

  it("lists BOTH sides of a rename, so the scope the code left is still covered", async () => {
    // A detected rename names only its destination, and the file list is what scopes the instruction
    // files the reviewer is judged against — the rules of the directory the code MOVED OUT of would
    // go unread while the reviewer is told the inlined ones are the only rules binding the diff.
    g(["config", "diff.renames", "true"]); // git's default; pinned so the guard is what's tested
    g(["checkout", "-q", "main"]);
    mkdirSync(join(repo, "old"), { recursive: true });
    writeFileSync(join(repo, "old", "file.ts"), "export const moved = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed the old scope"]);
    g(["checkout", "-q", "-B", "anton/epic-1"]);

    mkdirSync(join(repo, "new"), { recursive: true });
    g(["mv", "old/file.ts", "new/file.ts"]);
    g(["commit", "-q", "-am", "t1: move the file"]);

    const diff = await diffAgainstBase(repo, "main");

    expect(diff.files).toEqual(["new/file.ts", "old/file.ts"]);
    // The patch keeps rename detection — it is the file list alone that must be complete.
    expect(diff.patch).toContain("rename from old/file.ts");
  });

  it("names paths git would QUOTE exactly, so the reviewer's rule scope resolves", async () => {
    // Under the default `core.quotePath`, a non-ASCII path prints as `"src/caf\303\251/page.tsx"`.
    // The file list is what scopes the instruction files the reviewer is judged against, and a
    // C-quoted string walks the wrong ancestors — dropping a nested AGENTS.md that binds the diff.
    // A `[id]` segment is the App Router's own shape, and a pathspec reads it as a glob.
    g(["config", "core.quotePath", "true"]); // git's default; pinned so the guard is what's tested
    g(["checkout", "-q", "main"]);
    mkdirSync(join(repo, "src", "café", "[id]"), { recursive: true });
    writeFileSync(join(repo, "src", "café", "[id]", "page.tsx"), "export default () => null;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed the quoted path"]);
    g(["checkout", "-q", "-B", "anton/epic-1"]);

    // `AAA-big.ts` sorts first, so the cut pushes the removal into the deletion pass.
    writeFileSync(join(repo, "AAA-big.ts"), "// filler line\n".repeat(500));
    rmSync(join(repo, "src", "café", "[id]", "page.tsx"));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: grow and remove the quoted path"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200 });

    expect(diff.files).toEqual(["AAA-big.ts", "src/café/[id]/page.tsx"]);
    expect(diff.deletions).toContain("-export default () => null;");
  });

  it("reports no changes for a branch that committed nothing", async () => {
    const diff = await diffAgainstBase(repo, "main");
    expect(diff).toEqual({ files: [], patch: "", truncated: false });
  });

  it("truncates the patch at maxPatchChars but keeps the full file list", async () => {
    writeFileSync(join(repo, "big.ts"), "// filler line\n".repeat(500));
    writeFileSync(join(repo, "small.ts"), "export const s = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: big change"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200 });

    expect(diff.truncated).toBe(true);
    expect(diff.files).toEqual(["big.ts", "small.ts"]);
    expect(diff.patch).toContain("patch truncated at 200 chars");
    // The cap bounds the patch text itself; only the truncation note follows it.
    expect(diff.patch.length).toBeLessThan(300);
  });

  it("repeats the deletions in their own patch when the cut hides them", async () => {
    // Everything a truncated patch omits can be read in the worktree — except a file the run
    // DELETED, which is gone from it, and the reviewer has no `git` to fetch it from the base.
    // `AAA-big.ts` sorts first, so the deletion of README.md falls past the cut.
    writeFileSync(join(repo, "AAA-big.ts"), "// filler line\n".repeat(500));
    rmSync(join(repo, "README.md"));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: grow and remove"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200 });

    expect(diff.truncated).toBe(true);
    expect(diff.patch).not.toContain("README.md");
    expect(diff.deletions).toContain("README.md");
    expect(diff.deletions).toContain("-# sandbox");
    // Deletions only — the surviving files are in the (truncated) patch and in the worktree.
    expect(diff.deletions).not.toContain("AAA-big.ts");
  });

  it("rescues the SOURCE of a detected rename, whose old side is no `D` entry", async () => {
    // With rename detection on, a move is one `R*` entry naming only its destination — so the
    // deletion pass would find nothing for it, while the reviewer (denied `git`) can open only the
    // destination. Behaviour the move dropped on the way would then be reviewed by nobody.
    g(["config", "diff.renames", "true"]); // git's default; pinned so the guard is what's tested
    g(["checkout", "-q", "main"]);
    mkdirSync(join(repo, "old"), { recursive: true });
    const kept = Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFileSync(join(repo, "old", "guard.ts"), `${kept}\nexport const requireAuth = () => true;\n`);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed the guard"]);
    g(["checkout", "-q", "-B", "anton/epic-1"]);

    // Similar enough for git to score a rename, minus the guard — and `AAA-big.ts` sorts first, so
    // the move itself falls past the cut.
    mkdirSync(join(repo, "new"), { recursive: true });
    writeFileSync(join(repo, "new", "guard.ts"), `${kept}\n`);
    rmSync(join(repo, "old", "guard.ts"), { recursive: true });
    writeFileSync(join(repo, "AAA-big.ts"), "// filler line\n".repeat(500));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: move the guard and drop it"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200 });

    expect(diff.truncated).toBe(true);
    expect(diff.deletions).toContain("old/guard.ts");
    expect(diff.deletions).toContain("-export const requireAuth = () => true;");
  });

  it("bounds the deletions patch of its own, and omits it when the run deleted nothing", async () => {
    writeFileSync(join(repo, "AAA-big.ts"), "// filler line\n".repeat(500));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: grow"]);
    expect((await diffAgainstBase(repo, "main", { maxPatchChars: 200 })).deletions).toBeUndefined();

    rmSync(join(repo, "README.md"));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: remove readme"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200, maxDeletionChars: 60 });

    expect(diff.deletions).toContain("deletion of README.md truncated at 60 chars");
    expect(diff.deletions!.length).toBeLessThan(160);
  });

  it("spends the deletion budget per file, so one big removal cannot hide the rest", async () => {
    // A single globally bounded stream is exhausted by whichever deletion git emits first — every
    // route or guard removed after it would then reach the reviewer as a filename, and neither the
    // worktree nor (without `git`) the base can show it.
    writeFileSync(join(repo, "AAA-huge.ts"), "// filler line\n".repeat(2_000));
    writeFileSync(join(repo, "zzz-guard.ts"), "export const requireAuth = () => true;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed"]);
    g(["checkout", "-q", "main"]);
    g(["merge", "-q", "--ff-only", "anton/epic-1"]);
    g(["checkout", "-q", "anton/epic-1"]);

    writeFileSync(join(repo, "big.ts"), "// filler line\n".repeat(500));
    rmSync(join(repo, "AAA-huge.ts"));
    rmSync(join(repo, "zzz-guard.ts"));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: drop both"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200, maxDeletionChars: 4_000 });

    expect(diff.deletions).toContain("deletion of AAA-huge.ts truncated at 2000 chars");
    // The guard sorts last and is far smaller than the budget's first slice — a global stream would
    // have spent it all on AAA-huge.ts before reaching it.
    expect(diff.deletions).toContain("-export const requireAuth = () => true;");
  });

  it("quotes every deletion the budget can pay a floor slice for, not just the first", async () => {
    // The even share falls under the per-file floor as soon as the run deletes enough files (81 of
    // them on the default budget). Treating the floor as a cutoff quoted ONE file and named the
    // rest — every guard removed after it unreviewable, since a deleted file is in neither the
    // worktree nor (without `git`) the base.
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(repo, `f${i}.ts`), `export const guard${i} = () => true;\n`);
    }
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed"]);
    g(["checkout", "-q", "main"]);
    g(["merge", "-q", "--ff-only", "anton/epic-1"]);
    g(["checkout", "-q", "anton/epic-1"]);

    for (let i = 0; i < 12; i++) rmSync(join(repo, `f${i}.ts`));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: drop them all"]);

    // 4_000 / 12 = 333, under the floor — but each removal is far smaller than the floor, so the
    // budget stretches to all twelve.
    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200, maxDeletionChars: 4_000 });

    for (let i = 0; i < 12; i++) expect(diff.deletions).toContain(`-export const guard${i} = () => true;`);
    expect(diff.deletions).not.toContain("further deleted file(s) not shown");
    expect(diff.deletionsUnshown).toBeUndefined();
  });

  it("names the deleted files it had no budget left to quote", async () => {
    // Honest under-coverage: below one usable slice per file the reviewer is told which removals it
    // is NOT seeing, rather than reading a partial list as the whole set.
    for (let i = 0; i < 12; i++) writeFileSync(join(repo, `f${i}.ts`), "// filler line\n".repeat(200));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed"]);
    g(["checkout", "-q", "main"]);
    g(["merge", "-q", "--ff-only", "anton/epic-1"]);
    g(["checkout", "-q", "anton/epic-1"]);

    for (let i = 0; i < 12; i++) rmSync(join(repo, `f${i}.ts`));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: drop them all"]);

    const diff = await diffAgainstBase(repo, "main", { maxPatchChars: 200, maxDeletionChars: 2_000 });

    expect(diff.deletions).toContain("further deleted file(s) not shown");
    expect(diff.deletions).toContain("f11.ts");
    // Counted out too, not just named in the patch text: the review prompt has to turn the gap into
    // unverified-scope guidance, and it cannot parse that out of the patch.
    expect(diff.deletionsUnshown).toBeGreaterThan(0);
    // The bound still holds: the quoted slices stay within the budget.
    expect(diff.deletions!.length).toBeLessThan(2_000 + 500);
  });

  it("leaves the deletions out entirely when the patch fits", async () => {
    rmSync(join(repo, "README.md"));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: remove readme"]);

    const diff = await diffAgainstBase(repo, "main");

    expect(diff.truncated).toBe(false);
    expect(diff.deletions).toBeUndefined();
    expect(diff.patch).toContain("-# sandbox"); // the whole patch already carries it
  });

  it("truncates a patch far larger than any exec buffer instead of failing the review", async () => {
    // A generated lockfile or a vendored source update produces a patch of tens of megabytes.
    // Collecting it into an exec buffer first throws before any truncation can run — the whole
    // review then fails on exactly the change truncation exists for. 20 MiB clears the 16 MiB the
    // module's buffered `git` helper allows.
    writeFileSync(join(repo, "vendored.txt"), "x".repeat(20 * 1024 * 1024));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: vendor a blob"]);

    const diff = await diffAgainstBase(repo, "main");

    expect(diff.truncated).toBe(true);
    expect(diff.files).toEqual(["vendored.txt"]);
    expect(diff.patch).toContain("patch truncated at 200000 chars");
    expect(diff.patch.length).toBeLessThan(DEFAULT_DIFF_PATCH_CHARS + 200);
  });
});

// anton-hx4b: the deletion rescue pass is reached through `diffAgainstBase` only by forcing the
// main patch to truncate, which costs a filler commit per case and blurs WHICH allocation rule a
// failure belongs to. Driven directly, each branch of the budget split gets a case of its own.
suite("deletionPatch (real git · one case per budget branch)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  /** Delete `paths` on the branch, after seeding them into the base so their removal is a `D`. */
  const seedAndDelete = (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "seed"]);
    g(["checkout", "-q", "main"]);
    g(["merge", "-q", "--ff-only", "anton/epic-1"]);
    g(["checkout", "-q", "anton/epic-1"]);
    for (const path of Object.keys(files)) rmSync(join(repo, path));
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: drop them"]);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-delpatch-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", "anton/epic-1"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns nothing at all when the branch deleted no file", async () => {
    writeFileSync(join(repo, "added.ts"), "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add only"]);

    expect(await deletionPatch(repo, "main", 4_000)).toEqual({});
  });

  it("quotes a removal whole when its even share of the budget covers it", async () => {
    seedAndDelete({ "guard.ts": "export const requireAuth = () => true;\n" });

    const { patch, incomplete, unshown } = await deletionPatch(repo, "main", 4_000);

    expect(patch).toContain("-export const requireAuth = () => true;");
    // Quoted whole, so there is no truncation note and no under-coverage to report.
    expect(patch).not.toContain("truncated at");
    expect(incomplete).toBeUndefined();
    expect(unshown).toBeUndefined();
  });

  it("spends the FLOOR slice when the even share falls under it, so the tail is still quoted", async () => {
    // 12 removals of a 4_000 budget put the even share at 333 — under the floor. Treating the floor
    // as a cutoff instead of a spend quoted the first file and NAMED the other eleven, though every
    // one of them is small enough for the budget to pay a usable slice for.
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.ts`] = `export const guard${i} = () => true;\n`;
    seedAndDelete(files);

    const { patch, unshown } = await deletionPatch(repo, "main", 4_000);

    for (let i = 0; i < 12; i++) expect(patch).toContain(`-export const guard${i} = () => true;`);
    expect(unshown).toBeUndefined();
  });

  it("cuts a removal larger than its slice and says so, per file", async () => {
    seedAndDelete({ "big.ts": "// filler line\n".repeat(2_000) });

    const { patch } = await deletionPatch(repo, "main", 300);

    expect(patch).toContain("deletion of big.ts truncated at 300 chars");
    // The cut is where the memory is spent: only the note follows the bounded text.
    expect(patch!.length).toBeLessThan(300 + 100);
  });

  it("names — and counts — the removals left once the budget cannot buy a floor slice", async () => {
    // Honest under-coverage: past `max / MIN_DELETION_SLICE_CHARS` files no cut of the share fixes
    // it, so the reviewer is told which removals it is NOT seeing rather than reading a partial
    // list as the whole set.
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.ts`] = "// filler line\n".repeat(200);
    seedAndDelete(files);

    const { patch, unshown } = await deletionPatch(repo, "main", 2_000);

    expect(patch).toContain("further deleted file(s) not shown");
    expect(patch).toContain("f11.ts");
    expect(unshown).toBeGreaterThan(0);
    expect(patch!.length).toBeLessThan(2_000 + 500);
  });

  it("holds the bound when the budget cannot pay for even the first removal", async () => {
    // A zero budget is still a bound, not an error: the first file is always ASKED for (a caller
    // wanting the deletions bounded is not asking for them withheld), and what comes back is empty
    // rather than a diff header masquerading as content.
    seedAndDelete({ "guard.ts": "export const requireAuth = () => true;\n" });

    const { patch, unshown, incomplete } = await deletionPatch(repo, "main", 0);

    expect(patch).toBeUndefined();
    expect(unshown).toBeUndefined();
    expect(incomplete).toBeUndefined();
  });

  it("reports a failed pass as incomplete instead of as an empty deletion list", async () => {
    // The reviewer has no route to a deleted file, so a swallowed failure reads as "nothing was
    // removed" and every removal is approved by a verdict nobody formed over it.
    seedAndDelete({ "guard.ts": "export const requireAuth = () => true;\n" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { patch, incomplete } = await deletionPatch(repo, "no-such-rev", 4_000);

    expect(incomplete).toBe(true);
    expect(patch).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

suite("resolveMergeBase (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const out = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-mergebase-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", "anton/epic-1"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("pins the fork point as a SHA, unmoved by commits landing on the base after it", async () => {
    const fork = out(["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add a"]);

    g(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "other.ts"), "export const other = 0;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "someone else"]);
    g(["checkout", "-q", "anton/epic-1"]);

    // The branch tip moved; the commit the run branched from did not.
    expect(await resolveMergeBase(repo, "main")).toBe(fork);
    expect(out(["rev-parse", "main"])).not.toBe(fork);
  });

  it("falls back to the base itself when it does not resolve", async () => {
    expect(await resolveMergeBase(repo, "origin/nope")).toBe("origin/nope");
  });

  it("pins a base with NO merge base to its commit, never to the movable ref name", async () => {
    // A resumed worktree whose base was force-rewritten to an unrelated history: `merge-base` exits
    // 1. Handing back "main" would leave every later read resolving that ref again, so a sibling
    // fetch between two of them splits the baseline the pinning exists to hold together.
    g(["checkout", "-q", "--orphan", "rewritten"]);
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "unrelated history"]);

    const pinned = await resolveMergeBase(repo, "main");

    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    expect(pinned).toBe(out(["rev-parse", "main"]));
  });

  it("throws when the fork point cannot be READ, rather than pinning the base tip", async () => {
    // merge-base failing operationally (here an unreadable HEAD commit — exit 128, not the exit 1
    // that means "no common ancestor") must not degrade to the base's tip: that is a commit this
    // branch never forked from, and the gate would review the wrong diff instead of parking.
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add a"]);
    const head = out(["rev-parse", "HEAD"]);
    rmSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)));

    await expect(resolveMergeBase(repo, "main")).rejects.toThrow();
  });
});

suite("listDirBlobsAtRev (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const write = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-lsblobs-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    write("CLAUDE.md", "root rules\n");
    write("src/app/AGENTS.md", "app rules\n");
    write("src/app/page.tsx", "export default () => null;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("lists the files directly inside each directory, and ignores ones that don't exist", async () => {
    const paths = await listDirBlobsAtRev(repo, "main", ["", "src", "src/app", "packages/nope"]);

    expect([...paths].sort()).toEqual(["CLAUDE.md", "src/app/AGENTS.md", "src/app/page.tsx"]);
    // `src` holds only the `app` TREE — a directory is not a readable file.
    expect(paths).not.toContain("src/app");
  });

  it("covers far more directories than one command line could carry", async () => {
    // A monorepo-wide diff crosses hundreds of scopes; batching keeps every one of them probed.
    const dirs = Array.from({ length: 1200 }, (_, i) => `pkg/p${i}`);
    write("pkg/p1199/CLAUDE.md", "the deepest scope's rules\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "deep rules"]);

    const paths = await listDirBlobsAtRev(repo, "main", ["", ...dirs]);

    expect(paths).toContain("pkg/p1199/CLAUDE.md");
    expect(paths).toContain("CLAUDE.md");
  });

  it("throws on a rev that does not resolve, rather than reporting an empty tree", async () => {
    // An empty list is the review gate's "no scope here holds an instruction file". A read that
    // FAILED has established no such thing, and passing it off as one drops the whole rulebook.
    await expect(listDirBlobsAtRev(repo, "origin/nope", [""])).rejects.toThrow();
  });

  it("reads a directory whose NAME starts with pathspec magic as a literal path", async () => {
    // The operands are built from the diff's own directory names. A real directory called
    // `:(exclude)` parses as an exclusion pathspec instead — git exits with "outside repository",
    // which fails the read the gate depends on and parks every run that touches that subtree.
    write(":(exclude)/CLAUDE.md", "magic-named scope rules\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "magic-named dir"]);

    const paths = await listDirBlobsAtRev(repo, "main", ["", ":(exclude)"]);

    expect(paths).toContain(":(exclude)/CLAUDE.md");
    expect(paths).toContain("CLAUDE.md");
    // readFileAtRev builds the same kind of operand from an exact rule-file path.
    expect(await readFileAtRev(repo, "main", ":(exclude)/CLAUDE.md")).toBe("magic-named scope rules");
  });
});

suite("readFileAtRev (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const write = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const link = (rel: string, target: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    symlinkSync(target, join(repo, rel));
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-readrev-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    write("docs/rules.md", "the real rules\n");
    write("AGENTS.md", "root rules\n");
    // The shapes a project actually uses: a root file linked to its real home, and a nested one
    // pointing back up out of its own directory.
    link("CLAUDE.md", "docs/rules.md");
    link("src/app/AGENTS.md", "../../docs/rules.md");
    link("outside.md", "../escaped.md");
    link("absolute.md", "/etc/hostname");
    link("loop-a.md", "loop-b.md");
    link("loop-b.md", "loop-a.md");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("reads a regular file's committed contents", async () => {
    expect(await readFileAtRev(repo, "main", "AGENTS.md")).toBe("root rules");
  });

  it("follows a symlinked rules file to its contents, never returning the target pathname", async () => {
    // `git show` serves a symlink's blob, which IS the target path — inlined as the rulebook that
    // one line would have replaced the project's actual rules with.
    expect(await readFileAtRev(repo, "main", "CLAUDE.md")).toBe("the real rules");
    expect(await readFileAtRev(repo, "main", "CLAUDE.md")).not.toBe("docs/rules.md");
  });

  it("resolves a relative target against the link's own directory", async () => {
    expect(await readFileAtRev(repo, "main", "src/app/AGENTS.md")).toBe("the real rules");
  });

  it("returns undefined for a link that leaves the repository", async () => {
    // Nothing at `rev` backs an out-of-tree target, so there is no trustworthy answer — and reading
    // the machine's filesystem would judge the run against whatever host it happens to run on.
    expect(await readFileAtRev(repo, "main", "outside.md")).toBeUndefined();
    expect(await readFileAtRev(repo, "main", "absolute.md")).toBeUndefined();
  });

  it("gives up on a symlink cycle instead of looping", async () => {
    expect(await readFileAtRev(repo, "main", "loop-a.md")).toBeUndefined();
  });

  it("returns undefined for a missing path and for a directory", async () => {
    expect(await readFileAtRev(repo, "main", "nope.md")).toBeUndefined();
    expect(await readFileAtRev(repo, "main", "docs")).toBeUndefined();
  });

  it("throws on a rev that does not resolve, instead of reporting the file absent", async () => {
    // Undefined is the reviewer's "this project states no rules", so it may only ever mean git looked
    // and found nothing. A base commit it cannot resolve is a failed read — park the run.
    await expect(readFileAtRev(repo, "origin/nope", "AGENTS.md")).rejects.toThrow();
  });

  it("throws when a file the tree lists cannot be READ", async () => {
    // The failure a swallowed error hides: `ls-tree` reads the tree and never touches the blob, so a
    // corrupt/missing object is reported only by `git show`. Returning undefined there would inline
    // an empty rulebook and grade the run against rules nobody read.
    const blob = execFileSync("git", ["-C", repo, "rev-parse", "main:AGENTS.md"], {
      encoding: "utf8",
    }).trim();
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)), { force: true });

    await expect(readFileAtRev(repo, "main", "AGENTS.md")).rejects.toThrow();
  });
});

suite("readWorktreeState / restoreWorktreeState (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const out = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-wtstate-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["checkout", "-q", "-b", "anton/epic-1"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "t1: add a"]);
  });

  // Retried, like the bd suites' teardown: `readWorktreeState` reads with `Promise.all`, so a
  // rejection returns while the sibling `git status` is still refreshing the index — a bare rmSync
  // then walks the dir underneath it and dies ENOTEMPTY with every assertion already green.
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it("fingerprints the checked-out branch alongside HEAD and the dirt", async () => {
    const state = await readWorktreeState(repo);

    expect(state.ref).toBe("refs/heads/anton/epic-1");
    expect(state.head).toBe(out(["rev-parse", "HEAD"]));
    expect(state.status).toBe("");
  });

  it("sees a branch switch at the SAME commit as a change", async () => {
    const before = await readWorktreeState(repo);
    g(["checkout", "-q", "-b", "review-work"]);
    const after = await readWorktreeState(repo);

    // The commit-only fingerprint this replaces read these two as identical.
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
    expect(sameWorktreeState(after, before)).toBe(false);
  });

  it("restores the branch a stray checkout left, not just the commit", async () => {
    const before = await readWorktreeState(repo);
    g(["checkout", "-q", "-b", "review-work"]);
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "reviewer's own fix"]);

    await restoreWorktreeState(repo, before);

    // Back on the branch openPullRequest pushes, at the reviewed commit, with the write gone.
    expect(await readWorktreeState(repo)).toEqual(before);
    expect(existsSync(join(repo, "b.ts"))).toBe(false);
  });

  it("restores a detached baseline without re-attaching to a branch", async () => {
    g(["checkout", "-q", "--detach"]);
    const before = await readWorktreeState(repo);
    expect(before.ref).toBeUndefined();

    g(["checkout", "-q", "-b", "review-work"]);
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "reviewer's own fix"]);

    await restoreWorktreeState(repo, before);

    expect(await readWorktreeState(repo)).toEqual(before);
  });

  it("still drops uncommitted dirt on the branch it was already on", async () => {
    const before = await readWorktreeState(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 999;\n");
    writeFileSync(join(repo, "untracked.ts"), "stray\n");
    expect((await readWorktreeState(repo)).status).not.toBe("");

    await restoreWorktreeState(repo, before);

    expect(await readWorktreeState(repo)).toEqual(before);
    expect(existsSync(join(repo, "untracked.ts"))).toBe(false);
  });

  it("propagates an OPERATIONAL symbolic-ref failure instead of recording a detached baseline", async () => {
    // A swallowed failure here reads as "detached": the post-review read then succeeds, the
    // fingerprint differs on `ref` alone, and the gate reverts — detaching a worktree nobody wrote
    // to. Shim git so `symbolic-ref` exits 128 (git's unusable-repository status) while every other
    // subcommand answers normally, which is exactly the case the old catch-all could not tell from
    // exit 1.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "git"),
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const a=process.argv.slice(2);
if(a.includes('symbolic-ref')){process.stderr.write('fatal: not a git repository\\n');process.exit(128);}
const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});
process.exit(r.status ?? 1);
`,
    );
    chmodSync(join(binDir, "git"), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath}`;
    try {
      // Named explicitly, so the shim delegating the other subcommands is part of what is proven:
      // a rejection from `rev-parse` would mean the test never exercised the classification.
      await expect(readWorktreeState(repo)).rejects.toThrow(/symbolic-ref/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

// PR #228 review: `git commit` runs PROJECT code — the pre-commit and commit-msg hooks — and a kill
// aimed at the direct `git` process leaves those hooks orphaned and still writing. The caller is the
// ticket-timeout preserve, which reads the failure as a verdict and hard-resets the worktree at
// once, so a write still in flight lands after the cleanliness check and rides into the next
// ticket's commit. Nothing may be reported until the whole group is gone.
suite("commitAll (real git · a hook that outlives the kill)", () => {
  let sandbox: string;
  let repo: string;
  let started: string;
  let marker: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-commit-hook-"));
    repo = join(sandbox, "repo");
    started = join(sandbox, "hook-started");
    marker = join(sandbox, "late-hook-write");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);

    // A hook that survives the kill exactly as the review describes: it hands back the stdio it
    // inherited — so nothing about it holds the commit's pipes open — and keeps writing afterwards.
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        `trap 'exec >/dev/null 2>&1; sleep 1; : > ${JSON.stringify(marker)}; exit 1' TERM`,
        `: > ${JSON.stringify(started)}`,
        "sleep 30 &",
        "wait",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, "work.ts"), "export const work = 1;\n");
  });

  afterEach(() => {
    delete process.env[COMMIT_TIMEOUT_ENV];
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it.runIf(process.platform !== "win32")(
    "reports the failed commit only once its hooks have gone",
    async () => {
      // Comfortably longer than git takes to reach its hook, so the kill lands on a hook that is
      // actually running — the state the reap exists for.
      process.env[COMMIT_TIMEOUT_ENV] = "2000";

      await expect(commitAll(repo, "t1: work the hook is sitting on")).rejects.toThrow(
        /timed out/,
      );

      expect(existsSync(started)).toBe(true);
      // Asked the instant the caller is told, with no waiting: the write the hook made AFTER the
      // signal is already on disk, so the rollback that follows cannot race it.
      expect(existsSync(marker)).toBe(true);
    },
  );
});

// PR #228 review: the marker is EMPTY, so it is made with this project's hooks bypassed — the only
// commit anton makes that may. A `pre-commit` that stages files of its own is the reason: run, it
// either ships that content under a message saying the commit is empty, or leaves it loose in the
// worktree the NEXT ticket commits from, under a ticket that never wrote it.
suite("commitMarker (real git · a pre-commit hook that stages and succeeds)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-marker-hook-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);

    // The formatter-shaped hook: it rewrites the tree, stages what it wrote, and lets the commit
    // through. Nothing about it fails — a rejection is not what makes it dangerous here.
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      ["#!/bin/sh", "printf 'generated\\n' > generated.txt", "git add generated.txt", "exit 0", ""].join(
        "\n",
      ),
      "utf8",
    );
    chmodSync(hook, 0o755);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it.runIf(process.platform !== "win32")(
    "keeps the marker tree-identical to HEAD and the worktree clean",
    async () => {
      const before = g(["rev-parse", "HEAD"]);

      await commitMarker(repo, "WIP anton-x1: preserved");

      // One commit added, and it carries NOTHING: the hook's file is not in the marker's tree.
      expect(g(["rev-parse", "HEAD~1"])).toBe(before);
      expect(g(["rev-parse", "HEAD^{tree}"])).toBe(g(["rev-parse", `${before}^{tree}`]));
      expect(g(["log", "-1", "--format=%s"])).toBe("WIP anton-x1: preserved");
      // And the hook never ran at all, so there is no leftover for the next ticket's `git add -A`
      // to sweep up under its own name — the dirt a bypassed hook cannot make.
      expect(g(["status", "--porcelain"])).toBe("");
    },
  );

  // PR #228 review: a `commit-msg` hook enforcing conventional subjects would otherwise refuse
  // anton's `WIP <id>:` marker, costing a preserved ticket's work the only thing that makes it
  // findable — to a resume, and to the guard that keeps it out of a child ticket's pull request.
  it.runIf(process.platform !== "win32")("lands past a commit-msg hook that rejects it", async () => {
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(
      hook,
      ["#!/bin/sh", 'grep -q "^feat" "$1" || exit 1', "exit 0", ""].join("\n"),
      "utf8",
    );
    chmodSync(hook, 0o755);

    await commitMarker(repo, "WIP anton-x1: preserved");

    expect(g(["log", "-1", "--format=%s"])).toBe("WIP anton-x1: preserved");
  });
});

/**
 * Sibling attribution (anton-6vxl): one commit naming every ticket its work satisfied, not only the
 * ticket that was dispatched. Real git throughout — the whole mechanism is git's trailer parser and
 * `-z` framing, so a mocked `git log` would only prove the test's own assumptions.
 */
suite("sibling attribution trailers (real git)", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-satisfies-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it("reads back every id one commit claims, and says which commit claimed them", async () => {
    await commitMarker(repo, "anton-96yu: the dispatched ticket\n\nwhy this marker exists", {
      satisfies: ["anton-kwi6", "anton-5slr"],
    });
    const sha = g(["rev-parse", "HEAD"]);

    const claims = await readSatisfiedClaims(repo);
    expect(claims).toEqual([
      { sha, subject: "anton-96yu: the dispatched ticket", ticketIds: ["anton-kwi6", "anton-5slr"] },
    ]);

    // The claim is attributable: the caller learns WHICH commit satisfied the sibling, which is what
    // a bead note or an operator investigating a skip is owed.
    expect(await branchSatisfiesTicket(repo, "anton-kwi6")).toMatchObject({ sha });
    expect(await branchSatisfiesTicket(repo, "anton-5slr")).toMatchObject({ sha });
    expect(await branchSatisfiesTicket(repo, "anton-never")).toBeUndefined();
  });

  it("leaves a commit that claims nothing untouched — no trailer, no claim", async () => {
    await commitMarker(repo, "anton-96yu: no siblings claimed");

    expect(g(["log", "-1", "--format=%B"]).trim()).toBe("anton-96yu: no siblings claimed");
    expect(await readSatisfiedClaims(repo)).toEqual([]);
    expect(await branchSatisfiesTicket(repo, "anton-96yu")).toBeUndefined();
    // An empty `satisfies` is the same as none — no stray blank trailer block.
    await commitMarker(repo, "anton-z9: still nothing", { satisfies: [] });
    expect(g(["log", "-1", "--format=%B"]).trim()).toBe("anton-z9: still nothing");
    expect(await readSatisfiedClaims(repo)).toEqual([]);
  });

  /**
   * The subject protocol is load-bearing and matched by PREFIX, so the trailer must be invisible to
   * it: `<id>:` still means delivered, `WIP <id>:` still means preserved-and-incomplete, and neither
   * gains or loses a meaning by carrying sibling attribution.
   */
  it("keeps the delivery and preserve subjects reading exactly as before", async () => {
    await commitMarker(repo, "anton-d1: delivered", { satisfies: ["anton-sib1"] });
    await commitMarker(repo, "WIP anton-d2: preserved", { satisfies: ["anton-sib2"] });

    expect(await worktreeHasCommitFor(repo, "anton-d1")).toBe(true);
    expect(await worktreeHasPreservedCommitFor(repo, "anton-d2")).toBe(true);
    // A ticket named ONLY in a trailer is not a delivery subject — the two records stay distinct.
    expect(await worktreeHasCommitFor(repo, "anton-sib1")).toBe(false);
    expect(await worktreeHasPreservedCommitFor(repo, "anton-sib1")).toBe(false);
    // …and the preserved commit is still the branch tip, which the resume's range read depends on.
    expect(await worktreeTipIsPreservedCommitFor(repo, "anton-d2")).toBe(true);
  });

  it("does not mistake trailer-shaped PROSE in a body for a claim", async () => {
    // Git only parses the message's LAST block as trailers, and this line is followed by prose.
    g([
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `anton-p1: prose\n\n${SATISFIES_TRAILER}: anton-forged\n\nand then more prose follows.`,
    ]);

    expect(await readSatisfiedClaims(repo)).toEqual([]);
  });

  /**
   * The marker subject the satisfied close writes (PR #258 review) — read back so a settlement can
   * follow it to the work rather than record the marker a sibling's close left at the tip.
   */
  it("round-trips the attribution marker subject, and refuses what is not one", () => {
    const work = "a".repeat(40);
    const subject = satisfiedMarkerSubject("anton-kwi6", work);

    expect(subject).toBe(`anton: anton-kwi6 satisfied by ${work}`);
    expect(satisfiedMarkerTarget(subject)).toBe(work);
    // Not a marker: an ordinary delivery, a preserve, an abbreviation (indistinguishable from prose
    // ending in hex), and a subject that merely reads like one.
    expect(satisfiedMarkerTarget("anton-kwi6: Operator control")).toBeUndefined();
    expect(satisfiedMarkerTarget("WIP anton-kwi6: preserved")).toBeUndefined();
    expect(satisfiedMarkerTarget("anton: anton-kwi6 satisfied by 41af614")).toBeUndefined();
    expect(satisfiedMarkerTarget(`anton: anton-kwi6 satisfied by ${work} and then some`)).toBeUndefined();
  });

  it("matches ids exactly, never by prefix", async () => {
    await commitMarker(repo, "anton-a1: work", { satisfies: ["anton-jz1.2"] });

    expect(await branchSatisfiesTicket(repo, "anton-jz1.2")).toBeDefined();
    // The same collision `worktreeHasCommitFor` guards against in its subject scan.
    expect(await branchSatisfiesTicket(repo, "anton-jz1")).toBeUndefined();
  });

  it("refuses an id that would forge extra trailer lines rather than recording it", async () => {
    await expect(
      commitMarker(repo, "anton-a1: work", {
        satisfies: [`anton-ok\n${SATISFIES_TRAILER}: anton-smuggled`],
      }),
    ).rejects.toThrow(SATISFIES_TRAILER);
    // Nothing was committed — the refusal is loud, not a marker recording something else.
    expect(g(["log", "-1", "--format=%s"])).toBe("init");
  });

  it("collects claims across several commits, newest first, ignoring unrelated ones", async () => {
    await commitMarker(repo, "anton-one: first", { satisfies: ["anton-s1"] });
    const first = g(["rev-parse", "HEAD"]);
    g(["commit", "-q", "--allow-empty", "-m", "an ordinary commit with no attribution"]);
    await commitMarker(repo, "anton-two: second", { satisfies: ["anton-s2"] });
    const second = g(["rev-parse", "HEAD"]);

    expect(await readSatisfiedClaims(repo)).toEqual([
      { sha: second, subject: "anton-two: second", ticketIds: ["anton-s2"] },
      { sha: first, subject: "anton-one: first", ticketIds: ["anton-s1"] },
    ]);
  });

  it("fails closed to no claims when git cannot be read", async () => {
    const gone = join(sandbox, "not-a-repo");
    mkdirSync(gone);

    // "Unreadable" must never read as "this ticket was satisfied" — the safe error is re-running
    // work, never skipping it.
    expect(await readSatisfiedClaims(gone)).toEqual([]);
    expect(await branchSatisfiesTicket(gone, "anton-s1")).toBeUndefined();
    // …and `strict` is how a caller whose safe answer is the other one sees the failure instead.
    await expect(readSatisfiedClaims(gone, { strict: true })).rejects.toThrow();
  });
});
