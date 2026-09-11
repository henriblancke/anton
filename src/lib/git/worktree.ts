/**
 * Git worktree manager (anton-dzh.2). Each autonomous run executes in an isolated worktree +
 * branch off the project's default branch; the worktree is removed when the run ends. See
 * DESIGN.md §4/§7. This module is the ONLY place anton runs `git worktree`.
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 * The job runner + execute-epic job depend on exactly these exports.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { appendFile, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { extraBinDirs, findOnPath, isExecutableFile } from "../bin";

const execFileAsync = promisify(execFile);

/** Allow tests / config to override where worktrees are created. Default: sibling dir of repo. */
export const WORKTREES_ROOT_ENV = "ANTON_WORKTREES_ROOT";

/** Opt out of warming: an install needing credentials anton doesn't have is worse than a cold start. */
export const WARM_ENV = "ANTON_WARM_WORKTREE";

/** Pin the exact setup command warming runs, overriding detection. Also how tests inject a fake. */
export const WARM_COMMAND_ENV = "ANTON_WARM_COMMAND";

export interface Worktree {
  /** Absolute path to the checked-out worktree. */
  path: string;
  /** The branch checked out in the worktree. */
  branch: string;
  /** Branch the worktree was created from. */
  baseBranch: string;
  /** The main repo the worktree belongs to. */
  repoPath: string;
}

/** Run a git command in `repoPath`, returning trimmed stdout. */
async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Git's own first line for a failed command — what a one-line reaper log can carry. */
function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = e.stderr?.trim() || e.message || String(err);
  return text.split("\n")[0].slice(0, 200);
}

/**
 * The directory anton creates this repo's run worktrees under. Also what the reaper scopes its sweep
 * to — a checkout outside it is not anton's to judge, whatever branch it holds.
 */
export function worktreesRootFor(repoPath: string): string {
  return (
    process.env[WORKTREES_ROOT_ENV] ??
    join(dirname(repoPath), ".anton-worktrees", basenameOf(repoPath))
  );
}

/** Where a worktree for `branch` should live. Outside the main working tree to avoid bd noise. */
export function worktreePathFor(repoPath: string, branch: string): string {
  return join(worktreesRootFor(repoPath), sanitizeBranch(branch));
}

function basenameOf(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || "repo";
}

/** Branch names → filesystem-safe segment (no slashes, etc.). */
export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

/**
 * Serialize whatever touches ONE branch's checkout — creating it, and the reaper's check-and-delete.
 * Without it the two interleave: the sweep proves a branch is residue, a run starts and checks that
 * very branch out, and the sweep then force-removes the fresh checkout with its uncommitted work.
 * Under the lock the sweep's last-moment re-read either SEES the starting run, or the run waits for
 * the removal and recreates what it needs.
 *
 * Per branch, so unrelated runs and sweeps still overlap, and in-process only: anton's runs and its
 * sweeps share one job runner, which is the whole population racing here. A SECOND anton process
 * over the same repo does not see this map at all — what holds it off is the git worktree lock
 * {@link withWorktreeClaim} takes, plus each destructive caller's last-moment re-read.
 */
const branchLocks = new Map<string, Promise<void>>();

function branchKey(repoPath: string, branch: string): string {
  return `${resolve(repoPath)}\u0000${branch}`;
}

/**
 * Same pattern as {@link branchLocks} below, in-process only, keyed per repo (`info/exclude` is
 * shared repo-wide, not per-branch): serializes `excludeHooksPath`'s appends against
 * `unexcludeHooksPathIfUnused`'s read-modify-write. Without it, a concurrent append landing between
 * the cleanup's read and its write is invisible to the cleanup's `existing` snapshot and gets
 * silently discarded by the rewrite — verified: an append landing in that window vanished entirely
 * (PR #263 review, round 8). Anton's own multiple concurrent `createWorktree`/`removeWorktree`
 * calls are the only writers this needs to serialize against each other; a human or another tool
 * editing `info/exclude` by hand at the same instant is a race no in-process lock can close anyway.
 */
const excludeFileLocks = new Map<string, Promise<void>>();

async function withExcludeFileLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const prior = excludeFileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
  const chain = prior.then(() => held);
  excludeFileLocks.set(key, chain);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (excludeFileLocks.get(key) === chain) excludeFileLocks.delete(key);
  }
}

/**
 * Prefixes an anton-added `info/exclude` pattern line so cleanup can tell it apart from a line the
 * user or another tool put there for their own reasons. Without this, `unexcludeHooksPathIfUnused`
 * deleting every line that textually matches the pattern would also delete a user's own pre-existing
 * identical entry — verified: a `/.mystuff` line the user added before anton ever touched the repo
 * was silently gone after the LAST anton worktree bridging `.mystuff` was removed, even though
 * anton's own `excludeHooksPath` never wrote a NEW line for it (its dedup check saw the user's line
 * already there and no-opped) (PR #263 review, round 8). The marker is itself a harmless gitignore
 * comment line (verified: doesn't affect matching), so a person reading `info/exclude` by hand also
 * sees which lines are anton's.
 */
function ownershipMarker(hooksPath: string): string {
  return `# anton:hooks-bridge:${hooksPath}`;
}

export async function withBranchLock<T>(
  repoPath: string,
  branch: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = branchKey(repoPath, branch);
  const prior = branchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
  const chain = prior.then(() => held);
  branchLocks.set(key, chain);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    // Nobody queued behind us, so the key is dropped: the map tracks live contention, not history.
    if (branchLocks.get(key) === chain) branchLocks.delete(key);
  }
}

/**
 * Who is actively USING a branch's checkout, keyed like the branch lock. Both destructive policies
 * prove a checkout is residue from RUN ROWS AND THE BOARD, and neither of those crosses a process
 * boundary: review-fix writes no run row at all, and one anton's run rows say nothing to a second
 * anton over the same repository. Either way the reader concludes "the bead is still open, release
 * the worktree" and force-removes a directory somebody is working in, discarding uncommitted work
 * and failing every command that follows. A claim is the missing evidence — the only thing a
 * teardown and a sweep re-read about a checkout their own rows cannot account for — so every job
 * that drives claude in a checkout holds one for as long as it is in there: an execute run for the
 * length of the run, review-fix for the length of the fix.
 *
 * This map is only the IN-PROCESS half of the claim; the durable half is a real `git worktree lock`
 * on the checkout (see {@link withWorktreeClaim}), which is what a second anton process — whose
 * teardown would otherwise force-remove the directory this one is fixing in — can actually see.
 */
const worktreeClaims = new Map<string, string[]>();

/** Marks a `git worktree lock` reason as anton's claim rather than another tool's lock. */
const CLAIM_LOCK_PREFIX = "anton-claim";

/** A claim lock's payload, parsed back out of git's lock reason. */
export interface ClaimLock {
  owner: string;
  pid: number;
  host: string;
}

/** The lock reason a claim writes. The pid and host are what makes a crashed claim recognizable. */
function claimLockReason(owner: string): string {
  return `${CLAIM_LOCK_PREFIX} ${owner.replace(/\s+/g, "-")} pid=${process.pid} host=${hostname()}`;
}

