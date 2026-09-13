# Replace the hooks-bridge with a `-c core.hooksPath` override Implementation Plan

**Goal:** Delete the ~450-line hand-rolled "bridge a relative `core.hooksPath` into a linked
worktree" subsystem in `src/lib/git/worktree.ts` and replace it with a one-line fix: every git
command anton runs from a worktree passes `-c core.hooksPath=<absolute-path-resolved-in-repoPath>`,
so hooks fire from the worktree's tree using the exact directory the base repo would have used —
no symlink, no `info/exclude` mutation, no cross-process lock, no bridge registry.

**Architecture:** `worktree.ts`'s `git()` helper and `ops.ts`'s `git()`/`gitCommit()`/`diffPaths()`/
`showPaths()`/`gitBounded()` helpers all shell out via `execFile`/`spawn` with `-C <cwd>`. Every one
of them gets an optional `hooksPath?: string` parameter that — when the caller is running against a
worktree, not the base repo — is resolved once (by reading `core.hooksPath` from the **base repo's**
config, absolutized against the base repo) and passed as `-c core.hooksPath=<absolute>` ahead of
`-C`. Git resolves an absolute `core.hooksPath` identically regardless of which working tree or
worktree invoked it (git-config(1)), so this makes hooks fire correctly from every worktree with zero
per-repo-layout special-casing (relative paths, `.git`-rooted paths, `includeIf` conditionals,
escaping, whitespace — all still handled, for free, by resolving from the base repo exactly the way
the base repo itself would).

Two things it does **not** need to solve, because nothing in the current worktree flow needs them:
- `extensions.worktreeConfig` / `git config --worktree` — never used; this is a per-invocation CLI
  flag, not a config write.
- Bridging the hook directory into the worktree's own working tree (symlinks, `info/exclude`,
  registries) — hooks read from the resolved absolute path directly; nothing needs to exist inside
  the worktree at all.

**Tech Stack:** TypeScript, Node's `child_process` (`execFile`/`spawn`), `vitest` (unit) with real
`git` subprocess integration tests (the existing pattern in `ops.test.ts`/`worktree.test.ts`), `bun`
runtime.

**Estimated Complexity:** Medium — the change touches many call sites (mechanical: thread one new
parameter through), but the deletion is large and must not regress the one behavior six of the
codex review rounds converged on: a `pre-push` (or any other) hook configured via `core.hooksPath`
must actually fire when anton pushes from a worktree.

**Risk Areas:**
- Missing a `git()` call site that should get the hooks-path override (a hook silently not firing is
  exactly the bug class being fixed — must not reintroduce a narrower version of it).
