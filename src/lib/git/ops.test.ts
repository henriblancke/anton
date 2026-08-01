/**
 * Integration tests for openPullRequest idempotency (anton-kh6). Uses REAL git against a temp
 * repo + bare `origin`, and a stateful fake `gh` (ANTON_GH_BIN) that models `pr create` failing
 * on a duplicate and `pr view <branch>` resolving the branch's PR. Proves a resumed execute-epic
 * run that re-reaches the PR step reuses the existing PR instead of erroring on `gh pr create`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DIFF_PATCH_CHARS,
  diffAgainstBase,
  findOpenPullRequest,
  listDirBlobsAtRev,
  markPullRequestDraft,
  openPullRequest,
  pullRequestState,
  readFileAtRev,
  readWorktreeState,
  resolveFreshBase,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  worktreeHasCommitFor,
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
  const n=(s.__next||42);s[branch]={number:n,url:'https://github.com/acme/repo/pull/'+n,state:'OPEN',isDraft:false};s.__next=n+1;write(s);
  process.stdout.write(s[branch].url+'\\n');process.exit(0);
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

  it("reports a draft flip gh refused rather than assuming it landed", async () => {
    // The caller says "still open, draft it by hand" on a false — so a silent true would be the lie.
    expect(await markPullRequestDraft(repo, "gh-999")).toBe(false);
    expect(await markPullRequestDraft(repo, "gh-")).toBe(false);
  });

  it("finds no PR for a branch that has none", async () => {
    expect(await findOpenPullRequest(repo, "anton/never-opened")).toBeUndefined();
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

  it("yields nothing for a rev that does not resolve, rather than throwing", async () => {
    expect(await listDirBlobsAtRev(repo, "origin/nope", [""])).toEqual([]);
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

  it("returns undefined for a missing path, a directory, and a rev that does not resolve", async () => {
    expect(await readFileAtRev(repo, "main", "nope.md")).toBeUndefined();
    expect(await readFileAtRev(repo, "main", "docs")).toBeUndefined();
    expect(await readFileAtRev(repo, "origin/nope", "AGENTS.md")).toBeUndefined();
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

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
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
});