/** The claim a lock reason encodes, or undefined when the lock is not anton's to reason about. */
export function parseClaimLock(reason: string | undefined): ClaimLock | undefined {
  const m = reason?.trim().match(new RegExp(`^${CLAIM_LOCK_PREFIX} (\\S+) pid=(\\d+) host=(\\S+)$`));
  return m ? { owner: m[1], pid: Number(m[2]), host: m[3] } : undefined;
}

/** Whether a pid is still running. EPERM means it exists but belongs to another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The still-live claim a lock reason names, or undefined when the reason is not a claim at all or
 * names a process on THIS machine that has since died. A crashed anton leaves its lock behind, and a
 * lock nothing may ever break turns one crash into a checkout and branch that leak forever. A claim
 * recorded on another host is never judged — its pid means nothing here — so it is honoured as-is.
 */
export function liveClaimLock(
  reason: string | undefined,
  alive: (pid: number) => boolean = pidAlive,
  host: string = hostname(),
): ClaimLock | undefined {
  const claim = parseClaimLock(reason);
  if (!claim) return undefined;
  return claim.host === host && !alive(claim.pid) ? undefined : claim;
}

/** How a live claim reads in a refusal log. */
export function describeClaimLock(claim: ClaimLock): string {
  return `${claim.owner} is using the checkout (pid ${claim.pid} on ${claim.host})`;
}

/**
 * Hold `branch`'s checkout for as long as `fn` runs. The claim is taken UNDER the branch lock, so it
 * either lands before a removal starts or waits for that removal to finish — a claim can never be
 * taken in the window a reaper has already decided to delete in. `fn` itself runs outside the lock:
 * it drives a claude session for minutes, which no other run's teardown may be blocked on.
 *
 * The claim is recorded twice, because one anton process is not the whole population: in the map
 * above for this process's own reaper, and as a `git worktree lock` on the checkout for every other
 * process. Nothing about a checkout being in use is implicit to git — a second anton's teardown
 * force-removes whatever its own rows say is residue — so without that lock a concurrent process
 * deletes the directory this claim exists to protect, uncommitted fix and all.
 */
export async function withWorktreeClaim<T>(
  repoPath: string,
  branch: string,
  owner: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireWorktreeClaim(repoPath, branch, owner);
  try {
    return await fn();
  } finally {
    await releaseWorktreeClaim(repoPath, branch, owner);
  }
}

/**
 * The unscoped half of {@link withWorktreeClaim}, for a holder whose lifetime is not a callback: an
 * execute run claims its checkout for as long as it is executing, then must GIVE THE CLAIM BACK
 * before its own teardown — the teardown force-removes the checkout, and a live claim (this
 * process's included) is exactly what refuses that. Prefer the scoped form wherever the claim does
 * wrap a block; whoever calls this owes a {@link releaseWorktreeClaim} on every exit path.
 */
export async function acquireWorktreeClaim(
  repoPath: string,
  branch: string,
  owner: string,
): Promise<void> {
  const key = branchKey(repoPath, branch);
  await withBranchLock(repoPath, branch, async () => {
    // First claimant wins. Refusing here — not at the createWorktree that follows — is what makes
    // the claim exclusive even before the checkout exists: two jobs that both claimed an unmaterialized
    // branch would each see the other in `holders` and BOTH be refused their own checkout.
    const other = (worktreeClaims.get(key) ?? []).find((h) => h !== owner);
    if (other) {
      throw new Error(`[worktree] cannot claim ${branch} for ${owner}: ${other} is using the checkout`);
    }
    worktreeClaims.set(key, [...(worktreeClaims.get(key) ?? []), owner]);
    try {
      await lockClaimedWorktree(repoPath, branch, owner);
    } catch (err) {
      // The map entry alone protects nothing outside this process, so a claim that could not be
      // recorded on the checkout is no claim: drop it and fail rather than run the fix in a
      // directory a second anton is still free to force-remove.
      dropClaim(key, owner);
      throw err;
    }
  });
}

/**
 * Give back a claim taken by {@link acquireWorktreeClaim}. Idempotent — a holder that releases on
 * its teardown path AND in a `finally` must not pay a second, spurious unlock — and taken under the
 * branch lock, so the git lock is lifted and the map cleared as one step no teardown can read
 * halfway through.
 */
export async function releaseWorktreeClaim(
  repoPath: string,
  branch: string,
  owner: string,
): Promise<void> {
  const key = branchKey(repoPath, branch);
  await withBranchLock(repoPath, branch, async () => {
    if (!worktreeClaims.get(key)?.includes(owner)) return; // never held, or already given back
    if (dropClaim(key, owner)) await releaseClaimLock(repoPath, branch);
  });
}

/** Drop one holder's in-process claim. True when it was the last, so the git lock may come off. */
function dropClaim(key: string, owner: string): boolean {
  const held = worktreeClaims.get(key) ?? [];
  const at = held.indexOf(owner);
  const rest = at === -1 ? held : held.filter((_, i) => i !== at);
  if (rest.length > 0) {
    worktreeClaims.set(key, rest);
    return false;
  }
  worktreeClaims.delete(key);
  return true;
}

/**
 * Put the claim on the checkout itself, where another process can see it. Applies only once the
 * checkout exists — at claim time it usually does not (review-fix claims the branch, then
 * materializes it), and {@link createWorktree} takes the lock for the live claim the moment it does.
 *
 * Throws when the lock cannot be installed. The git lock is the ONLY half of the claim a second
 * anton can read, so proceeding without it means running the fix in a directory another process's
 * teardown is still free to force-remove, uncommitted work and all — a failure to record the claim
 * has to fail the claim.
 */
async function lockClaimedWorktree(repoPath: string, branch: string, owner: string): Promise<void> {
  const record = (await listWorktrees(repoPath)).find((r) => !r.isMain && r.branch === branch);
  if (!record) return; // not materialized yet — createWorktree locks it when it is
  if (record.locked) {
    const live = liveClaimLock(record.lockReason);
    // This process's own claim already says what we want said — a second holder needs no second lock.
    if (live && live.pid === process.pid && live.host === hostname()) return;
    // Another anton's live claim, or another tool's lock, is never ours to break or to write over.
    if (live) throw new Error(`[worktree] cannot claim ${record.path} for ${owner}: ${describeClaimLock(live)}`);
    if (!parseClaimLock(record.lockReason)) {
      throw new Error(
        `[worktree] cannot claim ${record.path} for ${owner}: it is locked by another owner ` +
          `(${record.lockReason || "no reason given"})`,
      );
    }
    await unlockWorktree(repoPath, record.path); // a dead claim's leftovers
  }
  try {
    await git(repoPath, ["worktree", "lock", "--reason", claimLockReason(owner), record.path]);
  } catch (err) {
    throw new Error(
      `[worktree] could not lock ${record.path} for ${owner}'s claim, so a second anton process ` +
        `could not see it and might remove the checkout: ${gitError(err)}`,
    );
  }
}

/** How hard a released claim tries to come off before an operator has to be told about it. */
const CLAIM_RELEASE_ATTEMPTS = 3;
const CLAIM_RELEASE_BACKOFF_MS = 100;

/**
 * Lift only THIS process's own claim lock: another anton may since have taken the checkout over.
 *
 * Retried, because the lock names a pid that is still running: a transient `git` failure here leaves
 * every later reaper pass — in this process and every other — reading the leftovers as a live claim,
 * leaking the worktree and its branch until anton restarts. A release that still cannot be proven is
 * reported loudly with the command that clears it by hand, never swallowed.
 */
