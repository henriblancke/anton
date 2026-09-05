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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_TIMEOUT_ENV,
  commitAll,
  commitMarker,
  DEFAULT_DIFF_PATCH_CHARS,
  diffAgainstBase,
  findOpenPullRequest,
  listDirBlobsAtRev,
  lookupOpenPullRequest,
  markPullRequestDraft,
  openPullRequest,
  pullRequestState,
  readFileAtRev,
  readPathHistory,
  readWorktreeState,
  resolveFreshBase,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  worktreeHasCommitFor,
  branchContainsCommit,
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

// PR #228 review: the index pin runs BEFORE the hooks do, so a `pre-commit` that stages a file and
// exits ZERO gets its content into the marker anyway — no rejection, so no `--no-verify` retry. A
// marker carrying a diff is content that passed none of the preservation gates, and a resume adopts
// it as the ticket's preserved work.
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
    // through. Nothing about it fails, which is why the rejection retry never sees it.
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

  it.runIf(process.platform !== "win32")("keeps the marker tree-identical to HEAD", async () => {
    const before = g(["rev-parse", "HEAD"]);

    await commitMarker(repo, "WIP anton-x1: preserved");

    // One commit added, and it carries NOTHING: the hook's file is not in the marker's tree.
    expect(g(["rev-parse", "HEAD~1"])).toBe(before);
    expect(g(["rev-parse", "HEAD^{tree}"])).toBe(g(["rev-parse", `${before}^{tree}`]));
    expect(g(["log", "-1", "--format=%s"])).toBe("WIP anton-x1: preserved");
    // And it is still in the WORKING TREE, where the caller's cleanliness check reads it — a marker
    // that swallowed it would leave a clean tree standing as proof nothing was left behind.
    expect(g(["status", "--porcelain"])).toContain("generated.txt");
  });
});