- `commitAll`/`commitMarker` deliberately run with `--no-verify` in some paths (the ticket-timeout
  preserve bypass, `commitMarker`'s own attribution commits) — the override must not interfere with,
  or paper over, those deliberate bypasses.
- The base repo's own `core.hooksPath` read must still handle `includeIf "onbranch:…"` — resolved
  from **the branch the base repo has checked out**, since with this design there's no more "read it
  from the worktree's effective config" step. This is a *behavior change* worth calling out: today's
  code reads hooksPath from the worktree's own branch (PR #263 round 4 fix). The new design reads
  git's own answer for whatever `-c core.hooksPath` git resolves against **the worktree's `-C`
  path**, using `git -C <worktreePath> config --get core.hooksPath` exactly as today — that part is
  unchanged. What's deleted is only the *materialization* (symlink + exclude), not the *read*.

---

## Phases Overview

- [ ] **Phase 1: Add the hooks-path override plumbing to `ops.ts`** - Agent: none available (this
      repo's discovered specialist agents are FastAPI/Next.js/Terraform/etc. — none matches
      TypeScript git-internals work); implement directly. - Add a resolver + thread `-c
      core.hooksPath=<absolute>` through every git invocation in `ops.ts` that can run against a
      worktree.
- [ ] **Phase 2: Delete the hooks-bridge subsystem from `worktree.ts`** - Same as above. - Remove
      `linkRelativeHooksPath`, `excludeHooksPath`, `unexcludeHooksPathIfUnused`,
      `readNormalizedHooksPath`, `escapeGitignorePattern`, the exclude-file locks (in-process +
      cross-process), and the bridge registry; stop calling any of it from `createWorktree`/
      `removeWorktree`.
- [ ] **Phase 3: Rewrite the hooks-related tests** - Same as above. - Replace the ~20
      hooks-bridge-specific tests in `worktree.test.ts` with a smaller set proving the override
      approach; keep `ops.test.ts`'s real-git pre-push regression tests, extended to assert the new
      mechanism.
- [ ] **Phase 4: Full verification** - Same as above. - Typecheck, lint, full unit + integration test
      run, manual smoke test with a real relative `core.hooksPath` repo.

*(No agent files exist in `**/agents/*.md` for this kind of work — `src/prompts/agents/*.md` are
prompts anton itself dispatches to *bd-labeled beads* for FastAPI/Next.js/Terraform/etc.; none
targets TypeScript git-internals refactors like this one. Implement directly rather than mis-assign
to a mismatched specialist.)*

---

## Phase 1: Add the hooks-path override plumbing to `ops.ts`

**Dependencies:** None

**Acceptance Criteria:**
- [ ] A new exported (or module-local, per call site needs) helper resolves the base repo's
      `core.hooksPath` once, absolutized, or `undefined` when unset/already absolute-and-resolvable
      without help.
- [ ] Every `git()`/`gitCommit()`/`diffPaths()`/`showPaths()`/`gitBounded()` call in `ops.ts` that
      can run against a worktree (i.e. every exported function taking a `worktreePath` parameter)
      accepts and forwards a hooks-path override into the `-c` flag.
- [ ] `pushBranch`, `commitAll`, `commitMarker`, `mergeIntoCurrent` — the four functions that
      actually invoke hook-bearing git subcommands (`push`, `commit`, `merge`) — receive the
      resolved override from their callers and pass it through.
- [ ] Read-only plumbing commands (`rev-parse`, `show`, `ls-tree`, `merge-base`, `status`,
      `symbolic-ref`, `diff`, `log`, `fetch`) do **not** need the override — git hooks only fire on
      `commit`, `push`, `merge`, `checkout`, etc. — but accepting the same optional parameter
      everywhere keeps `git()` itself simple (one helper, one signature) rather than forking it into
      hook-aware and hook-unaware variants. Decide per Task 1.1 below and document the choice inline.
- [ ] `bun run typecheck` passes.

**Complexity:** Medium

**Files:**
- Modify: `src/lib/git/ops.ts` — `git()` (:17), `gitCommit()` (:255), `pushBranch()` (:757),
  `commitAll()` (:525), `commitMarker()` (:609), `mergeIntoCurrent()` (:843)
- Modify: `src/lib/git/worktree.ts` — the local `git()` helper (:40), used by `createWorktree`
  internals that invoke `worktree add`/`lock`/`unlock` (these do not fire project hooks — `git
  worktree` subcommands are not hook points — so this file's own `git()` needs **no** override;
  confirm and note why in a comment rather than adding unused plumbing)
- Modify: `src/lib/jobs/steps/git.ts` — `commitStep()` (:56), `prStep()` (:194) — resolve and pass
  the override using `ctx.repoPath` (already on `StepContext`)
- Modify: `src/lib/jobs/execute-epic-ticket-preserve.ts` — `commitPreservedTree()` (:492) — resolve
  using `run.repoPath` (available on the `Omit<StepContext, "tickets">` passed in)
- Modify: `src/lib/jobs/review-fix.ts` — `commitAndPushFix()` (:682), the `mergeIntoCurrent` calls at
  :491 and :508 — resolve using the `repo` parameter already in scope at every call site
- Modify: `src/lib/git/refresh.ts` — the `mergeIntoCurrent` call at :133 — check whether `refresh.ts`
  operates on the base repo directly (if so, no override needed — the base repo already resolves its
  own `core.hooksPath` natively; only worktree-run commands need the `-c` override)
- Create/extend: `src/lib/git/ops.test.ts` — new tests for the resolver
- Create/extend: `src/lib/git/worktree.test.ts` — comment/assert the no-op decision for `worktree.ts`'s own `git()`

### Task 1.1: Write the failing test for the hooks-path resolver

**Step 1: Write the failing test**

Add to `src/lib/git/ops.test.ts`, near the existing push/hooks regression suite (:268):

```typescript
describe("resolveHooksPathOverride (real git)", () => {
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
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/git/ops.test.ts -t "resolveHooksPathOverride"`
Expected: FAIL — `resolveHooksPathOverride is not defined` (not exported from `./ops` yet)

**Step 3: Implement the resolver**

In `src/lib/git/ops.ts`, near `hasRemote` (:737), add:

```typescript
/**
 * Resolve `repoPath`'s effective `core.hooksPath`, absolutized against `repoPath` — or `undefined`
 * when unset. Every git command anton runs against a WORKTREE of this repo passes the result back
 * in as `-c core.hooksPath=<this>`, so the worktree's hooks are exactly the base repo's, resolved
 * once from the one place git itself would resolve them from. An absolute `core.hooksPath` already
 * means the same thing from anywhere and is returned unchanged; a relative one is resolved against
 * `repoPath` because that is where the user configured it to mean something (git-config(1): a
 * relative `core.hooksPath` is documented as relative to the directory holding it, i.e. the
 * checkout it was configured in — the base repo here, never the worktree, which has no config of
 * its own to configure it relative to).
 */
export async function resolveHooksPathOverride(repoPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await git(repoPath, ["config", "--get", "core.hooksPath"]);
  } catch {
    return undefined; // unset, or unreadable — nothing to override with
  }
  if (!raw) return undefined;
  return isAbsolute(raw) ? raw : resolve(repoPath, raw);
}
```

Add `import { isAbsolute, resolve } from "node:path";` to `ops.ts`'s import block (:6-10).

**Step 4: Run test to verify it passes**

Run: `bun run test -- src/lib/git/ops.test.ts -t "resolveHooksPathOverride"`
Expected: PASS (3 tests)

### Task 1.2: Thread the override through `git()` and the hook-firing functions

**Step 1: Write the failing test**

Extend the existing real-hook suite in `ops.test.ts` (the one at :278, "push runs from the worktree,
not the base repo"). Add a new `describe` block right after it:

```typescript
describe("pushBranch fires a relative core.hooksPath configured in the base repo (real git)", () => {
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

    // Relative hooksPath, resolved in the BASE repo — never materialized in the worktree.
    mkdirSync(join(repo, ".githooks"));
    const hookPath = join(repo, ".githooks", "pre-push");
    writeFileSync(hookPath, `#!/usr/bin/env sh\ngit rev-parse --abbrev-ref HEAD >> "${hookLog}"\n`);
    chmodSync(hookPath, 0o755);
    g(["config", "core.hooksPath", ".githooks"]);

    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
    g(["push", "-q", "-u", "origin", "main"]);

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
```

Import `resolveHooksPathOverride` in the test file's import block from `./ops`.

**Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/git/ops.test.ts -t "fires the base repo's relative-hooksPath"`
Expected: FAIL — `pushBranch` does not accept a third argument yet (TypeScript error) or the hook
never fires (hook log empty) if you loosen the type temporarily to check runtime behavior first.

**Step 3: Implement — thread `hooksPath` through `git()`, `gitCommit()`, and the four callers**

In `src/lib/git/ops.ts`:

```typescript
async function git(cwd: string, args: string[], hooksPath?: string): Promise<string> {
  const configArgs = hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
  const { stdout } = await execFileAsync("git", [...configArgs, "-C", cwd, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}
```

```typescript
function gitCommit(cwd: string, args: string[], hooksPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const configArgs = hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
    const child = spawn("git", [...configArgs, "-C", cwd, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    // ...unchanged below
```

Update the four hook-firing exports to accept and forward it:

```typescript
export async function pushBranch(cwd: string, branch: string, hooksPath?: string): Promise<void> {
  await git(cwd, ["push", "-u", "origin", branch], hooksPath);
}

export async function commitAll(
  worktreePath: string,
  message: string,
  options: { bypassHooks?: boolean; hooksPath?: string } = {},
): Promise<{ committed: boolean }> {
  await git(worktreePath, ["add", "-A"], options.hooksPath);
  const bypass = options.bypassHooks ? ["--no-verify"] : [];
  try {
    await git(worktreePath, ["diff", "--cached", "--quiet"]);
    return { committed: false };
  } catch {
    await gitCommit(worktreePath, ["commit", ...bypass, "-m", message], options.hooksPath);
    return { committed: true };
  }
}

export async function commitMarker(
  worktreePath: string,
  message: string,
  options: { satisfies?: string[]; hooksPath?: string } = {},
): Promise<void> {
  await git(worktreePath, ["reset", "--quiet", "--mixed", "HEAD"]);
  const body = withSatisfiesTrailers(message, options.satisfies);
  // commitMarker always runs --no-verify by design (see its doc comment) — no hooksPath needed on
  // the commit itself, since hooks are explicitly bypassed here already.
  await gitCommit(worktreePath, ["commit", "--allow-empty", "--no-verify", "-m", body]);
}

export async function mergeIntoCurrent(
  worktreePath: string,
  ref: string,
  opts?: { ffOnly?: boolean; hooksPath?: string },
): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await git(worktreePath, ["merge", "--no-edit", ...(opts?.ffOnly ? ["--ff-only"] : []), ref], opts?.hooksPath);
    return { ok: true, conflicts: [] };
  } catch (e) {
    const conflicts = await diffPaths(worktreePath, ["--name-only", "--diff-filter=U"]).catch(() => []);
    if (conflicts.length === 0) {
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      throw e;
    }
    return { ok: false, conflicts };
  }
}
```

Note: `commitMarker` deliberately keeps `--no-verify` unconditional (see its existing doc comment at
:596-608) — it's an internal attribution-only marker commit, never a place project hooks are
expected to run. No `hooksPath` threading needed there beyond accepting the option for API
consistency with `commitAll` (harmless to add, but not required — include it only if a call site
needs it; none currently does, so it can be omitted from `commitMarker`'s options entirely to avoid
dead plumbing. **Decide and document this explicitly in the diff.**)

**Step 4: Run test to verify it passes**

Run: `bun run test -- src/lib/git/ops.test.ts -t "fires the base repo's relative-hooksPath"`
Expected: PASS

Run the full existing push-cwd suite to confirm no regression:
Run: `bun run test -- src/lib/git/ops.test.ts -t "push runs from the worktree"`
Expected: PASS (all 4 existing tests, unchanged)

### Task 1.3: Wire callers to resolve and pass the override

**Step 1: Update `openPullRequest`**

In `src/lib/git/ops.ts`, `openPullRequest` (:1923):

```typescript
export async function openPullRequest(opts: {
  repoPath: string;
  worktreePath?: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  if (!(await hasRemote(opts.repoPath))) {
    throw new Error(
      `no "origin" remote in ${opts.repoPath}; cannot open a PR. Add a remote or open it manually.`,
    );
  }
  const hooksPath = await resolveHooksPathOverride(opts.repoPath);
  await pushBranch(opts.worktreePath ?? opts.repoPath, opts.branch, hooksPath);
  // ...rest unchanged
```

**Step 2: Update `commitStep` in `src/lib/jobs/steps/git.ts`**

```typescript
export async function commitStep(ctx: StepContext): Promise<StepResultWith<"committed">> {
  const hooksPath = await resolveHooksPathOverride(ctx.repoPath);
  const { committed } = await commitAll(ctx.worktreePath, commitMessage(ctx), { hooksPath });
  // ...rest unchanged
```

Add `resolveHooksPathOverride` to the import from `../../git/ops` at the top of `git.ts`.

**Step 3: Update `commitPreservedTree` in `src/lib/jobs/execute-epic-ticket-preserve.ts`**

The bypass path (`commitAll(worktreePath, message, { bypassHooks: true })`) is deliberately
hook-skipping already (see its doc comment on why: the tree was gate-verified, not hook-verified,
and bypass is the honest call). The FIRST attempt (the one that runs hooks normally) should get the
override:

```typescript
async function commitPreservedTree(args: {
  repoPath: string;
  worktreePath: string;
  logPath: string;
  message: string;
  before: WorktreeState;
}): Promise<{ committed: boolean } | { committed: false; error: unknown }> {
  const { repoPath, worktreePath, logPath, message, before } = args;
  const rejected = (error: unknown) => ({ committed: false as const, error });
  const verified = await stageAllAndHashTree(worktreePath).catch(() => null);
  const hooksPath = await resolveHooksPathOverride(repoPath);
  const first = await commitAll(worktreePath, message, { hooksPath }).catch(rejected);
  // ...rest unchanged (the bypass call stays hooksPath-free — --no-verify already skips hooks)
```

Update its one call site (:261) to pass `repoPath: run.repoPath` in the args object.

**Step 4: Update `commitAndPushFix` and the two `mergeIntoCurrent` calls in `src/lib/jobs/review-fix.ts`**

```typescript
async function commitAndPushFix(
  repo: string,
  worktreePath: string,
  epicId: string,
  branch: string,
  number: number,
): Promise<boolean> {
  const hooksPath = await resolveHooksPathOverride(repo);
  const { committed } = await commitAll(
    worktreePath,
    `${epicId}: address review feedback (PR #${number})`,
    { hooksPath },
  );
  const pushed = committed || (await branchAheadOfRemote(repo, branch));
  if (pushed) await pushBranch(worktreePath, branch, hooksPath);
  return pushed;
}
```

At :491 and :508, resolve `repo`'s hooksPath (both sites already have `repo`/`worktree.path` /
`worktreePath` in scope — check each function signature) and pass `{ hooksPath }` into
`mergeIntoCurrent`'s options.

Add `resolveHooksPathOverride` to the `../../git/ops` (or relevant relative path) import in
`review-fix.ts`.

**Step 5: Check `refresh.ts`'s `mergeIntoCurrent` call**

Read `src/lib/git/refresh.ts` around :133 — confirm whether it operates on `repoPath` directly (no
separate worktree). If so, no override is needed there (the base repo resolves its own
`core.hooksPath` without help — this is exactly the pre-existing, always-worked case). Leave it
unchanged; add a one-line comment explaining why it's exempt.

**Step 6: Run the full non-integration test suite**

Run: `bun run test`
Expected: All existing tests pass except the hooks-bridge-specific ones in `worktree.test.ts`, which
Phase 3 replaces. If any OTHER test fails, it signals a missed call site — fix before proceeding.

---

## Phase 2: Delete the hooks-bridge subsystem from `worktree.ts`

**Dependencies:** Phase 1 complete (the override must work before the bridge is removed, so the
codebase is never mid-refactor without hook coverage)

**Acceptance Criteria:**
- [ ] `linkRelativeHooksPath`, `readNormalizedHooksPath`, `escapeGitignorePattern`,
      `excludeHooksPath`, `unexcludeHooksPathIfUnused`, `ownershipMarker`, `TRAILING_SEP_RE`,
      `HOOKS_BRIDGE_REGISTRY_FILE`, `hooksBridgeRegistryPath`, `readHooksBridgeRegistry`,
      `writeHooksBridgeRegistry`, `HooksBridgeRegistry`, `excludeFileLocks`, `withExcludeFileLock`,
      `acquireCrossProcessExcludeLock`, `EXCLUDE_LOCK_DIR_NAME`, `EXCLUDE_LOCK_STALE_MS`,
      `EXCLUDE_LOCK_RETRY_MS`, `EXCLUDE_LOCK_TIMEOUT_MS` are all deleted from `worktree.ts`.
- [ ] `createWorktree` no longer calls `linkRelativeHooksPath` (:646).
- [ ] `removeWorktree` no longer calls `unexcludeHooksPathIfUnused` (:1402).
- [ ] No dangling imports (`appendFile`, `symlink` from `node:fs/promises`; `hostname` from
      `node:os`; `normalize`, `sep` from `node:path` if no longer used elsewhere in the file — check
      each before removing).
- [ ] `bun run typecheck` and `bun run lint` both pass with zero new errors.
- [ ] `worktree.ts` shrinks from ~1405 lines to roughly ~950 lines (the bridge is ~450 lines: 92-267,
      650-969, plus the two call sites).

**Complexity:** Low (pure deletion + import cleanup) — the risk is entirely in Phase 1 being correct
first, not in this phase's mechanics.

**Files:**
- Modify: `src/lib/git/worktree.ts`

### Task 2.1: Delete the bridge functions and their call sites

**Step 1: Delete the cross-process lock machinery (lines 98-203 in the current file)**

Remove:
- `excludeFileLocks` (:106)
- `EXCLUDE_LOCK_DIR_NAME`, `EXCLUDE_LOCK_STALE_MS`, `EXCLUDE_LOCK_RETRY_MS`, `EXCLUDE_LOCK_TIMEOUT_MS`
  (:109-113)
- `acquireCrossProcessExcludeLock` (:126-167)
- `withExcludeFileLock` (:174-203)

**Step 2: Delete the bridge registry (lines 205-266)**

Remove:
- The doc comment block and `HOOKS_BRIDGE_REGISTRY_FILE` (:223)
- `HooksBridgeRegistry` type (:225)
- `hooksBridgeRegistryPath` (:227-229)
- `readHooksBridgeRegistry` (:231-240)
- `writeHooksBridgeRegistry` (:242-251)
- `ownershipMarker` (:264-266)

**Step 3: Remove the `linkRelativeHooksPath` call from `createWorktree`**

At :640-647, change:

```typescript
  if (warm) await warmWorktree(wt, signal);
  // Unconditional, not just the `warm: false` branch (PR #263 review): `warmWorktree` itself is
  // best-effort — no recognized lockfile, or an install that throws — and catches its own failures,
  // so `warm: true` is no guarantee the install (and the `prepare` script that regenerates a
  // relative hooksPath) actually ran. linkRelativeHooksPath is a cheap, idempotent no-op once the
  // link already exists, so re-running it after a real warm costs one `git config --get`.
  await linkRelativeHooksPath(repoPath, wt.path);
  return wt;
```

to:

```typescript
  if (warm) await warmWorktree(wt, signal);
  // No hooks bridge to materialize here: every git command anton runs against this worktree passes
  // `-c core.hooksPath=<resolved from repoPath>` itself (see resolveHooksPathOverride in ops.ts) —
  // hooks fire from the base repo's own directory with no symlink, no info/exclude entry, and no
  // dependence on whether warming happened to regenerate anything.
  return wt;
```

**Step 4: Delete `linkRelativeHooksPath`, `readNormalizedHooksPath`, `escapeGitignorePattern`,
`TRAILING_SEP_RE`, `excludeHooksPath`, `unexcludeHooksPathIfUnused` (lines ~650-969)**

Remove the entire block from the `TRAILING_SEP_RE` regex through the end of
`unexcludeHooksPathIfUnused`'s closing brace.

**Step 5: Remove the `unexcludeHooksPathIfUnused` call from `removeWorktree`**

At :1396-1404, change:

```typescript
  const removed = existed && !existsSync(wt.path);
  // Looked up from the persisted registry (see unexcludeHooksPathIfUnused), not a live re-read of
  // this worktree's config — the checkout is gone by now, and config could have changed while it
  // existed anyway. Runs whenever the path is confirmed absent, not only when THIS call removed it,
  // so a registry entry left behind by a checkout deleted outside anton still gets swept up.
  if (!existsSync(wt.path)) {
    await unexcludeHooksPathIfUnused(wt.repoPath, wt.path);
  }
  return { removed, branchDeleted, branchSkipped };
```

to:

```typescript
  const removed = existed && !existsSync(wt.path);
  return { removed, branchDeleted, branchSkipped };
```

**Step 6: Clean up now-unused imports**

Check each of these still-imported names against the rest of the file before removing:
- `appendFile` — only used by `excludeHooksPath`/`writeHooksBridgeRegistry` → remove
- `symlink` — only used by `linkRelativeHooksPath` → remove
- `hostname` — still used by `claimLockReason`/`liveClaimLock`/lock-owner logging → **keep**
- `normalize`, `sep` — `sep` still used by `basenameOf`? Check; `normalize` only used by
  `readNormalizedHooksPath` → remove `normalize` if nothing else uses it, keep `sep` if
  `sanitizeBranch` or path joins still reference it (grep to confirm before deleting either)

Run: `grep -n "appendFile\|symlink\|normalize\b" src/lib/git/worktree.ts` after deletion to confirm
zero remaining references before removing from the import line.

**Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS, zero errors (would surface any missed reference to a deleted symbol)

---

## Phase 3: Rewrite the hooks-related tests

**Dependencies:** Phase 2 complete

**Acceptance Criteria:**
- [ ] Every test in `worktree.test.ts` whose name mentions `core.hooksPath`, `info/exclude`, or
      "hooks" (the 20 tests listed at :167-876 in the pre-refactor file) is deleted.
- [ ] A new, smaller test proves `createWorktree` no longer touches `info/exclude` or creates any
      symlink, for a repo with a relative `core.hooksPath` set.
- [ ] `ops.test.ts` keeps its existing 4 push-cwd regression tests unchanged, and gains the 2 new
      tests from Phase 1 Task 1.1/1.2 (resolver unit tests + the real relative-hooksPath firing
      test).
- [ ] `bun run test` — full unit suite — passes.
- [ ] `bun run test:integration` — the Dolt/bd-backed suites — passes (self-skips where its CLI is
      absent, per this repo's own test convention).

**Complexity:** Low-Medium — mostly deletion, one new positive-case test.

**Files:**
- Modify: `src/lib/git/worktree.test.ts` — delete lines 167-876 (the hooks/exclude test block, exact
  range depends on final Phase 2 diff — locate by `describe`/`it` titles above)
- Already modified in Phase 1: `src/lib/git/ops.test.ts`

### Task 3.1: Delete the obsolete hooks-bridge tests

**Step 1: Remove every `it(...)` block from `warm: false symlinks a relative core.hooksPath...`
through `removeWorktree unexcludes the ORIGINALLY bridged hooksPath...`**

These are the 20 tests listed at lines 167, 201, 229, 254, 281, 318, 353, 385, 425, 476, 507, 542,
574, 602, 642, 683, 731, 783, 840 (see the earlier `grep` inventory — re-run it against the current
file since line numbers will have shifted after Phase 2's `worktree.ts` edits don't affect this file,
but re-verify before deleting):

Run: `grep -n "core.hooksPath\|info/exclude\|hooksPath" src/lib/git/worktree.test.ts`

Delete each matching `it(...)` block in full (open brace to matching close).

**Step 2: Add one positive-coverage test that `createWorktree` no longer touches the filesystem for hooks**

```typescript
it("does not touch info/exclude or create any hooks symlink for a relative core.hooksPath", async () => {
  const repoPath = ...; // use this suite's existing beforeEach sandbox repo
  mkdirSync(join(repoPath, ".githooks"));
  writeFileSync(join(repoPath, ".githooks", "pre-push"), "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(join(repoPath, ".githooks", "pre-push"), 0o755);
  execFileSync("git", ["-C", repoPath, "config", "core.hooksPath", ".githooks"], { stdio: "ignore" });

  const wt = await createWorktree({ repoPath, branch: "anton/hooks-check", warm: false });

  expect(existsSync(join(wt.path, ".githooks"))).toBe(false);
  const excludePath = join(repoPath, ".git", "info", "exclude");
  const excludeContent = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  expect(excludeContent).not.toContain(".githooks");
});
```

Adapt variable names (`repoPath`, `sandbox`) to match this suite's actual `beforeEach` setup —
`worktree.test.ts`'s outer `suite("worktree manager (real git)", …)` block already has a `repo`
variable in scope; reuse it.

**Step 3: Run the test**

Run: `bun run test -- src/lib/git/worktree.test.ts`
Expected: PASS — the remaining worktree suite (creation, idempotency, claims, locks, warming) is
unaffected by this refactor; only the hooks-bridge tests were removed/replaced.

---

## Phase 4: Full verification

**Dependencies:** Phases 1-3 complete

**Acceptance Criteria:**
- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun run test` — full unit suite green
- [ ] `bun run test:integration` — green (or cleanly self-skipped, matching this repo's convention)
- [ ] Manual smoke test (Task 4.2) confirms a real Husky-style `.husky/_` relative hooksPath fires
      `pre-push` when anton's `pushBranch` runs from a worktree, matching the exact scenario the
      original PR #263 review thread was about.

### Task 4.1: Run the full gate

**Step 1:**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: All pass.

**Step 2:**

Run: `bun run test:integration`
Expected: Pass or self-skip per-suite (no failures).

### Task 4.2: Manual smoke test with real Husky

**Step 1: Set up a throwaway repo with Husky 9's layout**

```bash
mkdir /tmp/anton-hooks-smoke && cd /tmp/anton-hooks-smoke
git init -q -b main
git config user.email t@example.com
git config user.name test
mkdir -p .husky/_
cat > .husky/_/pre-push <<'EOF'
#!/usr/bin/env sh
echo "pre-push fired for $(git rev-parse --abbrev-ref HEAD)" >&2
exit 0
EOF
chmod +x .husky/_/pre-push
git config core.hooksPath .husky/_
echo "readme" > README.md
git add -A && git commit -q -m init
```

**Step 2: Simulate anton's worktree push using the new code path directly**

```bash
node -e '
const { pushBranch, resolveHooksPathOverride } = require("/Users/henriblancke/Documents/personal/anton/src/lib/git/ops.ts");
' # adjust to however this repo runs a one-off TS script (bun run, tsx, etc. — check package.json)
```

Or more simply, add a temporary throwaway `*.test.ts` exercising this against the smoke repo, run
it, then delete the temp file — whichever is faster given the repo's actual TS execution setup
(check `package.json` scripts for a `tsx`/`bun run <file>.ts` pattern before scripting this by hand).

**Step 3: Confirm the hook fired**

Expected: stderr shows `pre-push fired for <branch>` — proving the relative Husky hooksPath, which
motivated the entire original PR #263 thread, fires correctly under the new override-based approach
with zero symlinks or `info/exclude` writes anywhere in the smoke repo.

**Step 4: Clean up**

```bash
rm -rf /tmp/anton-hooks-smoke
```

---

## Execution Order

**Phase 1** — Implement directly (no matching specialist agent in this repo's discovered set)
- Add `resolveHooksPathOverride`, thread `hooksPath` through `git()`/`gitCommit()` and the four
  hook-firing functions, wire every caller
- Verify: `bun run test -- src/lib/git/ops.test.ts` passes, including the two new test blocks

**Phase 2** — Implement directly
- Dependencies: Phase 1 complete
- Delete the ~450-line hooks-bridge subsystem from `worktree.ts`
- Verify: `bun run typecheck` passes with zero dangling references

**Phase 3** — Implement directly
- Dependencies: Phase 2 complete
- Delete the 20 obsolete hooks-bridge tests, add 1 new positive-coverage test
- Verify: `bun run test -- src/lib/git/worktree.test.ts` passes

**Phase 4** — Full verification
- Dependencies: Phases 1-3 complete
- Run the complete gate (typecheck, lint, unit, integration)
- Manual smoke test against a real Husky-style repo, confirming the exact scenario PR #263's review
  thread was about now works with far less code

## Rollback Plan

**If Phase 1 reveals a call site this plan missed:** the resolver and threading are purely additive
until Phase 2 deletes the old bridge — Phase 1 can ship alone (old bridge + new override both active,
redundant but harmless) as a checkpoint if something in Phase 2/3 needs more investigation.

**If Phase 2 breaks something Phase 4 catches:** `git revert` the Phase 2 commit alone — Phase 1's
override plumbing stays in place (harmless if unused by anything reading the old bridge state), and
the old bridge resumes handling hooks exactly as before while the regression is investigated.

## Risk Mitigation

**Risk: A `git()` call site outside the four hook-firing functions actually needs the override too**
(e.g. `git checkout`, `git reset --hard` in `restoreWorktreeState`, which — per githooks(5) — does
NOT fire a hook on plain `reset`/`checkout` without `--recurse-submodules` complications, but verify
this assumption against the specific git commands `worktree.ts`/`ops.ts` invoke).
- Mitigation: Before Phase 2 deletes the bridge, grep every `git(...)` call site invoking `checkout`,
  `reset`, `commit`, `merge`, `push`, `am`, `rebase`, `cherry-pick` (the githooks(5) hook points) and
  confirm each either gets the override or is deliberately exempt with a documented reason (like
  `commitMarker`'s `--no-verify`).

**Risk: Regression in the exact scenario 15 rounds of PR #263 review fixed piecemeal** (relative
hooksPath, `.git`-rooted hooksPath, `includeIf onbranch`, whitespace, escaping, trailing backslash).
- Mitigation: `resolveHooksPathOverride` delegates ALL of this to `git config --get core.hooksPath`
  itself — reading git's own resolved answer rather than re-implementing gitignore-pattern escaping,
  path normalization, or `includeIf` evaluation. The `.git`-rooted case (a hooksPath physically under
  `.git`, which can't be materialized as a directory in a linked worktree) is now moot: nothing is
  materialized anywhere, so `-c core.hooksPath=.git/hooks` (absolutized to
  `<repoPath>/.git/hooks`) simply resolves git's own hook lookup to the base repo's real
  `.git/hooks`, which exists and works, from any worktree. Task 4.2's smoke test is the concrete
  proof for the most common real-world case (Husky).