async function releaseClaimLock(repoPath: string, branch: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLAIM_RELEASE_ATTEMPTS; attempt++) {
    try {
      const record = (await listWorktrees(repoPath)).find(
        (r) => !r.isMain && r.branch === branch && r.locked,
      );
      const claim = parseClaimLock(record?.lockReason);
      if (!record || claim?.pid !== process.pid || claim.host !== hostname()) return;
      await git(repoPath, ["worktree", "unlock", record.path]);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < CLAIM_RELEASE_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, CLAIM_RELEASE_BACKOFF_MS * attempt));
      }
    }
  }
  console.error(
    `[worktree] could not release this process's claim on ${branch} after ${CLAIM_RELEASE_ATTEMPTS} ` +
      `attempts, so every reaper pass will keep reading it as in use — clear it with ` +
      `\`git -C ${repoPath} worktree unlock ${worktreePathFor(repoPath, branch)}\`: ${gitError(lastError)}`,
  );
}

/** Best-effort `git worktree unlock` — a lock that outlives its holder must not be permanent. */
async function unlockWorktree(repoPath: string, path: string): Promise<void> {
  try {
    await git(repoPath, ["worktree", "unlock", path]);
  } catch {
    // Already unlocked, or the record is gone; the caller's removal reports the real outcome.
  }
}

/**
 * The job holding this branch's checkout, or undefined when nothing is. Read under the branch lock
 * by anything about to delete the checkout — outside it the answer is already stale. In-process
 * only: a claim held by ANOTHER anton is seen at the moment of removal instead, as the git worktree
 * lock {@link removeWorktree} refuses on.
 */
export function worktreeClaimHolder(repoPath: string, branch: string): string | undefined {
  return worktreeClaims.get(branchKey(repoPath, branch))?.[0];
}

/**
 * The job already holding this branch's checkout when someone OTHER than that holder asks for it,
 * or undefined when the caller may have it. Both halves of the claim are consulted, because each
 * covers what the other cannot: this process's map, and the `git worktree lock` a second anton
 * process leaves — the only evidence of a claim that survives crossing a process boundary.
 *
 * Our own process's lock is deliberately not a conflict on its own: the map above is the live
 * answer for it, and a lock this process failed to release (see {@link releaseClaimLock}) must not
 * lock the branch out of every later run until anton restarts.
 */
function conflictingClaim(
  holders: string[],
  record: WorktreeRecord | undefined,
  caller: string | undefined,
): string | undefined {
  const other = holders.find((h) => h !== caller);
  if (other) return `${other} is using the checkout`;
  const live = record?.locked ? liveClaimLock(record.lockReason) : undefined;
  if (live && !(live.pid === process.pid && live.host === hostname())) return describeClaimLock(live);
  return undefined;
}

/**
 * Create (or reuse) an isolated worktree + branch off `baseBranch` (default: the repo's current
 * HEAD branch). Idempotent: if a worktree for `branch` already exists it is returned as-is
 * (supports crash recovery / resumable runs). `warm: true` runs project setup (deps install — see
 * {@link resolveWarmCommand}), and is a no-op when nothing is needed.
 *
 * Reuse is refused while ANOTHER job holds the checkout (see {@link withWorktreeClaim}). Handing
 * the same directory to two jobs is worse than failing the second: review-fix and an execute run
 * would drive git, claude, tests and commits over one working tree, interleaving each other's
 * edits. The claim holder itself says so with `claimedBy` — it materializes its own checkout under
 * its claim, and refusing that would deadlock the very job the claim is for.
 */
export async function createWorktree(opts: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  warm?: boolean;
  /**
   * The claim holder this checkout is being created for, when the caller is one — an execute run
   * (for the length of the run) or review-fix (for the length of the fix). The claim is installed on
   * the checkout as part of `git worktree add`, so no window exists in which it reads as unclaimed.
   */
  claimedBy?: string;
  /** Abort an in-flight install so an operator's kill doesn't hold the run's slot for the full warm timeout. */
  signal?: AbortSignal;
}): Promise<Worktree> {
  const { repoPath, branch, warm, signal } = opts;

  // Only the registration is serialized against the reaper (see withBranchLock) — warming stays
  // outside it. A cold install runs for minutes, and by the time it starts the checkout exists and
  // the run row already names the branch, which is what the sweep re-reads before deleting anything.
  const wt = await withBranchLock(repoPath, branch, async (): Promise<Worktree> => {
    // A claim can be held before the checkout exists (review-fix claims, then materializes), and the
    // git lock that makes it visible to another anton process can only be taken once it does.
    const holders = worktreeClaims.get(branchKey(repoPath, branch)) ?? [];
    const record = (await listWorktrees(repoPath)).find((r) => r.branch === branch);
    const conflict = conflictingClaim(holders, record, opts.claimedBy);
    if (conflict) {
      throw new Error(
        `[worktree] refusing to hand ${branch}'s checkout to a second job: ${conflict}`,
      );
    }
    const claimed = holders[0];
    const existing: Worktree | null = record
      ? { path: record.path, branch, baseBranch: branch, repoPath }
      : null;
    // A registration can outlive its checkout: `git worktree list` reports an administrative record,
    // and the directory may already be gone (anton-2wvb). Reusing such a path hands a non-existent
    // cwd to `spawn`, which fails as ENOENT naming the *executable* — an error that reads as a
    // missing `claude` binary and sends debugging in entirely the wrong direction. Verify on disk.
    if (existing && existsSync(existing.path)) {
      if (claimed) await lockClaimedWorktree(repoPath, branch, claimed);
      return existing;
    }
    // Drop the stale record so `git worktree add` below isn't rejected as "already registered".
    if (existing) await forgetStaleWorktree(repoPath, existing.path);

    const baseBranch = opts.baseBranch ?? (await currentBranch(repoPath));
    const path = worktreePathFor(repoPath, branch);
    await mkdir(dirname(path), { recursive: true });

    // `--lock` as part of the ADD, never a `worktree lock` after it: git documents the two-step form
    // as racy, and this is the race that matters — between the two commands a concurrent anton's
    // teardown reads a fresh, unlocked checkout on the expected branch and force-removes it.
    const lockArgs = claimed ? ["--lock", "--reason", claimLockReason(claimed)] : [];
    if (await branchExists(repoPath, branch)) {
      await git(repoPath, ["worktree", "add", ...lockArgs, path, branch]);
    } else {
      await git(repoPath, ["worktree", "add", ...lockArgs, path, "-b", branch, baseBranch]);
    }

    // Canonicalize so the path matches what `git worktree list --porcelain` reports (symlinked
    // tmp dirs on macOS otherwise make repeat lookups return a different-looking path).
    return { path: await realpath(path), branch, baseBranch, repoPath };
  });

  if (warm) await warmWorktree(wt, signal);
  // Unconditional, not just the `warm: false` branch (PR #263 review): `warmWorktree` itself is
  // best-effort — no recognized lockfile, or an install that throws — and catches its own failures,
  // so `warm: true` is no guarantee the install (and the `prepare` script that regenerates a
  // relative hooksPath) actually ran. linkRelativeHooksPath is a cheap, idempotent no-op once the
  // link already exists, so re-running it after a real warm costs one `git config --get`.
  await linkRelativeHooksPath(repoPath, wt.path);
  return wt;
}

