/**
 * Integration tests for openPullRequest idempotency (anton-kh6). Uses REAL git against a temp
 * repo + bare `origin`, and a stateful fake `gh` (ANTON_GH_BIN) that models `pr create` failing
 * on a duplicate and `pr view <branch>` resolving the branch's PR. Proves a resumed execute-epic
 * run that re-reaches the PR step reuses the existing PR instead of erroring on `gh pr create`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPullRequest, pullRequestState, resolveFreshBase, worktreeHasCommitFor } from "./ops";
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
if(a[0]==='pr'&&a[1]==='create'){
  const branch=get('--head');const s=read();
  if(s[branch]){process.stderr.write('a pull request for branch already exists\\n');process.exit(1);}
  const n=(s.__next||42);s[branch]={number:n,url:'https://github.com/acme/repo/pull/'+n,state:'OPEN'};s.__next=n+1;write(s);
  process.stdout.write(s[branch].url+'\\n');process.exit(0);
}
if(a[0]==='pr'&&a[1]==='view'){
  const branch=a[2];const s=read();const pr=s[branch];
  if(!pr){process.stderr.write('no pull requests found\\n');process.exit(1);}
  process.stdout.write(JSON.stringify(pr)+'\\n');process.exit(0);
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