// Matches only the platform path separator (never a hardcoded `/` or `\`) so a trailing repeated
// separator collapses (`.husky/_/` → `.husky/_`) without touching a POSIX path's literal trailing
// backslash, which is a valid filename character there, just not a separator (PR #263 review,
// round 6).
const TRAILING_SEP_RE = new RegExp(`[${sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+$`);

/**
 * Read `core.hooksPath` from `worktreePath`'s own effective config, normalized the same way for
 * every caller that needs to know what hooksPath a worktree is (or was) bridging — creating the
 * link (linkRelativeHooksPath) and deciding whether an info/exclude entry is still needed after a
 * worktree is removed (unexcludeHooksPathIfUnused) must agree on this value, or a mismatch would
 * either leave a stale exclude line in place forever or remove one a surviving worktree still needs.
 * Returns `null` for "nothing to bridge" (unset, absolute, or unreadable — see body) — never for
 * "found but empty", which core.hooksPath cannot meaningfully be.
 */
async function readNormalizedHooksPath(worktreePath: string): Promise<string | null> {
  let rawHooksPath: string;
  try {
    // From worktreePath, not repoPath: `core.hooksPath` can come from an `includeIf
    // "onbranch:…"` conditional (git-config(1)), which resolves against whichever branch is
    // actually checked out where the query runs — the worktree's branch, not the base repo's
    // (PR #263 review, round 4). The worktree already exists by this point (createWorktree's
    // `git worktree add` ran above), so this reads its real, effective config.
    //
    // NOT the shared `git()` helper — it does a blanket `stdout.trim()`, which would silently
    // strip legitimate leading/trailing whitespace from a quoted config value (git-config(1):
    // whitespace inside a quoted value is preserved verbatim). Verified: a real `core.hooksPath =
    // ".hooks "` names a directory whose name has a trailing space, and the base checkout does
    // invoke a hook from it — trimming it here would make the bridge look for the wrong directory
    // (PR #263 review, round 6). Only the trailing newline `execFile` appends needs stripping.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "config", "--get", "core.hooksPath"],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    rawHooksPath = stdout.replace(/\n$/, "");
  } catch (e: unknown) {
    // Exit code 1 with no stderr is `git config --get` for an unset key — the common case, nothing
    // to preserve. Anything else (a wedged process, a 120s timeout under load) is silent hook loss
    // reproducing the exact PR #263 bug this exists to fix, so it must be visible.
    const code = (e as { code?: unknown }).code;
    if (code !== 1) {
      console.warn(
        `[worktree] could not read core.hooksPath for ${worktreePath}: ${gitError(e)} — ` +
          `a relative hooksPath, if set, may not be linked into this worktree`,
      );
    }
    return null;
  }
  if (!rawHooksPath || isAbsolute(rawHooksPath)) return null;

  // Normalize once and use this form everywhere it's needed (materializing, resolving, excluding):
  // git itself treats `./.husky/_` and `.husky/_` as the same config value (config stores it
  // verbatim, uninterpreted), but `join`/an `info/exclude` gitignore-pattern line do not — a
  // literal `./` prefix silently defeats both the `existsSync(link)` reuse check and the
  // exclude-pattern match (PR #263 review, round 3). `normalize` preserves trailing whitespace (not
  // a separator on any platform) but not a repeated trailing separator, which IS worth collapsing —
  // done here with `sep` alone, never a hardcoded `/` or `\`, so a POSIX path whose real, literal
  // last character happens to be `\` (a valid filename character there, just not a separator)
  // survives untouched (PR #263 review, round 6).
  return normalize(rawHooksPath).replace(TRAILING_SEP_RE, "");
}

/**
 * A relative `core.hooksPath` (Husky 9's `.husky/_`) is documented to resolve against the
 * directory the hook RUNS in — i.e. per-worktree, not the base repo (git-config(1)). A worktree
 * whose install never ran (`warm: false`, such as review-fix's fix checkout) — or whose install ran
 * but skipped/failed (no recognized lockfile, or a caught error in warmWorktree) — never regenerates
 * that directory, so git silently finds nothing there and every hook — including a project's
 * pre-push gate — is skipped with no warning (PR #263 review). Symlinking the worktree's copy at
 * the base repo's real directory keeps the same hooks active everywhere without touching git
 * config: `git config --worktree core.hooksPath` requires `extensions.worktreeConfig`, which breaks
 * this repo's own stringer `gitlog` collector (anton-uspu) — anton does not touch a repo's git
 * config for that reason. An absolute `core.hooksPath` already resolves identically from every
 * worktree and needs no help.
 *
 * Entirely best-effort: every step below can fail (a symlink can race a concurrent call) and none
 * of it should ever abort worktree creation over a hooks convenience (PR #263 review, round 2).
 */
async function linkRelativeHooksPath(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  const hooksPath = await readNormalizedHooksPath(worktreePath);
  if (hooksPath === null) return;

  // `normalize` already collapses a SAFE internal `..` (`a/../b` → `b`); a hooksPath that still
  // starts with `..` after that genuinely escapes repoPath/worktreePath — e.g. `../shared-hooks`,
  // a real pattern for sharing hooks across sibling checkouts. `join(worktreePath, hooksPath)`
  // silently collapses that back OUTSIDE the worktree (verified: it lands in
  // `worktreesRootFor(repoPath)`, the directory holding every OTHER branch's worktree too), so
  // this would symlink into a shared directory outside the intended sandbox rather than into the
  // worktree being created (caught by an independent review pass on this same diff). Bridging a
  // hooksPath that points elsewhere entirely is out of scope for "make this worktree's own copy
  // work" — warn and skip, matching the `.git`-rooted case just below.
  if (hooksPath === ".." || hooksPath.startsWith(`..${sep}`)) {
    console.warn(
      `[worktree] core.hooksPath (${hooksPath}) for ${repoPath} points outside the repo — refusing ` +
        `to link it into ${worktreePath}`,
    );
    return;
  }

  // A linked worktree's `.git` is a FILE, not a directory (gitrepository-layout(5)) — so a
  // hooksPath rooted under it (`.git/hooks`, or `.git` itself) can never be materialized as a
  // subdirectory there, and — verified against real git — resolves to neither this worktree's
  // private per-worktree gitdir nor the repo's common one; the hook is simply never found. There is
  // no fix this function can apply (making it work would mean overriding core.hooksPath on every
  // git invocation made from this worktree, which is well outside worktree creation); the honest
  // move is a loud, specific warning instead of silently doing nothing, so the actual failure mode
  // — hooks configured but never firing — is at least visible in logs (PR #263 review, round 3:
  // the previous EEXIST-swallow turned a crash into exactly that silent bypass).
  if (hooksPath === ".git" || hooksPath.startsWith(`.git${sep}`)) {
    console.warn(
      `[worktree] core.hooksPath (${hooksPath}) for ${repoPath} is rooted under .git, which is a ` +
        `file (not a directory) in a linked worktree — these hooks cannot run from ${worktreePath}; ` +
        `move them outside .git if this worktree needs to run them`,
    );
    return;
  }

  const target = resolve(repoPath, hooksPath);
  if (!existsSync(target)) return; // never materialized in the base repo either (e.g. no install yet)

  const link = join(worktreePath, hooksPath);
  if (existsSync(link)) return; // already a real dir (tracked hooks) or a prior link

  // No lock of its own: createWorktree's idempotent-reuse path can run this concurrently with a
  // second in-flight call for the same branch (both racing past withBranchLock, which has already
  // released by the time this runs). A concurrent winner's EEXIST anywhere below is silently fine.
  try {
    await mkdir(dirname(link), { recursive: true });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "EEXIST") return;
    console.warn(
      `[worktree] could not prepare a home for core.hooksPath (${hooksPath}) in ${worktreePath}: ` +
        `${gitError(e)} — hooks in this worktree may silently not run`,
    );
    return;
  }
  // Track success explicitly rather than swallowing every symlink() failure the same way: a
  // non-EEXIST error (e.g. EPERM — no symlink privilege) means no bridge exists at `link`, so
  // running excludeHooksPath anyway would permanently add `hooksPath` to info/exclude for a
  // directory that was never created here — hiding the real, still-broken hooks gap from `git
  // status`, and (if the same-named path happens to exist untracked in the base checkout for an
  // unrelated reason) hiding that too (PR #263 review, round 6).
  const linked = await symlink(target, link, "dir").then(
    () => true,
    (e: unknown) => {
      if ((e as { code?: string }).code === "EEXIST") return true; // already bridged — fine
      console.warn(
        `[worktree] could not link relative core.hooksPath (${hooksPath}) into ${worktreePath}: ` +
          `${gitError(e)} — hooks in this worktree may silently not run`,
      );
      return false;
    },
  );
  if (!linked) return;

  // The symlink's target is this machine's absolute path — a `commitAll`/`git add -A` in the
  // worktree (review-fix's fix commit) would otherwise stage it as a real, unignored, untracked
  // entry (PR #263 review, round 2 — reproduced even for Husky's own layout: `.husky/_`'s nested
  // `.gitignore` only covers files INSIDE it, not the `.husky/_` symlink entry itself when `.husky/`
  // is already tracked). `info/exclude` is git-native and — unlike `core.hooksPath` combined with
  // `extensions.worktreeConfig` — never read by anything outside git itself, so it can't repeat the
  // stringer breakage (anton-uspu) that ruled out a config-based fix. It IS shared across every
  // worktree of this repo (there is no per-worktree exclude file — gitrepository-layout(5)); the
  // entry is cleaned up by `unexcludeHooksPathIfUnused` once `removeWorktree` confirms no OTHER
  // worktree still bridges this hooksPath (PR #263 review, round 7).
  await excludeHooksPath(repoPath, worktreePath, hooksPath);
}

/**
 * Escape gitignore(5) pattern metacharacters in a literal path segment so it matches only itself.
 * `hooksPath` is a filesystem path, valid with characters that are wildcards in exclude-pattern
 * syntax (`*`, `?`, `[...]`) or that change how the LINE is parsed (`!` negates, `#` comments out,
 * a trailing space is stripped unless itself escaped) — verified with Git 2.43 that an unescaped
 * `.hooks[1]` fails to match its own literal directory, and an unescaped `.hooks*` also hides an
 * unrelated `.hooks-legitimate` (PR #263 review, round 5). Backslash-escaping every such character
 * makes the pattern match exactly the literal path, nothing more and nothing less.
 */
function escapeGitignorePattern(path: string): string {
  return path.replace(/[\\*?[\]!#]/g, "\\$&").replace(/ +$/, (m) => "\\ ".repeat(m.length));
}

/**
 * Append the exact `hooksPath` (never a broader prefix — a sibling untracked file under the same
 * parent must still surface in `git status`), MARKED as anton's own, to this repo's `info/exclude`
 * once. Best-effort: a failure here still leaves the hooks working, just with a stray untracked
 * entry `git status` would show until a fix commit's `git add -A` sweeps it up.
 *
 * Locked (`withExcludeFileLock`) and marked (`ownershipMarker`) for the same reason: this file is
 * shared repo-wide, and `unexcludeHooksPathIfUnused` removes lines from it later — without the lock
 * that removal can race a concurrent append into oblivion, and without the marker it can't tell an
 * anton-added line from a same-text line the user added themselves (PR #263 review, round 8).
 */
async function excludeHooksPath(
  repoPath: string,
  worktreePath: string,
  hooksPath: string,
): Promise<void> {
  const excludePath = await git(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]).catch((e: unknown) => {
    console.warn(`[worktree] could not resolve info/exclude for ${worktreePath}: ${gitError(e)}`);
    return null;
  });
  if (!excludePath) return;

  // Git's exclude-file syntax is line-oriented gitignore patterns, where a pattern with NO slash
  // matches at any depth (gitignore(5)) — so a single-segment hooksPath like `.githooks` written
  // bare would also hide an unrelated `packages/foo/.githooks/` from `git status`/`git add -A`
  // (PR #263 review, round 4). A leading `/` anchors to the repo root regardless of how many
  // segments hooksPath has, which is what's wanted: only THIS hooks bridge, nowhere else.
  const pattern = `/${escapeGitignorePattern(hooksPath)}`;
  const marker = ownershipMarker(hooksPath);

  await withExcludeFileLock(repoPath, async () => {
    const existing = await readFile(excludePath, "utf8").catch(() => "");
    const lines = existing.split("\n");
    // Already excluded — by anton (has its marker line immediately before it) or, just as good,
    // by the user's own unrelated pattern. Either way there's nothing to add.
    if (lines.includes(pattern)) return;

    // A leading newline guards against a rare pre-existing file with no trailing newline of its
    // own (e.g. hand-edited) — gitignore treats blank lines as no-ops, so this never fabricates or
    // corrupts a prior pattern regardless of what the last byte in the file was.
    await mkdir(dirname(excludePath), { recursive: true }).catch(() => {});
    await appendFile(excludePath, `\n${marker}\n${pattern}\n`).catch((e: unknown) => {
      console.warn(
        `[worktree] could not exclude ${hooksPath} in ${worktreePath}: ${gitError(e)} — ` +
          `a fix commit's \`git add -A\` may stage the hooks symlink`,
      );
    });
  });
}

/**
 * Undo `excludeHooksPath` for `removedWorktree`'s own hooksPath once it's gone, but ONLY if no
 * other live worktree of the same repo still bridges the same pattern. `info/exclude` is shared
 * across every worktree (gitrepository-layout(5) — there is no per-worktree exclude file), so a
 * pattern added for one worktree's hooks bridge is otherwise permanent: it silently hides a
 * same-named directory in the base checkout (and any sibling worktree) forever, even long after
 * the worktree that needed it is gone (PR #263 review, round 7 — reproduced: appending the pattern
 * to a fresh repo's info/exclude made its own untracked `.githooks/` vanish from `git status`).
 * Called from `removeWorktree` AFTER the worktree is actually gone, so `listWorktrees` below no
 * longer reports it as a survivor still needing the pattern. Entirely best-effort — a failure here
 * leaves a stray exclude line, the same “hooks convenience, never a gate” tradeoff as everywhere
 * else in this bridge.
 */
async function unexcludeHooksPathIfUnused(
  repoPath: string,
  removedWorktreePath: string,
  hooksPath: string,
): Promise<void> {
  const survivors = await listWorktrees(repoPath).catch(() => null);
  if (!survivors) return; // can't enumerate — leave the pattern rather than risk removing a used one

  for (const record of survivors) {
    // The base checkout is never a run worktree holding a symlink bridge — it's the SOURCE the
    // bridge points at, and its own core.hooksPath trivially always "matches" (config is repo-wide
    // by default). Counting it as a survivor would make cleanup a permanent no-op: verified this
    // was exactly the bug on the first pass at this fix — every hooksPath "survived" forever
    // because the main worktree always looked like a user.
    if (record.isMain) continue;
    if (record.path === removedWorktreePath) continue; // this is the one just removed
    if (!existsSync(record.path)) continue; // administrative record for an already-gone checkout
    const stillUsed = await readNormalizedHooksPath(record.path).catch(() => null);
    if (stillUsed === hooksPath) return; // a live worktree still bridges this exact pattern — keep it
  }

  // repoPath (the base checkout), not removedWorktreePath — that directory no longer exists, and
  // info/exclude is shared repo-wide regardless of which checkout resolves it (git-path resolves
  // to the same file from any worktree of this repo).
  const excludePath = await git(repoPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]).catch(() => null);
  if (!excludePath) return;

  const pattern = `/${escapeGitignorePattern(hooksPath)}`;
  const marker = ownershipMarker(hooksPath);

  // Locked against `excludeHooksPath`'s appends (PR #263 review, round 8: an append landing
  // between an unlocked read and write here was silently discarded by the rewrite below) and
  // marker-gated against a user's own pre-existing identical pattern (same review round: filtering
  // every textually-matching line deleted a `/.mystuff` the user added themselves, since nothing
  // distinguished it from anton's — the marker line immediately above a pattern is that evidence).
  await withExcludeFileLock(repoPath, async () => {
    const existing = await readFile(excludePath, "utf8").catch(() => null);
    if (existing === null) return;
    const lines = existing.split("\n");

    // Only a pattern line whose immediately preceding line is anton's own marker for THIS exact
    // hooksPath is anton's to remove. A bare pattern line with no marker (or a different marker)
    // is either the user's own entry or a stale line from a build predating the marker convention
    // — leave it untouched either way.
    const kept: string[] = [];
    let removedAny = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === pattern && lines[i - 1] === marker) {
        kept.pop(); // drop the marker line just pushed
        removedAny = true;
        continue; // and drop this pattern line
      }
      kept.push(lines[i]);
    }
    if (!removedAny) return; // nothing that was ours to remove

    await writeFile(excludePath, kept.join("\n")).catch((e: unknown) => {
      console.warn(`[worktree] could not clean up info/exclude entry for ${hooksPath}: ${gitError(e)}`);
    });
  });
}

/**
 * Deregister a worktree whose directory no longer exists. `--force` twice is deliberate: the first
 * discards dirty state, the second is what lets the removal proceed on a *locked* worktree. Locked
 * entries are the reason `git worktree prune` alone is not enough — git skips prunability checks on
 * them, so a locked record whose checkout was deleted is never reported as prunable and would
 * otherwise be reused forever. Best-effort: recreation below is what actually has to succeed.
 */
async function forgetStaleWorktree(repoPath: string, path: string): Promise<void> {
  try {
    await git(repoPath, ["worktree", "remove", "--force", "--force", path]);
  } catch {
    // Fall through to prune, which clears an unlocked record whose gitdir is dangling.
  }
  try {
    await git(repoPath, ["worktree", "prune"]);
  } catch {
    // best-effort
  }
}

/** Resolve the repo's current HEAD branch, falling back to "HEAD" (detached HEAD). */
async function currentBranch(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "HEAD";
  }
}

/**
 * Every local branch under `prefix/`. This is the reaper's proof that a branch still EXISTS: a run
 * row outlives the branch it names, so without it every settled run this project ever ran stays a
 * sweep candidate — and a permanent `gh` call — forever. It is also the only way branch-only residue
 * is seen at all, since a branch whose run row is gone (a recreated `anton.db`) has nothing else
 * pointing at it.
 */
export async function listBranches(repoPath: string, prefix: string): Promise<string[]> {
  const out = await git(repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${prefix}/`,
  ]);
  return out.split("\n").filter(Boolean);
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install can pull a whole dependency tree over the network on a cold cache; a slow warm still beats
 * the first verify gate failing on missing modules.
 */
const WARM_TIMEOUT_MS = 10 * 60_000;

/**
 * Lockfile → the install that materializes it, first match wins. Detection is lockfile-driven on
 * purpose: a repo with no recognized lockfile (go, rust, python) warms to a no-op instead of anton
 * guessing at a setup command.
 *
 * Every install is FROZEN. anton commits the worktree once a ticket's checks pass, so an install
 * that resolves a fresh dependency graph would quietly land its lockfile churn in the run's PR. A
 * lockfile out of sync with package.json fails the install instead — logged, non-fatal, and the run
 * merely pays the cold start it would have paid anyway.
 */
const INSTALL_BY_LOCKFILE: ReadonlyArray<{ lockfile: string; bin: string; args: string[] }> = [
  { lockfile: "bun.lock", bin: "bun", args: ["install", "--frozen-lockfile"] },
  { lockfile: "bun.lockb", bin: "bun", args: ["install", "--frozen-lockfile"] },
  { lockfile: "pnpm-lock.yaml", bin: "pnpm", args: ["install", "--frozen-lockfile"] },
  // Berry accepts `--frozen-lockfile` as a deprecated alias of `--immutable`, so one flag covers v1 too.
  { lockfile: "yarn.lock", bin: "yarn", args: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", bin: "npm", args: ["ci"] },
];

/** A resolved warm command: an absolute executable plus its argv, and a label for logs. */
export interface WarmCommand {
  file: string;
  args: string[];
  label: string;
}

/**
 * The project-setup command `worktreePath` needs, or null when there is nothing to run. Null covers
 * every "no-op when nothing is needed" case: warming turned off, no recognized lockfile, a completed
 * install already newer than the lockfile (a resumed run reusing its worktree), or no package
 * manager on the search path. Exported as the single testable seam — the shell-out itself is a
 * one-liner; `env` and `isExec` are injectable so the decision can be tested without a machine's
 * real toolchain.
 */
export function resolveWarmCommand(
  worktreePath: string,
  env: Record<string, string | undefined> = process.env,
  isExec: (p: string) => boolean = isExecutableFile,
): WarmCommand | null {
  const off = env[WARM_ENV]?.trim().toLowerCase();
  if (off === "0" || off === "off" || off === "false" || off === "no") return null;

  const pinned = env[WARM_COMMAND_ENV]?.trim();
  if (pinned) return { file: "sh", args: ["-c", pinned], label: pinned };

  // Structural guard, mirroring the claude driver: never shell out to a real package manager under
  // vitest. A test that wants the warm path pins WARM_COMMAND_ENV at a fake above.
  if (env.VITEST) return null;

  const install = INSTALL_BY_LOCKFILE.find((i) => existsSync(join(worktreePath, i.lockfile)));
  if (!install || !installNeeded(worktreePath, install.lockfile)) return null;

  // A background-launched server inherits a minimal PATH that omits where bun/pnpm live, so resolve
  // the absolute path the way every other anton spawn does (see ../bin).
  const file = findOnPath(install.bin, env.PATH ?? "", extraBinDirs(), isExec);
  if (!file) {
    console.warn(
      `[worktree] cannot warm ${worktreePath}: no '${install.bin}' on the search path (${install.lockfile} present) — ` +
        `the run's first step will pay the cold start, and fail on missing dependencies if it needs them.`,
    );
    return null;
  }
  return { file, args: [...install.args], label: `${install.bin} ${install.args.join(" ")}` };
}

/**
 * Written by {@link warmWorktree} only after an install exits 0. Living inside `node_modules` ties
 * its lifetime to the tree it vouches for: `rm -rf node_modules` takes the proof with it.
 */
const WARM_STAMP = ".anton-warm";

/**
 * True unless a COMPLETED install is on record newer than the lockfile. The stamp, not `node_modules`
 * itself, is the witness: an install killed partway (OOM, SIGKILL, dropped network) has already
 * written into `node_modules`, so its mtime is newer than the lockfile and a directory-mtime check
 * would call the half-populated tree current — surfacing later as `Cannot find module` inside a
 * supposedly pre-warmed worktree, with no further warming attempt.
 */
function installNeeded(worktreePath: string, lockfile: string): boolean {
  try {
    const warmed = statSync(join(worktreePath, "node_modules", WARM_STAMP)).mtimeMs;
    return warmed < statSync(join(worktreePath, lockfile)).mtimeMs;
  } catch {
    return true; // no stamp (fresh worktree, partial install, pre-stamp worktree) → install
  }
}

/**
 * Run project setup in the worktree so a run's first step doesn't pay cold-start cost (anton-8i5).
 * `node_modules` is gitignored, so a fresh worktree has none and the first verify gate fails as
 * `Cannot find module 'vitest/config'` — an error that reads as a broken test config rather than as
 * uninstalled dependencies.
 *
 * Best-effort by design: a failed install is logged loudly and the run continues. Warming is an
 * accelerator, not a gate — the verify gates still fail on the real error if the deps were genuinely
 * required, and an install anton can't complete (private registry, no network) must not be able to
 * lose an otherwise-good run.
 */
async function warmWorktree(wt: Worktree, signal?: AbortSignal): Promise<void> {
  const cmd = resolveWarmCommand(wt.path);
  if (!cmd) return;

  try {
    await execFileAsync(cmd.file, cmd.args, {
      cwd: wt.path,
      timeout: WARM_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Postinstall scripts shell out to node/git themselves; hand them the same augmented path the
      // package manager was resolved against, not the daemon's minimal one.
      env: { ...process.env, PATH: [process.env.PATH ?? "", ...extraBinDirs()].filter(Boolean).join(delimiter) },
      // An operator's kill must not be stuck behind a 10-minute install; aborting degrades into the
      // logged, non-fatal path below, exactly like a registry timeout.
      signal,
    });
    await stampWarmed(wt.path, cmd.label);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr?.trim() || e.message || String(err)).slice(-2000);
    console.warn(
      `[worktree] warming ${wt.path} with \`${cmd.label}\` failed — the run continues, but its first ` +
        `step may fail on missing dependencies: ${detail}`,
    );
  }
}

/**
 * Record that the install completed, so the next run can tell a finished tree from a half-written
 * one. Best-effort: a setup command that installs nothing into `node_modules` leaves nowhere to
 * write, and the only cost of a missing stamp is warming again.
 */
async function stampWarmed(worktreePath: string, label: string): Promise<void> {
  try {
    await writeFile(join(worktreePath, "node_modules", WARM_STAMP), `${label}\n`);
  } catch {
    // no node_modules / read-only tree → next warm re-runs the install
  }
}

/** One registered checkout, as `git worktree list --porcelain` reports it. */
export interface WorktreeRecord {
  path: string;
  /** The checked-out branch; absent for a detached or bare checkout. */
  branch?: string;
  /** Locked — by whichever tool created it. A locked checkout is never anton's to remove. */
  locked: boolean;
  /** The lock's reason when git carries one (`git worktree lock --reason`). */
  lockReason?: string;
  /** The repo's own working tree, which is never a run worktree. */
  isMain: boolean;
}

/** Every checkout git has registered for `repoPath`, main worktree first. */
export async function listWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    // git writes a bare `locked` line, or `locked <reason>` when one was given.
    const lock = lines.find((l) => l === "locked" || l.startsWith("locked "));
    records.push({
      path,
      branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined,
      locked: lock !== undefined,
      lockReason: lock?.slice("locked ".length).trim() || undefined,
      isMain: records.length === 0,
    });
  }
  return records;
}

/** Return the existing worktree for `branch`, or null. */
export async function findWorktree(repoPath: string, branch: string): Promise<Worktree | null> {
  const record = (await listWorktrees(repoPath)).find((w) => w.branch === branch);
  return record ? { path: record.path, branch, baseBranch: branch, repoPath } : null;
}

/** What {@link removeWorktree} actually did — the evidence a reaper's log is written from. */
export interface WorktreeRemoval {
  /**
   * True only when a checkout that WAS there is now gone. A path that was already absent reports
   * false: a report that counts it as reclaimed inflates every sweep with residue nobody removed.
   */
  removed: boolean;
  /** Why the checkout was left alone. Absent when it was removed (or was never there). */
  skipped?: string;
  branchDeleted: boolean;
  /**
   * Git's own words for a branch deletion that FAILED with the branch still present — a ref lock, or
   * a checkout outside this sweep's scope holding it. Absent when the branch went, and absent when it
   * was already gone: those two are the difference a reaper's log must not blur.
   */
  branchSkipped?: string;
}

/**
 * Whether the checkout is locked and with what reason, read from the `locked` file in the admin
 * directory its own `.git` marker points at. This needs neither the repo's index nor `git worktree
 * list`, so it is what still settles the question when the listing itself is unreadable. Undefined
 * means "cannot tell" — never "not locked".
 */
async function lockedInAdminDir(
  wt: Worktree,
): Promise<{ locked: boolean; reason?: string } | undefined> {
  try {
    const marker = await readFile(join(wt.path, ".git"), "utf8");
    const gitDir = marker.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!gitDir) return undefined;
    // Resolved against the CHECKOUT, not the process cwd: git writes an absolute gitdir today, but a
    // relative one (an older git, a moved repo) would otherwise be looked up under wherever anton
    // happens to be running — and a lock that can't be found reads as "not locked".
    const lockFile = join(resolve(wt.path, gitDir.trim()), "locked");
    if (!existsSync(lockFile)) return { locked: false };
    const reason = await readFile(lockFile, "utf8").catch(() => "");
    return { locked: true, reason: reason.trim() || undefined };
  } catch {
    return undefined;
  }
}

/** What {@link removalBlocker} concluded about a checkout it was asked to remove. */
interface RemovalGuard {
  /** Why the checkout must be left alone; absent when it is anton's to remove. */
  blocker?: string;
  /** A crashed anton's own claim lock is still on it — break that lock before removing. */
  staleClaimLock?: boolean;
}

/**
 * How a lock on the checkout is judged. Another tool's lock always blocks. anton's own claim lock
 * blocks while the process holding it is alive — that is the whole point of it, and the one signal a
 * concurrent anton has that the checkout is in use — but a claim whose process died on this machine
 * is leftovers, not evidence, and is broken rather than honoured forever.
 */
function judgeLock(reason: string | undefined, source?: string): RemovalGuard {
  const live = liveClaimLock(reason);
  if (live) return { blocker: source ? `${describeClaimLock(live)} — ${source}` : describeClaimLock(live) };
  if (parseClaimLock(reason)) return { staleClaimLock: true };
  const detail = reason ?? "no reason given";
  return { blocker: `locked by another owner (${source ? `${detail} — ${source}` : detail})` };
}

/**
 * Why `wt` must be left alone, or an empty guard when it is anton's to remove. Two cases, both read
 * from git at the moment of removal rather than trusted from a caller's snapshot.
 *
 * Someone LOCKED the checkout — another tool, or another anton process holding a claim on it (see
 * {@link withWorktreeClaim}): `git worktree remove --force` refuses a locked worktree, and the
 * orphan fallback below would then delete a directory another owner is working in — the lock is
 * precisely the statement that it must not.
 *
 * Or the path is no longer this branch's. Removal is by path and `--force` never checks what is on
 * it, so a path re-registered between a caller's `listWorktrees` snapshot and this call would be
 * deleted with whatever uncommitted work is on it. ANY registration that is not exactly this branch
 * blocks, including a detached HEAD: a reaper reaching a historical run's canonical path with a
 * branch-only candidate cannot tell anton's own checkout from a replacement someone else put there,
 * and the two cost opposite amounts to get wrong — an unreapable checkout is one skipped line in the
 * sweep's report, a wrongly reaped one is somebody's work. A caller with no branch to compare —
 * project teardown removes by recorded path alone — is unaffected.
 *
 * An unreadable listing erases that evidence, so for a checkout still ON DISK it fails CLOSED: the
 * lock is re-read from the admin directory, and one that can be neither proven nor ruled out is left
 * for a later pass rather than force-deleted. A path that is already gone has nothing to destroy, so
 * pruning and branch deletion still proceed — that is the moved/deleted-repo case the fallback below
 * exists to serve.
 */
async function removalBlocker(wt: Worktree): Promise<RemovalGuard> {
  const target = resolve(wt.path);
  const records = await listWorktrees(wt.repoPath).catch(() => null);
  if (records === null) {
    if (!existsSync(wt.path)) return {};
    const lock = await lockedInAdminDir(wt);
    if (lock === undefined) {
      return { blocker: "git's worktree list is unreadable, so another owner's lock cannot be ruled out" };
    }
    if (!lock.locked) return {};
    return judgeLock(lock.reason, "its lock file, read directly — git's worktree list was unreadable");
  }
  const record = records.find((r) => resolve(r.path) === target);
  if (record?.locked) return judgeLock(record.lockReason);
  if (wt.branch && record && record.branch !== wt.branch) {
    const holder = record.branch ? record.branch : "a detached checkout";
    return { blocker: `git registers ${holder} at that checkout now, not ${wt.branch}` };
  }
  return {};
}

/**
 * Remove the worktree (force, so dirty state is discarded) and prune. If `deleteBranch` is set,
 * also delete the branch. Safe to call when the worktree is already gone (idempotent), and a no-op
 * that REPORTS itself when the checkout is locked by another owner — including another anton process
 * holding a claim on it — or the path has since been registered to a different branch (see
 * {@link removalBlocker}).
 */
export async function removeWorktree(
  wt: Worktree,
  opts?: { deleteBranch?: boolean },
): Promise<WorktreeRemoval> {
  const guard = await removalBlocker(wt);
  if (guard.blocker) return { removed: false, skipped: guard.blocker, branchDeleted: false };

  const existed = existsSync(wt.path);
  // Read BEFORE removal — the worktree's own config (including any includeIf onbranch:
  // conditional, which is why this isn't just `git -C repoPath`) is only queryable while the
  // checkout still exists. `null` genuinely means "nothing to clean up", not "read failed", so a
  // read error here just skips the cleanup below rather than risking a wrong removal.
  const hooksPathBeforeRemoval = existed
    ? await readNormalizedHooksPath(wt.path).catch(() => null)
    : null;
  if (existed) {
    // A crashed anton's claim lock still sits on the checkout, and `git worktree remove --force`
    // refuses a locked worktree — break the dead claim rather than leaking the checkout forever.
    if (guard.staleClaimLock) await unlockWorktree(wt.repoPath, wt.path);
    try {
      await git(wt.repoPath, ["worktree", "remove", "--force", wt.path]);
    } catch {
      // git refuses a checkout another owner locked in exactly the same way it fails on a moved repo,
      // and a lock taken after the pre-check above lands here. Re-read it before the fallback: the
      // recursive delete is for a STALE registration, never for a checkout someone just claimed —
      // that owner's uncommitted work is precisely what the lock says must not be destroyed.
      const raced = await removalBlocker(wt);
      if (raced.blocker) return { removed: false, skipped: raced.blocker, branchDeleted: false };
      if (raced.staleClaimLock) {
        // A dead claim's lock appearing only now is the one refusal a retry can clear.
        await unlockWorktree(wt.repoPath, wt.path);
        try {
          await git(wt.repoPath, ["worktree", "remove", "--force", wt.path]);
        } catch {
          // Still refused — fall through to the orphan check, which proves ownership before deleting.
        }
      }
      // The main repository may have been moved or partially deleted before anton is asked to
      // forget it. In that case git cannot remove the worktree, but the checkout is still ours if
      // its .git file points into this repo's worktree administration directory. Remove only that
      // narrowly verified orphan; never recursively delete an arbitrary path from a database row.
      if (existsSync(wt.path)) {
        try {
          const gitFile = await readFile(join(wt.path, ".git"), "utf8");
          const adminRoot = resolve(wt.repoPath, ".git", "worktrees") + sep;
          const gitDir = gitFile.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
          if (gitDir && resolve(wt.path, gitDir.trim()).startsWith(adminRoot)) {
            await rm(wt.path, { recursive: true, force: true });
          }
        } catch {
          // Missing/unreadable marker means ownership cannot be proven; leave it for residue
          // verification to report instead of risking user data.
        }
      }
    }
  }

  try {
    await git(wt.repoPath, ["worktree", "prune"]);
  } catch {
    // best-effort
  }

  let branchDeleted = false;
  let branchSkipped: string | undefined;
  if (opts?.deleteBranch) {
    try {
      await git(wt.repoPath, ["branch", "-D", wt.branch]);
      branchDeleted = true;
    } catch (err) {
      // A failure is not proof of absence. The branch may still be checked out somewhere git won't
      // delete it from under, or held by a ref lock — and it then stays a candidate on every later
      // sweep, so only git's own answer may decide whether the log says "gone" or "refused".
      if (await branchExists(wt.repoPath, wt.branch)) branchSkipped = gitError(err);
    }
  }
  const removed = existed && !existsSync(wt.path);
  if (removed && hooksPathBeforeRemoval !== null) {
    await unexcludeHooksPathIfUnused(wt.repoPath, wt.path, hooksPathBeforeRemoval);
  }
  return { removed, branchDeleted, branchSkipped };
}
