/**
 * Git worktree manager (anton-dzh.2). Each autonomous run executes in an isolated worktree +
 * branch off the project's default branch; the worktree is removed when the run ends. See
 * DESIGN.md §4/§7. This module is the ONLY place anton runs `git worktree`.
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 * The job runner + execute-epic job depend on exactly these exports.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { extraBinDirs, findOnPath, isExecutableFile } from "../bin";
import {
  branchContainsCommit,
  hasCommonHistory,
  isAncestor,
  needsHooksPathOverrideForMerge,
  resolveHooksPathOverrideForMerge,
} from "./ops";

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
  /** The commit the checkout forked from, captured at creation — see {@link readForkAtCreation}. */
  forkSha?: string;
  /** Whether this call created the branch under its branch lock, rather than reusing it. */
  createdBranch: boolean;
  /** The main repo the worktree belongs to. */
  repoPath: string;
  /**
   * What {@link refreshOntoBase} did to a REUSED checkout, when `refresh: true` was passed
   * (anton-s55u) — undefined for a freshly-created checkout (nothing to refresh) or when the caller
   * didn't opt in. Callers that need this queryable later than the process's own stdout (a resumed
   * run's staleness, hours on) persist it onto their own record — see execute-epic-claim.ts.
   */
  refreshOutcome?: RefreshOutcome;
}

/** The shapes {@link refreshOntoBase} can leave a reused checkout in. */
export interface RefreshOutcome {
  outcome: "noop" | "fast_forwarded" | "rebased" | "merged" | "skipped_dirty";
  /**
   * The base commit the checkout was (or already was) brought up to — or, for `skipped_dirty`, the
   * fresh base it was NOT brought up to, so a human reading the row can see how far behind it sat.
   */
  baseSha: string;
}

/**
 * Run a git command in `repoPath`, returning trimmed stdout. `hooksPath`, when given, is passed as
 * `-c core.hooksPath=<value>` — see {@link refreshOntoBase}'s use of it for why a reset/rebase onto
 * a fresh base needs the same override review-fix's premerge already resolves for its own merges.
 */
async function git(repoPath: string, args: string[], hooksPath?: string): Promise<string> {
  const configArgs = hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
  const { stdout } = await execFileAsync("git", [...configArgs, "-C", repoPath, ...args], {
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
/**
 * The claim-under-lock step of {@link acquireWorktreeClaim}, pulled out to a named function so the
 * lock callback itself carries no nesting of its own.
 */
async function claimBranchUnderLock(
  repoPath: string,
  branch: string,
  owner: string,
  key: string,
): Promise<void> {
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
}

export async function acquireWorktreeClaim(
  repoPath: string,
  branch: string,
  owner: string,
): Promise<void> {
  const key = branchKey(repoPath, branch);
  await withBranchLock(repoPath, branch, () => claimBranchUnderLock(repoPath, branch, owner, key));
}

/**
 * Give back a claim taken by {@link acquireWorktreeClaim}. Idempotent — a holder that releases on
 * its teardown path AND in a `finally` must not pay a second, spurious unlock — and taken under the
 * branch lock, so the git lock is lifted and the map cleared as one step no teardown can read
 * halfway through.
 */
/** The claim-under-lock step of {@link releaseWorktreeClaim}, named for the same reason as its peer. */
async function releaseClaimIfHeld(repoPath: string, branch: string, key: string, owner: string): Promise<void> {
  if (!worktreeClaims.get(key)?.includes(owner)) return; // never held, or already given back
  if (dropClaim(key, owner)) await releaseClaimLock(repoPath, branch);
}

export async function releaseWorktreeClaim(
  repoPath: string,
  branch: string,
  owner: string,
): Promise<void> {
  const key = branchKey(repoPath, branch);
  await withBranchLock(repoPath, branch, () => releaseClaimIfHeld(repoPath, branch, key, owner));
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
 *
 * What {@link lockClaimedWorktree} must do about a checkout's current lock state, named per case.
 */
type ClaimLockAction =
  | { kind: "not-materialized" }
  | { kind: "already-ours" }
  | { kind: "refused"; reason: string }
  | { kind: "install"; record: WorktreeRecord; breakStaleFirst: boolean };

/**
 * Read `record`'s lock and decide what {@link lockClaimedWorktree} owes it: nothing (not materialized,
 * or this process's own live claim already says what we want said), a refusal (another anton's live
 * claim, or another tool's lock — never ours to break or write over), or an install (unlocked, or a
 * dead claim's leftovers to break first).
 */
/** {@link decideClaimLockAction}'s case when a record exists and IS locked. */
function judgeExistingClaimLock(record: WorktreeRecord, owner: string): ClaimLockAction {
  const live = liveClaimLock(record.lockReason);
  if (live && isThisProcess(live)) return { kind: "already-ours" };
  if (live) {
    return { kind: "refused", reason: `cannot claim ${record.path} for ${owner}: ${describeClaimLock(live)}` };
  }
  if (!parseClaimLock(record.lockReason)) {
    return {
      kind: "refused",
      reason:
        `cannot claim ${record.path} for ${owner}: it is locked by another owner ` +
        `(${record.lockReason || "no reason given"})`,
    };
  }
  return { kind: "install", record, breakStaleFirst: true }; // a dead claim's leftovers
}

function decideClaimLockAction(record: WorktreeRecord | undefined, owner: string): ClaimLockAction {
  if (!record) return { kind: "not-materialized" }; // createWorktree locks it when it is
  if (!record.locked) return { kind: "install", record, breakStaleFirst: false };
  return judgeExistingClaimLock(record, owner);
}

/** {@link lockClaimedWorktree}'s "install" case: break a stale claim first when there is one, then lock. */
async function installClaimLock(
  repoPath: string,
  owner: string,
  action: Extract<ClaimLockAction, { kind: "install" }>,
): Promise<void> {
  if (action.breakStaleFirst) await unlockWorktree(repoPath, action.record.path);
  try {
    await git(repoPath, ["worktree", "lock", "--reason", claimLockReason(owner), action.record.path]);
  } catch (err) {
    throw new Error(
      `[worktree] could not lock ${action.record.path} for ${owner}'s claim, so a second anton process ` +
        `could not see it and might remove the checkout: ${gitError(err)}`,
    );
  }
}

async function lockClaimedWorktree(repoPath: string, branch: string, owner: string): Promise<void> {
  const record = (await listWorktrees(repoPath)).find((r) => !r.isMain && r.branch === branch);
  const action = decideClaimLockAction(record, owner);
  if (action.kind === "not-materialized" || action.kind === "already-ours") return;
  if (action.kind === "refused") throw new Error(`[worktree] ${action.reason}`);
  await installClaimLock(repoPath, owner, action);
}

/** How hard a released claim tries to come off before an operator has to be told about it. */
const CLAIM_RELEASE_ATTEMPTS = 3;
const CLAIM_RELEASE_BACKOFF_MS = 100;

/** The locked record for `branch`, but only when ITS lock is this process's own claim. */
async function findOwnClaimRecord(repoPath: string, branch: string): Promise<WorktreeRecord | undefined> {
  const record = (await listWorktrees(repoPath)).find((r) => !r.isMain && r.branch === branch && r.locked);
  const claim = parseClaimLock(record?.lockReason);
  return claim && isThisProcess(claim) ? record : undefined;
}

/** One attempt at {@link releaseClaimLock}: still ours to unlock, or nothing to do. Undefined ⇒ ok. */
async function tryReleaseClaimLock(repoPath: string, branch: string): Promise<unknown> {
  try {
    const record = await findOwnClaimRecord(repoPath, branch);
    if (record) await git(repoPath, ["worktree", "unlock", record.path]);
    return undefined;
  } catch (err) {
    return err;
  }
}

/** The operator-facing account of a release {@link releaseClaimLock} could never prove. */
function reportClaimReleaseFailure(repoPath: string, branch: string, error: unknown): void {
  console.error(
    `[worktree] could not release this process's claim on ${branch} after ${CLAIM_RELEASE_ATTEMPTS} ` +
      `attempts, so every reaper pass will keep reading it as in use — clear it with ` +
      `\`git -C ${repoPath} worktree unlock ${worktreePathFor(repoPath, branch)}\`: ${gitError(error)}`,
  );
}

/**
 * Lift only THIS process's own claim lock: another anton may since have taken the checkout over.
 *
 * Retried, because the lock names a pid that is still running: a transient `git` failure here leaves
 * every later reaper pass — in this process and every other — reading the leftovers as a live claim,
 * leaking the worktree and its branch until anton restarts. A release that still cannot be proven is
 * reported loudly with the command that clears it by hand, never swallowed.
 */
async function releaseClaimLock(repoPath: string, branch: string, attempt = 1): Promise<void> {
  const error = await tryReleaseClaimLock(repoPath, branch);
  if (!error) return;
  if (attempt >= CLAIM_RELEASE_ATTEMPTS) return reportClaimReleaseFailure(repoPath, branch, error);
  await new Promise((r) => setTimeout(r, CLAIM_RELEASE_BACKOFF_MS * attempt));
  return releaseClaimLock(repoPath, branch, attempt + 1);
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
/** Whether `claim` names this very process — the one live claim a caller may treat as its own. */
function isThisProcess(claim: ClaimLock): boolean {
  return claim.pid === process.pid && claim.host === hostname();
}

/** A holder other than the caller itself, named for the refusal message. */
function otherHolder(holders: string[], caller: string | undefined): string | undefined {
  const other = holders.find((h) => h !== caller);
  return other ? `${other} is using the checkout` : undefined;
}

/** A live claim lock belonging to a DIFFERENT process — this process's own lock is never a conflict. */
function otherLiveLock(record: WorktreeRecord | undefined): string | undefined {
  if (!record?.locked) return undefined;
  const live = liveClaimLock(record.lockReason);
  return live && !isThisProcess(live) ? describeClaimLock(live) : undefined;
}

function conflictingClaim(
  holders: string[],
  record: WorktreeRecord | undefined,
  caller: string | undefined,
): string | undefined {
  return otherHolder(holders, caller) ?? otherLiveLock(record);
}

/**
 * Create (or reuse) an isolated worktree + branch off `baseBranch` (default: the repo's current
 * HEAD branch). Idempotent: if a worktree for `branch` already exists it is returned as-is
 * (supports crash recovery / resumable runs) — or, with `refresh: true` (anton-s55u), brought up to
 * `baseBranch` first (see {@link refreshOntoBase}) rather than handed back holding whatever base it
 * happened to be cut from, which a resumed run would otherwise silently implement, test, and
 * self-review against. `warm: true` runs project setup (deps install — see
 * {@link resolveWarmCommand}), and is a no-op when nothing is needed.
 *
 * Reuse is refused while ANOTHER job holds the checkout (see {@link withWorktreeClaim}). Handing
 * the same directory to two jobs is worse than failing the second: review-fix and an execute run
 * would drive git, claude, tests and commits over one working tree, interleaving each other's
 * edits. The claim holder itself says so with `claimedBy` — it materializes its own checkout under
 * its claim, and refusing that would deadlock the very job the claim is for.
 */
/**
 * The commit a freshly-created checkout forked from, resolved before any slow step can rewind the
 * base ref (PR #238 review). {@link createWorktree} branches off `baseBranch` — a mutable
 * remote-tracking ref such as `origin/main` — inside a lock that holds minutes, and the warm that
 * follows runs minutes more. Reading the fork point from inside that window (or after it) against
 * the still-mutable ref lets a sibling run's fetch rewind it behind the commit this branch was
 * actually cut from. So `createWorktree` records the fork by reading the new checkout's own HEAD —
 * the commit the branch was literally created at — and returns it; the caller pins HEAD here instead
 * of re-deriving later.
 */
async function readForkAtCreation(worktreePath: string): Promise<string> {
  return git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

/**
 * Every path `git status --porcelain` reports as dirty, tracked or not. Deliberately NOT routed
 * through {@link git}: its whole-output `.trim()` eats the leading status-code space of the FIRST
 * line only (e.g. " M README.md" → "M README.md"), shifting the fixed 3-character offset below and
 * truncating that one path's first letter — trailing newlines alone are safe to drop.
 */
async function dirtyPaths(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .replace(/\n+$/, "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

/**
 * Whether `worktreePath` has a rebase or merge left mid-flight by a process that died before its own
 * catch block could run `--abort` (a kill between the `git rebase`/`git merge` call above and the
 * `catch` that aborts it, or an anton process itself being killed there). `--path-format=absolute`
 * matters: plain `--git-path` prints relative to the CALLER's cwd, not `-C worktreePath` (the same
 * gotcha `worktree.test.ts` already works around for `info/exclude`), so a relative read here would
 * resolve against the wrong directory entirely.
 */
async function unfinishedGitOperation(worktreePath: string): Promise<"rebase" | "merge" | undefined> {
  const [rebaseMerge, rebaseApply, mergeHead] = await Promise.all(
    ["rebase-merge", "rebase-apply", "MERGE_HEAD"].map((gitPath) =>
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", gitPath]),
    ),
  );
  if (existsSync(rebaseMerge) || existsSync(rebaseApply)) return "rebase";
  if (existsSync(mergeHead)) return "merge";
  return undefined;
}

/**
 * Where {@link refreshOntoBase} records that IT — not an agent working in this checkout — started
 * the rebase/merge currently in progress (PR #279 review, P1). A parked agent can leave its own
 * conflicted merge or rebase mid-resolution on purpose (it resolves some conflicts, then hits a
 * usage limit); on disk that is indistinguishable from a refresh interrupted mid-operation, since
 * both leave the same `rebase-merge`/`rebase-apply`/`MERGE_HEAD` state. Written immediately before
 * the merge/rebase call that can leave conflicts, and removed once that call resolves (cleanly or
 * via its own `--abort`) — present only for the window where it would actually be this function's
 * operation left unfinished. `--path-format=absolute --git-path` for the same reason
 * {@link unfinishedGitOperation} needs it: scoped to THIS worktree's private git-dir, not the
 * caller's cwd.
 */
async function refreshMarkerPath(worktreePath: string): Promise<string> {
  return git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "ANTON_REFRESH_IN_PROGRESS"]);
}

/**
 * Bring a REUSED checkout's branch up to `baseBranch` before anything is dispatched against it
 * (anton-s55u). Without this, a worktree/branch picked back up from a parked or failed run keeps
 * whatever base it was cut from — a resumed run can silently implement, test, and self-review
 * against a tree many commits behind main.
 *
 * Outcomes, in order of how much the checkout may safely move:
 * - An unfinished rebase or merge from a process that died mid-operation (before its own catch
 *   could abort it): `--path-format=absolute --git-path rebase-merge`/`rebase-apply`/`MERGE_HEAD`
 *   still exist on disk. `status --porcelain` alone can't tell this apart from ordinary parked
 *   edits — a conflicted rebase reports its conflict paths the same way a dirty tree does — but HEAD
 *   is DETACHED here while `branch` still points at its pre-rebase tip, so dispatching into it would
 *   let an agent commit onto detached history while the PR step pushes the unchanged named branch,
 *   silently losing every commit the resumed session makes. Aborted (restoring `branch` and its
 *   working tree to the pre-refresh state, the same recovery `git rebase -h` names as the control
 *   for this exact state) and failed loud — never dispatched into.
 * - Already at `baseBranch`: no-op.
 * - No unique commits (the branch is an ancestor of the fresh base, or equal to it): fast-forwarded
 *   with `reset --hard` — nothing of the run's is on this branch yet, so there's nothing to lose.
 * - Unique commits, none of them pushed to `origin/<branch>` yet: rebased onto the base so they land
 *   on top of the fresh tree.
 * - Unique commits that ARE already on `origin/<branch>` (this checkout's own tip matches its remote-
 *   tracking ref): MERGED instead of rebased. A prior attempt can push the branch via
 *   `openPullRequest`'s `pushBranch` and then fail before `gh pr create` completes — a case the
 *   run's retry path explicitly resumes from — so by the time this refresh runs again, those commits
 *   are already public. Rebasing them here would rewrite that published history, and the later
 *   retry's own `pushBranch` runs a plain, deliberately non-forcing `git push -u origin <branch>`
 *   that then rejects the rewritten branch as non-fast-forward on every subsequent attempt (PR #279
 *   review). Merging preserves what's already pushed while still bringing the checkout current.
 * - A rebase or merge that cannot apply cleanly is ABORTED, never forced — the run fails loud naming
 *   the divergence rather than discarding work or leaving the checkout mid-operation.
 * - Dirty (anything `git status --porcelain` reports, tracked or not): SKIPPED, never touched.
 *   Resetting, rebasing, or merging over uncommitted state would discard it, but a dirty reused
 *   checkout is exactly what a run parked on a usage limit or a `needs-human` ask leaves behind on
 *   purpose (execute-epic-ticket-settle.ts keeps it precisely so the resume can continue from it) —
 *   refusing the refresh outright would strand that resume forever, since every later attempt reuses
 *   the same worktree and hits the same dirty tree (PR #279 review). So the checkout dispatches
 *   against whatever base it already has instead; only a CLEAN reused checkout is worth the trip
 *   forward. Still preserved, but NOT dispatched, when a pinned `forkSha` shows the resolved base
 *   diverged from it (a force-push or recreation behind the checkout's own fork point) — continuing
 *   would let those parked edits get committed onto stale history and, once pushed, silently
 *   reintroduce whatever the rewrite dropped (PR #279 review, P1).
 *
 * `baseBranch` is resolved to `baseSha` ONCE, up front, and every ancestry check, rebase/merge
 * target, and diagnostic log below uses that pinned sha rather than rereading the mutable branch
 * name — a concurrent run's fetch can advance `origin/<baseBranch>` between this resolution and the
 * git calls that act on it, and rereading the ref name would then act on a base that moved out from
 * under the sha this function returns and its caller persists (PR #279 review).
 */
async function refreshOntoBase(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /**
   * Commits a bead's satisfied-note already cites as evidence (anton-8h4b) — e.g. `formatSatisfiedNote`'s
   * `by.commit`, resolved by the caller from this run's tickets. A rebase would rewrite any of these
   * still on the branch to a new sha, leaving that board record pointing at an object the branch no
   * longer carries (PR #279 review) — so if one is present, this refresh merges instead, the same
   * accommodation already made for a commit that's been pushed to origin.
   */
  preserveShas?: string[];
  /**
   * The commit `branch` was ORIGINALLY cut from — the caller's pinned `baseForkSha`, when one is
   * already on record for it (PR #279 review). A plain `git rebase <base>` replays everything after
   * `merge-base(base, branch)`, not everything after the branch's own fork point; once `baseBranch`
   * has been force-pushed or recreated past an older shared ancestor, that merge-base lands BEFORE
   * the real fork and the plain form resurrects commits that were part of the ORIGINAL base — never
   * touched by this run — as if they were the branch's own work. Passed, it becomes `--onto`'s
   * upstream boundary instead, so only what's actually unique to `branch` gets replayed.
   */
  forkSha?: string;
  /**
   * Whether `baseBranch` resolved from a CONFIRMED fetch of `origin/<baseBranch>` (anton-nyz1v, PR
   * #279 review, fifth round) — `resolveFreshBase`'s success path, as opposed to its best-effort
   * fallback to the plain local branch name when the fetch failed or there was no remote. The two
   * shapes below that leave a checkout untouched when `baseSha` sits BEHIND `branch`'s own fork point
   * are safe ONLY for that fallback: there, `baseSha` being behind the fork just means this repo's
   * last successful fetch predates a NEWER commit `branch` already forked from, and origin genuinely
   * still has both — nothing to reconcile. A CONFIRMED fetch landing behind the fork means the
   * opposite: origin's tip was force-pushed or recreated BACKWARD past that commit, so it's the fork
   * point that's now stale, not this reading of origin — `baseSha` is the authoritative truth, and
   * leaving `branch` untouched would let its eventual PR silently reintroduce whatever origin's
   * rewind just dropped. Defaults to `false` (the conservative, no-op-preferring reading) so a caller
   * that never resolves this stays exactly as safe as before this parameter existed.
   */
  baseIsAuthoritative?: boolean;
}): Promise<RefreshOutcome> {
  const { repoPath, worktreePath, branch, baseBranch, preserveShas, forkSha, baseIsAuthoritative } = opts;

  let baseSha: string;
  try {
    baseSha = await git(repoPath, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
  } catch (err) {
    throw new Error(
      `[worktree] could not resolve base ${baseBranch} to refresh ${branch}: ${gitError(err)}`,
    );
  }
  // Resolved up front (not just in the clean path below) so the dirty-tree escape can run the same
  // divergence check on it (PR #279 review, P1).
  const branchSha = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);

  const markerPath = await refreshMarkerPath(worktreePath);

  // Checked BEFORE the dirty-tree escape below: an interrupted rebase/merge reports its conflict
  // paths through `status --porcelain` exactly like ordinary parked edits, so without this check
  // that escape would read it as "leave it alone" and dispatch straight into a checkout with HEAD
  // detached mid-operation and `branch` still at its stale pre-refresh tip.
  const unfinished = await unfinishedGitOperation(worktreePath);
  if (unfinished) {
    // Only abort an operation THIS function started (the marker, written right before its own
    // merge/rebase call below) — never one an agent left mid-resolution on purpose (PR #279 review,
    // P1). `git merge -h`/`git rebase -h` name `--abort` as the recovery for an interrupted refresh,
    // but the same on-disk state is exactly what a parked agent's own conflicted merge or rebase
    // leaves behind deliberately, and aborting THAT would discard partial resolution work parking
    // exists to preserve.
    if (!existsSync(markerPath)) {
      throw new Error(
        `[worktree] ${worktreePath} has an unfinished git ${unfinished} in progress on ${branch} that ` +
          `this refresh did not start — it may be an agent's own conflict resolution left mid-flight on ` +
          `purpose. Refusing to abort it and discard that work. Inspect ${worktreePath} and resume the ` +
          `run once it is confirmed clean, or the conflict is resolved.`,
      );
    }
    // The marker is removed only once the abort actually succeeds (PR #279 re-review, P2): a failed
    // `--abort` (e.g. a transient index lock) leaves the operation genuinely in progress, and
    // deleting the marker anyway would make the NEXT resume misread it as an agent's own deliberate
    // conflict — refusing to touch it — while this attempt falsely reports having cleared it.
    try {
      await git(worktreePath, [unfinished, "--abort"]);
    } catch (err) {
      throw new Error(
        `[worktree] ${worktreePath} had an unfinished git ${unfinished} in progress on ${branch} and ` +
          `the recovery abort failed (${gitError(err)}) — leaving the ownership marker in place so a ` +
          `later resume still treats this as its own interrupted operation rather than an agent's. ` +
          `Inspect ${worktreePath} and resolve the ${unfinished} manually, then resume the run.`,
      );
    }
    await rm(markerPath, { force: true }).catch(() => undefined);
    throw new Error(
      `[worktree] ${worktreePath} had an unfinished git ${unfinished} in progress on ${branch} — a ` +
        `prior process likely died before it could abort its own ${unfinished === "rebase" ? "rebase" : "merge"} ` +
        `onto ${baseBranch}. Aborted it to restore ${branch} and its working tree to their pre-refresh ` +
        `state. Inspect ${worktreePath} and resume the run once it is confirmed clean.`,
    );
  }
  // No unfinished operation — any marker left here is stale (an operation the marker recorded that
  // has since concluded some other way, e.g. a resume that found the checkout already clean).
  await rm(markerPath, { force: true }).catch(() => undefined);

  const dirty = await dirtyPaths(worktreePath);
  if (dirty.length > 0) {
    // Preserve the edits, but don't dispatch against them blind (PR #279 review, P1): this escape
    // sits BEFORE the fork-descendancy checks the clean path runs below, so without a guard here it
    // would skip straight past a base that was force-pushed or recreated behind the checkout's real
    // fork point — the parked edits get committed atop stale history, and the eventual PR against
    // the rewritten base silently reintroduces whatever commit(s) that rewrite dropped. With a pin
    // that's still reachable on `branch`, the check is precise (only trips when `baseSha` is neither
    // a descendant of `forkSha`, the ordinary safe case, nor an ancestor of it, the merely-stale-base
    // case); without one, a two-way divergence fails closed on the coarser check below instead of
    // guessing (PR #279 review, P1 re-review).
    const trustedForkSha =
      forkSha && (await branchContainsCommit(repoPath, branch, forkSha)) ? forkSha : undefined;
    if (trustedForkSha) {
      // Safe to leave untouched when the fork point descends from `baseSha` (the ordinary case), OR
      // when `baseSha` descends from the fork point but that reading is only a stale LOCAL fallback
      // (anton-nyz1v, PR #279 review, fifth round) — never when it's a CONFIRMED fetch, which makes
      // `baseSha` authoritative and a `baseSha` behind the fork point a genuine rewind, not staleness
      // (see `baseIsAuthoritative`'s own doc comment).
      const forkDescendsFromBase = await isAncestor(worktreePath, trustedForkSha, baseSha);
      const baseIsMerelyStaleFallback =
        !baseIsAuthoritative && (await isAncestor(worktreePath, baseSha, trustedForkSha));
      if (!forkDescendsFromBase && !baseIsMerelyStaleFallback) {
        throw new Error(
          `[worktree] ${worktreePath} has uncommitted changes (${dirty.join(", ")}) and ${baseBranch} ` +
            `(${baseSha.slice(0, 12)}) no longer descends from ${branch}'s fork point ${trustedForkSha.slice(0, 12)} — ` +
            `${baseBranch} looks like it was force-pushed or recreated behind that commit. Committing and ` +
            `dispatching against the checkout's stale history would silently reintroduce whatever ` +
            `${baseBranch} dropped once those commits are pushed. Leaving the uncommitted changes in ` +
            `${worktreePath} untouched — resolve manually and retry.`,
        );
      }
    } else if (
      // No trustworthy pin at all (a legacy reused checkout, or a stale one) — PR #279 review (P1,
      // re-review). That can't be told apart from the force-push-behind-fork shape above without the
      // pin, so a genuine two-way divergence (neither ref is an ancestor of the other) must fail
      // closed here too, the same way the clean path's `trustedForkSha` guard below refuses a plain
      // rebase without one. An ordinary one-way advance (`branchSha` still an ancestor of `baseSha`,
      // or vice versa) is unaffected — nothing could have been dropped either way.
      !(await isAncestor(worktreePath, branchSha, baseSha)) &&
      !(await isAncestor(worktreePath, baseSha, branchSha))
    ) {
      throw new Error(
        `[worktree] ${worktreePath} has uncommitted changes (${dirty.join(", ")}) and ${branch} ` +
          `diverges from ${baseBranch} (${baseSha.slice(0, 12)}) with no trustworthy fork-point pin — ` +
          `committing and dispatching against the checkout's stale history could silently reintroduce ` +
          `commits ${baseBranch} dropped if it was force-pushed or recreated past ${branch}'s real fork ` +
          `point. Leaving the uncommitted changes in ${worktreePath} untouched — resolve manually and retry.`,
      );
    }
    console.log(
      `[worktree] skipping refresh of ${branch} onto ${baseBranch}: ${worktreePath} has uncommitted ` +
        `changes (${dirty.join(", ")}) — dispatching against its existing base instead of discarding them`,
    );
    return { outcome: "skipped_dirty", baseSha };
  }

  if (baseSha === branchSha) return { outcome: "noop", baseSha }; // already current

  // Resolved once against the pinned `baseSha` (not `baseBranch`) so the reset/rebase/merge below
  // fire the SAME `post-checkout`/`pre-rebase`/`post-merge` hook this base's tree actually carries —
  // the identical reasoning review-fix's premerge already applies to its own fast-forward and
  // conflict-resolution merges (needsHooksPathOverrideForMerge's own doc comment).
  const hooksPath = (await needsHooksPathOverrideForMerge(repoPath, worktreePath, baseSha))
    ? await resolveHooksPathOverrideForMerge(repoPath, worktreePath, baseSha)
    : undefined;

  if (await isAncestor(worktreePath, branch, baseSha)) {
    // The branch carries nothing the base doesn't already have — safe to fast-forward in place.
    // `merge --ff-only` rather than `reset --hard`: the latter moves HEAD/index/worktree without
    // firing `post-merge` or `post-checkout`, so repos relying on those hooks for generated state
    // would resume stale after a fast-forward (PR #279 review).
    await git(worktreePath, ["merge", "--ff-only", baseSha], hooksPath);
    console.log(
      `[worktree] fast-forwarded ${branch} to ${baseBranch} (${baseSha.slice(0, 12)}) — no unique commits`,
    );
    return { outcome: "fast_forwarded", baseSha };
  }

  // A checkout's own remote-tracking ref only moves when THIS repo pushes `branch` itself (a claim
  // holds the checkout for the run's whole lifetime, so no other worker pushes it meanwhile) — if
  // its tip is still reachable from this branch's tip, those commits are public and rebasing would
  // rewrite them. Ancestry, not equality: a retry can merge a newer base into an already-pushed
  // branch and then fail before pushing that merge, leaving `origin/<branch>` an ancestor of the
  // local tip rather than equal to it (PR #279 review) — exact equality would misclassify that as
  // unpublished, rebase it, and turn the later non-forcing `pushBranch` into a rejected non-fast-
  // forward push.
  const remoteSha = await git(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
  ).catch(() => undefined);
  const remotelyPublished =
    remoteSha !== undefined && (await isAncestor(worktreePath, remoteSha, branchSha));

  // A commit already cited as evidence on a bead (a satisfied-note's `by.commit`) is just as
  // unsafe to rewrite as a pushed one — the board's record of it would otherwise survive the
  // rebase while the object it names doesn't (PR #279 review).
  let preservedSha: string | undefined;
  if (!remotelyPublished && preserveShas && preserveShas.length > 0) {
    for (const sha of preserveShas) {
      if (await branchContainsCommit(repoPath, branch, sha)) {
        preservedSha = sha;
        break;
      }
    }
  }

  // Checked BEFORE either the merge or the rebase path below, not just the rebase one: git refuses
  // both `merge` and `rebase` onto a base with no common ancestor, but its `merge` refusal ("refusing
  // to merge unrelated histories") would otherwise surface first for a branch that's published or
  // cited on a bead, landing in the merge path's own catch block and misattributing the failure to a
  // content conflict rather than the unrelated-history cause named here (PR #279 review). Checking
  // once, up front, gives both paths the same accurate diagnostic — and still protects the rebase
  // path from git's own permissiveness there: `rebase <base>` accepts an unrelated base by replaying
  // the branch's ENTIRE history, root commit included, on top of a tree that has nothing to do with
  // it, rather than rejecting it. That's exactly what a force-pushed or recreated `origin/<baseBranch>`
  // looks like from here.
  if (!(await hasCommonHistory(worktreePath, branch, baseSha))) {
    throw new Error(
      `[worktree] ${branch} and ${baseBranch} (${baseSha.slice(0, 12)}) share no common history — ` +
        `refusing to merge or rebase onto an unrelated base (this can happen when ${baseBranch} was ` +
        `force-pushed or recreated). Resolve manually in ${worktreePath} and retry.`,
    );
  }

  // `baseSha` itself can be STALE rather than moved (PR #279 review): `resolveFreshBase`'s caller
  // falls back to the LOCAL `<base>` branch when its fetch fails, and that local ref can already sit
  // BEHIND the commit this checkout's own branch was forked from by an earlier, successful fetch — a
  // clean branch cut from `A-B` while local `main` still sits at `A`. That is a different shape from
  // the force-push-behind-fork case the guard below exists for: there, `baseSha` shares no straight
  // line back to `forkSha` at all (it was rewritten PAST it); here, `baseSha` (`A`) IS an ancestor of
  // `forkSha` (`B`) — genuinely older, not rewritten, and leaving `branch` untouched is always safe
  // regardless of whether it's published or cited on a bead: nothing needs to move. Checked BEFORE
  // that guard, not folded into its `remotelyPublished || preservedSha` gate (PR #279 review) — a
  // published or preserved branch reaching this same stale-base shape must ALSO fall through to this
  // no-op rather than trip the force-push guard below, which only demands `!isAncestor(forkSha,
  // baseSha)` and is true for the stale case too (an older `baseSha` is no more an ancestor of
  // `forkSha` than a rewritten one is). Checking this first, unconditionally, lets both the
  // published/preserved and the ordinary path share the same safe answer for a merely-stale base.
  //
  // Gated on `!baseIsAuthoritative` (anton-nyz1v, PR #279 review, fifth round): the shape above —
  // `baseSha` behind `forkSha` — is genuinely ambiguous on its own. A stale LOCAL fallback reads it
  // exactly like a CONFIRMED fetch of an `origin/<baseBranch>` that was force-pushed or recreated
  // backward past the fork point does: both leave `baseSha` an ancestor of `forkSha`. Only the former
  // is safe to no-op; the latter means origin authoritatively dropped `forkSha` (and everything after
  // it up to the old tip), and `branch` — cut from `forkSha` — still carries that dropped history as
  // its own ancestry. Leaving it untouched would let its eventual PR against the rewound `baseSha`
  // silently reintroduce exactly what the rewind was meant to drop. An authoritative rewind instead
  // falls through to the checks below, which rebase (or, for a published/preserved branch, refuse and
  // ask for manual resolution) using `baseSha` as the real, current truth.
  if (
    !baseIsAuthoritative &&
    forkSha &&
    (await branchContainsCommit(repoPath, branch, forkSha)) &&
    (await isAncestor(worktreePath, baseSha, forkSha))
  ) {
    console.log(
      `[worktree] resolved base for ${branch} (${baseSha.slice(0, 12)}) is behind its own fork ` +
        `point ${forkSha.slice(0, 12)} — leaving ${branch} where it is instead of rebasing backward`,
    );
    return { outcome: "noop", baseSha: forkSha };
  }

  // `hasCommonHistory` above only demands SOME shared ancestor, not that `baseSha` still descends
  // from the branch's own pinned fork point — a base that was force-pushed BEHIND that fork but still
  // shares an OLDER ancestor with it passes that check regardless. The merge below is unsafe in
  // exactly that case: `branch` still carries the removed base-side commits as its own ancestry (it
  // forked from them), so merging a base that dropped them in a rewrite reaches right back through
  // `branch`'s side of the merge and reintroduces them into the result — e.g. a branch cut at `A-B`
  // merged into a base rewritten to `A-E` leaves `B` in `E..HEAD` (PR #279 review). `--onto` rebases
  // sidestep this by construction (see the `forkSha` doc above), so this guard only needs to cover the
  // merge path. Checked only when `forkSha` is both known and still reachable on `branch`: an unknown
  // or already-stale pin can't distinguish this case from an ordinary divergence, so it's left to the
  // merge/rebase paths' own conflict handling below. The stale-base shape is already ruled out by the
  // no-op above, so a `!isAncestor(forkSha, baseSha)` reaching here is always the genuine force-push-
  // past-fork case.
  if (
    (remotelyPublished || preservedSha) &&
    forkSha &&
    (await branchContainsCommit(repoPath, branch, forkSha)) &&
    !(await isAncestor(worktreePath, forkSha, baseSha))
  ) {
    throw new Error(
      `[worktree] ${baseBranch} (${baseSha.slice(0, 12)}) no longer descends from ${branch}'s fork ` +
        `point ${forkSha.slice(0, 12)} — ${baseBranch} looks like it was force-pushed or recreated ` +
        `behind that commit. Merging would still reach ${branch}'s own copy of whatever ${baseBranch} ` +
        `dropped, silently reintroducing it. Resolve manually in ${worktreePath} and retry.`,
    );
  }

  if (remotelyPublished || preservedSha) {
    // Written just before the call that can leave a conflicted merge in progress, so a later
    // resume's `unfinishedGitOperation` check can tell THIS merge apart from an agent's own
    // (see `refreshMarkerPath`'s doc comment).
    await writeFile(markerPath, "", "utf8").catch(() => undefined);
    try {
      await git(worktreePath, ["merge", "--no-edit", baseSha], hooksPath);
      await rm(markerPath, { force: true }).catch(() => undefined);
      console.log(
        `[worktree] merged ${baseBranch} (${baseSha.slice(0, 12)}) into ${branch} — ` +
          (remotelyPublished
            ? `its commits are already on origin, so rebasing would have rewritten published history`
            : `commit ${preservedSha!.slice(0, 12)} is already cited on a bead, so rebasing would ` +
                `have made that reference unreachable`),
      );
      return { outcome: "merged", baseSha };
    } catch (err) {
      // Marker removed only once the abort actually succeeds — same discipline as the
      // unfinished-operation recovery above: a failed `--abort` (e.g. a transient index lock)
      // leaves the merge genuinely in progress, and deleting the marker anyway would make the
      // NEXT resume misread it as an agent's own deliberate conflict rather than this one's (PR
      // #279 review, P2).
      try {
        await git(worktreePath, ["merge", "--abort"]);
      } catch (abortErr) {
        throw new Error(
          `[worktree] ${branch} diverges from ${baseBranch} and could not be merged onto it cleanly ` +
            `(${gitError(err)}), and the recovery \`git merge --abort\` also failed ` +
            `(${gitError(abortErr)}) — leaving the ownership marker in place so a later resume still ` +
            `treats this as its own interrupted merge. Inspect ${worktreePath} and resolve the merge ` +
            `manually, then resume the run.`,
        );
      }
      await rm(markerPath, { force: true }).catch(() => undefined);
      const unique = await git(worktreePath, ["log", "--oneline", `${baseSha}..${branch}`]).catch(
        () => "(could not list them)",
      );
      throw new Error(
        `[worktree] ${branch} diverges from ${baseBranch} and could not be merged onto it cleanly ` +
          `(refusing to rebase since its commits are already ` +
          `${remotelyPublished ? "published" : "cited on a bead"}) — refusing to discard or rewrite ` +
          `its commits. Unique commits:\n${unique}\nResolve the conflict in ${worktreePath} and ` +
          `retry (${gitError(err)})`,
      );
    }
  }

  // `--onto <baseSha> <forkSha> <branch>` transplants exactly `forkSha..branch` (branch's own
  // commits since it actually forked) onto `baseSha`, with no requirement that `baseSha` still
  // descend from `forkSha` — so it stays correct even for a `baseBranch` that was force-pushed or
  // recreated past the real fork point. A fork point that isn't actually on `branch` (a stale or
  // mismatched pin) is ignored, same as no pin at all.
  //
  // Without a trustworthy pin there is no safe fallback (PR #279 review, P1): the plain one-argument
  // `git rebase <base>` replays `merge-base(baseSha, branch)..branch` — the branch's own fork point
  // only while `baseBranch` still contains it. A legacy reused checkout with no recorded
  // `baseForkSha` reaches here with `forkSha` undefined; once `baseBranch` has been rewritten past
  // the branch's real fork point, that merge-base lands before it and the plain form would replay
  // ORIGINAL base commits alongside the branch's own work, silently resurrecting them into the
  // rebased branch. There is no way to tell that shape apart from an ordinary, unrewritten
  // divergence without the pin, so a divergent reused branch lacking one fails closed here instead
  // of guessing.
  const trustedForkSha =
    forkSha && (await branchContainsCommit(repoPath, branch, forkSha)) ? forkSha : undefined;
  if (!trustedForkSha) {
    throw new Error(
      `[worktree] ${branch} diverges from ${baseBranch} (${baseSha.slice(0, 12)}) and has no ` +
        `trustworthy fork-point pin to rebase --onto — a plain rebase could silently resurrect ` +
        `commits ${baseBranch} dropped if it was force-pushed or recreated past ${branch}'s real ` +
        `fork point. Resolve manually in ${worktreePath} and retry.`,
    );
  }
  // Plain `--onto` linearizes: it drops any merge commit in `forkSha..branch` and replays only its
  // first-parent line, silently discarding whatever a conflict-resolution-only merge recorded in its
  // tree even though the rebase itself reports success (PR #279 review, P1). `--rebase-merges`
  // recreates the merge topology instead — required whenever the range actually contains one.
  const hasMergeCommit =
    (
      await git(worktreePath, ["log", "--merges", "--oneline", `${trustedForkSha}..${branch}`])
    ).length > 0;
  const rebaseArgs = hasMergeCommit
    ? ["rebase", "--rebase-merges", "--onto", baseSha, trustedForkSha, branch]
    : ["rebase", "--onto", baseSha, trustedForkSha, branch];

  // Same marker discipline as the merge above: written right before the call that can leave a
  // conflicted rebase in progress, so a later resume can tell this rebase apart from an agent's own.
  await writeFile(markerPath, "", "utf8").catch(() => undefined);
  try {
    await git(worktreePath, rebaseArgs, hooksPath);
    await rm(markerPath, { force: true }).catch(() => undefined);
    console.log(`[worktree] rebased ${branch} onto ${baseBranch} (${baseSha.slice(0, 12)})`);
    return { outcome: "rebased", baseSha };
  } catch (err) {
    // Same abort-failure discipline as the merge path above: only clear the marker once `--abort`
    // actually succeeds, so a failed abort (e.g. a transient index lock) still leaves the rebase
    // recognizable as this function's own on the next resume (PR #279 review, P2).
    try {
      await git(worktreePath, ["rebase", "--abort"]);
    } catch (abortErr) {
      throw new Error(
        `[worktree] ${branch} diverges from ${baseBranch} and could not be rebased onto it cleanly ` +
          `(${gitError(err)}), and the recovery \`git rebase --abort\` also failed ` +
          `(${gitError(abortErr)}) — leaving the ownership marker in place so a later resume still ` +
          `treats this as its own interrupted rebase. Inspect ${worktreePath} and resolve the rebase ` +
          `manually, then resume the run.`,
      );
    }
    await rm(markerPath, { force: true }).catch(() => undefined);
    const unique = await git(worktreePath, ["log", "--oneline", `${baseSha}..${branch}`]).catch(
      () => "(could not list them)",
    );
    throw new Error(
      `[worktree] ${branch} diverges from ${baseBranch} and could not be rebased onto it cleanly — ` +
        `refusing to discard its commits. Unique commits:\n${unique}\nResolve the conflict in ` +
        `${worktreePath} and retry (${gitError(err)})`,
    );
  }
}

/**
 * What createWorktree may do about the branch before it materializes anything: who holds its claim
 * (if anyone), the checkout git already has registered for it (if any), and the base branch to
 * create or refresh it against — resolved here (not left to each caller) since a REUSED checkout
 * needs a real base to refresh onto, not just its own branch name (anton-s55u). Throws the same
 * refusal {@link createWorktree} always has when another job holds the checkout.
 */
async function resolveClaimForCreate(
  repoPath: string,
  branch: string,
  baseBranchOpt: string | undefined,
  claimedBy: string | undefined,
): Promise<{ claimed: string | undefined; existing: Worktree | null; baseBranch: string }> {
  // A claim can be held before the checkout exists (review-fix claims, then materializes), and the
  // git lock that makes it visible to another anton process can only be taken once it does.
  const holders = worktreeClaims.get(branchKey(repoPath, branch)) ?? [];
  const record = (await listWorktrees(repoPath)).find((r) => r.branch === branch);
  const conflict = conflictingClaim(holders, record, claimedBy);
  if (conflict) {
    throw new Error(`[worktree] refusing to hand ${branch}'s checkout to a second job: ${conflict}`);
  }
  const baseBranch = baseBranchOpt ?? (await currentBranch(repoPath));
  const existing: Worktree | null = record
    ? { path: record.path, branch, baseBranch, createdBranch: false, repoPath }
    : null;
  return { claimed: holders[0], existing, baseBranch };
}

/**
 * Refuse reuse of a branch a prior fork capture left unsafe, or clear that marker when the branch
 * itself is gone (an operator's cleanup, not a retry of the same run).
 */
async function assertForkableBranch(repoPath: string, branch: string, branchAlreadyExisted: boolean): Promise<void> {
  if (!(await unsafeForkBranch(repoPath, branch))) return;
  if (branchAlreadyExisted) {
    throw new Error(
      `[worktree] refusing to reuse ${branch}: fork capture failed after creating it, so its ` +
        `history is unpinned; delete the branch before retrying`,
    );
  }
  await clearUnsafeForkBranch(repoPath, branch);
}

/**
 * `git worktree add`, plus the fork-sha capture {@link createWorktree} pins HEAD from. On failure,
 * hands off to {@link recoverFailedCreate} — which always throws — so a half-created checkout is
 * never returned to a caller as if it were pinned.
 */
async function addAndCaptureFork(
  repoPath: string,
  branch: string,
  baseBranch: string,
  path: string,
  claimed: string | undefined,
  createdBranch: boolean,
): Promise<{ forkSha: string; resolved: string }> {
  // `--lock` as part of the ADD, never a `worktree lock` after it: git documents the two-step form
  // as racy, and this is the race that matters — between the two commands a concurrent anton's
  // teardown reads a fresh, unlocked checkout on the expected branch and force-removes it.
  const lockArgs = claimed ? ["--lock", "--reason", claimLockReason(claimed)] : [];
  if (createdBranch) {
    await git(repoPath, ["worktree", "add", ...lockArgs, path, "-b", branch, baseBranch]);
  } else {
    await git(repoPath, ["worktree", "add", ...lockArgs, path, branch]);
  }

  try {
    // Read the new checkout's HEAD *before* warming: the branch was just cut from `baseBranch`, and
    // warming (or any later fetch) can rewind that ref behind the commit the checkout records. HEAD
    // is fixed to the creation commit regardless — only read here, not after the warm below.
    const forkSha = await readForkAtCreation(path);
    // Canonicalize so the path matches what `git worktree list --porcelain` reports (symlinked
    // tmp dirs on macOS otherwise make repeat lookups return a different-looking path).
    const resolved = await realpath(path);
    return { forkSha, resolved };
  } catch (error) {
    return recoverFailedCreate(repoPath, branch, path, createdBranch, error);
  }
}

/**
 * The checkout half of {@link recoverFailedCreate}: unlock and remove it, naming what cleanup itself
 * could not do when even that fails.
 */
async function removeUnpinnedCheckout(repoPath: string, branch: string, path: string, error: unknown): Promise<void> {
  await git(repoPath, ["worktree", "unlock", path]).catch(() => undefined);
  try {
    await git(repoPath, ["worktree", "remove", "--force", path]);
  } catch (cleanupError) {
    throw new Error(
      `[worktree] could not capture ${branch}'s creation fork and could not remove the unpinned ` +
        `checkout: ${gitError(cleanupError)} (original error: ${gitError(error)})`,
    );
  }
}

/**
 * Returning an unpinned checkout lets a retry classify its branch as reused and derive a fork against
 * a base ref that may have moved. This checkout did not exist before this call, so tear it down before
 * exposing that state; retain a pre-existing branch for the run that owns it. Always throws: the
 * original error when cleanup succeeds, a combined one naming what cleanup itself could not do.
 */
async function recoverFailedCreate(
  repoPath: string,
  branch: string,
  path: string,
  createdBranch: boolean,
  error: unknown,
): Promise<never> {
  await removeUnpinnedCheckout(repoPath, branch, path, error);
  if (createdBranch) await recoverFailedCreateBranch(repoPath, branch, error);
  throw error;
}

/** The branch half of {@link recoverFailedCreate} — delete it, or mark it unsafe when deletion fails too. */
async function recoverFailedCreateBranch(repoPath: string, branch: string, error: unknown): Promise<void> {
  let cleanupError: unknown;
  try {
    await git(repoPath, ["branch", "-D", branch]);
    return;
  } catch (err) {
    cleanupError = err;
  }
  try {
    await markUnsafeForkBranch(repoPath, branch);
  } catch (markError) {
    throw new Error(
      `[worktree] could not capture ${branch}'s creation fork, removed its checkout, but ` +
        `could neither delete nor mark the branch unsafe: ${gitError(markError)} ` +
        `(branch deletion: ${gitError(cleanupError)}; original error: ${gitError(error)})`,
    );
  }
  throw new Error(
    `[worktree] could not capture ${branch}'s creation fork and deleted its checkout, but ` +
      `the branch remains unsafe to reuse: ${gitError(cleanupError)} ` +
      `(original error: ${gitError(error)})`,
  );
}

/**
 * The checkout `resolveClaimForCreate` found, when it is still on disk. A registration can outlive
 * its checkout: `git worktree list` reports an administrative record, and the directory may already
 * be gone (anton-2wvb). Reusing such a path hands a non-existent cwd to `spawn`, which fails as
 * ENOENT naming the *executable* — an error that reads as a missing `claude` binary and sends
 * debugging in entirely the wrong direction. Verify on disk.
 *
 * `refresh`/`preserveShas` bring this REUSED checkout's branch up to `baseBranch` before it's handed
 * back (anton-s55u) — see {@link refreshOntoBase}. Opt-in only: see {@link createWorktree}'s own doc
 * on `refresh` for why a caller like review-fix must never pass it.
 */
async function reuseIfPresent(
  repoPath: string,
  branch: string,
  baseBranch: string,
  claimed: string | undefined,
  existing: Worktree | null,
  refresh: boolean | undefined,
  preserveShas: string[] | undefined,
  forkSha: string | undefined,
  baseIsAuthoritative: boolean | undefined,
): Promise<Worktree | undefined> {
  if (!existing || !existsSync(existing.path)) return undefined;
  if (claimed) await lockClaimedWorktree(repoPath, branch, claimed);
  if (!refresh) return existing;
  const refreshOutcome = await refreshOntoBase({
    repoPath,
    worktreePath: existing.path,
    branch,
    baseBranch,
    preserveShas,
    forkSha,
    baseIsAuthoritative,
  });
  return { ...existing, refreshOutcome };
}

/** The no-existing-checkout half of {@link materializeClaimedWorktree}: add the worktree from scratch. */
async function materializeFreshWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  claimed: string | undefined,
  refresh: boolean | undefined,
  preserveShas: string[] | undefined,
  knownForkSha: string | undefined,
  baseIsAuthoritative: boolean | undefined,
): Promise<Worktree> {
  const path = worktreePathFor(repoPath, branch);
  await mkdir(dirname(path), { recursive: true });

  const branchAlreadyExisted = await branchExists(repoPath, branch);
  await assertForkableBranch(repoPath, branch, branchAlreadyExisted);
  const createdBranch = !branchAlreadyExisted;
  const { forkSha, resolved } = await addAndCaptureFork(repoPath, branch, baseBranch, path, claimed, createdBranch);

  // A pre-existing branch materialized onto a FRESH worktree directory is still a reuse
  // (anton-s55u) — its checkout is new, but its branch may be sitting on a base many commits
  // behind. Bring it up to date (opt-in only, see `refresh` on {@link createWorktree}) and re-read
  // the fork commit so it reflects where the checkout actually ends up, not its pre-refresh tip. A
  // freshly-CREATED branch (the `-b` case above) needs none of this: it was just cut from
  // `baseBranch` itself.
  if (!createdBranch && refresh) {
    const refreshOutcome = await refreshOntoBase({
      repoPath,
      worktreePath: path,
      branch,
      baseBranch,
      preserveShas,
      forkSha: knownForkSha,
      baseIsAuthoritative,
    });
    const refreshedForkSha = await readForkAtCreation(path);
    return { path: resolved, branch, baseBranch, forkSha: refreshedForkSha, createdBranch, repoPath, refreshOutcome };
  }

  return { path: resolved, branch, baseBranch, forkSha, createdBranch, repoPath };
}

/** The under-lock body of {@link createWorktree}: reuse what's already there, or materialize afresh. */
async function materializeClaimedWorktree(
  repoPath: string,
  branch: string,
  baseBranchOpt: string | undefined,
  claimedBy: string | undefined,
  refresh: boolean | undefined,
  preserveShas: string[] | undefined,
  forkSha: string | undefined,
  baseIsAuthoritative: boolean | undefined,
): Promise<Worktree> {
  const { claimed, existing, baseBranch } = await resolveClaimForCreate(repoPath, branch, baseBranchOpt, claimedBy);
  const reused = await reuseIfPresent(
    repoPath,
    branch,
    baseBranch,
    claimed,
    existing,
    refresh,
    preserveShas,
    forkSha,
    baseIsAuthoritative,
  );
  if (reused) return reused;
  // Drop the stale record so `git worktree add` below isn't rejected as "already registered".
  if (existing) await forgetStaleWorktree(repoPath, existing.path);
  return materializeFreshWorktree(repoPath, branch, baseBranch, claimed, refresh, preserveShas, forkSha, baseIsAuthoritative);
}

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
  /**
   * Bring a REUSED checkout's branch up to `baseBranch` (anton-s55u) — see {@link refreshOntoBase}.
   * Opt-in, not the default: an execute run's branch is meant to track its base and wants exactly
   * this, but review-fix's branch is an already-pushed PR whose commits diverging from base is the
   * NORMAL case, not staleness — rebasing it here would rewrite already-pushed history out from
   * under review-fix's own, deliberately merge-based (never rebase) reconciliation with its base.
   */
  refresh?: boolean;
  /** Passed through to {@link refreshOntoBase} when `refresh` is set — see its own doc comment. */
  preserveShas?: string[];
  /** Passed through to {@link refreshOntoBase} when `refresh` is set — see its `forkSha` doc comment. */
  forkSha?: string;
  /**
   * Passed through to {@link refreshOntoBase} when `refresh` is set — see its own doc comment. The
   * caller resolves this, not `createWorktree` itself: only the caller knows whether `baseBranch`
   * came from a confirmed fetch (e.g. `resolveFreshBase`'s success path) or a best-effort fallback.
   */
  baseIsAuthoritative?: boolean;
}): Promise<Worktree> {
  const { repoPath, branch, warm, signal } = opts;

  // Only the registration is serialized against the reaper (see withBranchLock) — warming stays
  // outside it. A cold install runs for minutes, and by the time it starts the checkout exists and
  // the run row already names the branch, which is what the sweep re-reads before deleting anything.
  const wt = await withBranchLock(repoPath, branch, () =>
    materializeClaimedWorktree(
      repoPath,
      branch,
      opts.baseBranch,
      opts.claimedBy,
      opts.refresh,
      opts.preserveShas,
      opts.forkSha,
      opts.baseIsAuthoritative,
    ),
  );

  // The fork was captured before warming; an unexpected setup failure must not discard it before
  // the run row can persist it for a later resume.
  if (warm) await warmWorktreeBestEffort(wt, signal);
  // No hooks bridge to materialize here: every git command anton runs against this worktree passes
  // `-c core.hooksPath=<resolved from repoPath>` itself (see resolveHooksPathOverride in ops.ts) —
  // hooks fire from the base repo's own directory with no symlink, no info/exclude entry, and no
  // dependence on whether warming happened to regenerate anything.
  return wt;
}

/**
 * {@link warmWorktree}, logged and swallowed rather than thrown — warming is an accelerator, never
 * a gate. Exported (not just `createWorktree`'s own inline `warm: true`) for a caller that must
 * persist a refresh boundary before warming starts (anton-s55u, PR #279 review, P1): warming can
 * run for minutes, and a process killed during it would otherwise leave a rebased/merged branch
 * with no persisted record of the boundary it was mutated onto, so a resume after the crash
 * re-derives one against a base that may have moved again — risking the very resurrected-commit bug
 * the pin exists to prevent. Such a caller materializes with `warm: false`, persists once the
 * checkout settles, then calls this directly.
 */
export async function warmWorktreeBestEffort(wt: Worktree, signal?: AbortSignal): Promise<void> {
  try {
    await warmWorktree(wt, signal);
  } catch (err) {
    console.warn(
      `[worktree] warming ${wt.path} failed unexpectedly — continuing without it: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

/** A durable local ref for a branch whose fresh fork could not be captured or cleaned up. */
function unsafeForkRef(branch: string): string {
  return `refs/anton/unsafe-fork/${createHash("sha256").update(branch).digest("hex")}`;
}

/** Whether a prior failed fork capture left this branch unsafe to reuse. */
async function unsafeForkBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", unsafeForkRef(branch)]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 1) return false;
    throw err;
  }
}

/** Mark the surviving branch before returning a failed fork capture to a future retry. */
async function markUnsafeForkBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["update-ref", unsafeForkRef(branch), "HEAD"]);
}

/** A branch an operator removed is safe to create again; its stale marker must not block it. */
async function clearUnsafeForkBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["update-ref", "-d", unsafeForkRef(branch)]);
}

/**
 * Whether `branch` already exists locally. {@link createWorktree} asks this under its branch lock
 * and returns whether it actually created the branch; callers must use that result instead of
 * observing this mutable ref before creation.
 *
 * A missing ref is the one expected false result. Operational failures must propagate: treating an
 * unreadable ref store as a new branch lets creation misclassify a reused checkout as fresh.
 */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (err) {
    // `show-ref --verify` reserves exit 1 for a ref that does not exist; every other failure means
    // git could not establish whether this checkout is reused.
    if ((err as { code?: number }).code === 1) return false;
    throw err;
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
/** The `off` spellings {@link WARM_ENV} recognizes. */
function warmDisabledByEnv(env: Record<string, string | undefined>): boolean {
  const off = env[WARM_ENV]?.trim().toLowerCase();
  return off === "0" || off === "off" || off === "false" || off === "no";
}

/** An operator- or test-pinned warm command, overriding detection entirely. */
function pinnedWarmCommand(env: Record<string, string | undefined>): WarmCommand | undefined {
  const pinned = env[WARM_COMMAND_ENV]?.trim();
  return pinned ? { file: "sh", args: ["-c", pinned], label: pinned } : undefined;
}

/** The lockfile-matched install `worktreePath` still needs, or undefined when none applies. */
function detectedInstall(worktreePath: string): { lockfile: string; bin: string; args: string[] } | undefined {
  const install = INSTALL_BY_LOCKFILE.find((i) => existsSync(join(worktreePath, i.lockfile)));
  return install && installNeeded(worktreePath, install.lockfile) ? install : undefined;
}

/**
 * The absolute path to `bin`, or undefined (logged) when it isn't on the search path. A
 * background-launched server inherits a minimal PATH that omits where bun/pnpm live, so this
 * resolves the same way every other anton spawn does (see ../bin).
 */
/** The install's warm command, or undefined (logged) when its package manager isn't on the search path. */
function resolveInstallCommand(
  install: { lockfile: string; bin: string; args: string[] },
  worktreePath: string,
  env: Record<string, string | undefined>,
  isExec: (p: string) => boolean,
): WarmCommand | undefined {
  const file = findOnPath(install.bin, env.PATH ?? "", extraBinDirs(), isExec);
  if (!file) {
    console.warn(
      `[worktree] cannot warm ${worktreePath}: no '${install.bin}' on the search path (${install.lockfile} present) — ` +
        `the run's first step will pay the cold start, and fail on missing dependencies if it needs them.`,
    );
    return undefined;
  }
  return { file, args: [...install.args], label: `${install.bin} ${install.args.join(" ")}` };
}

/** The checks that short-circuit before any lockfile detection: off, pinned, or running under vitest. */
function warmOverride(env: Record<string, string | undefined>): { command: WarmCommand | null } | undefined {
  if (warmDisabledByEnv(env)) return { command: null };
  const pinned = pinnedWarmCommand(env);
  if (pinned) return { command: pinned };
  // Structural guard, mirroring the claude driver: never shell out to a real package manager under
  // vitest. A test that wants the warm path pins WARM_COMMAND_ENV at a fake above.
  if (env.VITEST) return { command: null };
  return undefined;
}

export function resolveWarmCommand(
  worktreePath: string,
  env: Record<string, string | undefined> = process.env,
  isExec: (p: string) => boolean = isExecutableFile,
): WarmCommand | null {
  const override = warmOverride(env);
  if (override) return override.command;
  const install = detectedInstall(worktreePath);
  return install ? (resolveInstallCommand(install, worktreePath, env, isExec) ?? null) : null;
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
  return record ? { path: record.path, branch, baseBranch: branch, createdBranch: false, repoPath } : null;
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
/** The gitdir a checkout's `.git` marker points at, however git's own line-ending trims it. */
function parseGitDirMarker(marker: string): string | undefined {
  return marker.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim();
}

/**
 * Read the admin directory's own `locked` file. Resolved against the CHECKOUT, not the process cwd:
 * git writes an absolute gitdir today, but a relative one (an older git, a moved repo) would
 * otherwise be looked up under wherever anton happens to be running — and a lock that can't be found
 * reads as "not locked".
 */
async function readLockFile(gitDir: string): Promise<{ locked: boolean; reason?: string }> {
  const lockFile = join(gitDir, "locked");
  if (!existsSync(lockFile)) return { locked: false };
  const reason = await readFile(lockFile, "utf8").catch(() => "");
  return { locked: true, reason: reason.trim() || undefined };
}

async function lockedInAdminDir(
  wt: Worktree,
): Promise<{ locked: boolean; reason?: string } | undefined> {
  try {
    const marker = await readFile(join(wt.path, ".git"), "utf8");
    const gitDir = parseGitDirMarker(marker);
    if (!gitDir) return undefined;
    return await readLockFile(resolve(wt.path, gitDir));
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
/**
 * {@link removalBlocker}'s fallback when git's own listing is unreadable: fail CLOSED for a checkout
 * still on disk by re-reading its lock directly from the admin directory, rather than force-deleting
 * evidence that cannot be ruled out.
 */
async function removalBlockerFromAdminDir(wt: Worktree): Promise<RemovalGuard> {
  if (!existsSync(wt.path)) return {};
  const lock = await lockedInAdminDir(wt);
  if (lock === undefined) {
    return { blocker: "git's worktree list is unreadable, so another owner's lock cannot be ruled out" };
  }
  if (!lock.locked) return {};
  return judgeLock(lock.reason, "its lock file, read directly — git's worktree list was unreadable");
}

/** {@link removalBlocker}'s normal path: judge what git itself now registers for this exact checkout. */
function removalBlockerFromRecord(wt: Worktree, record: WorktreeRecord | undefined): RemovalGuard {
  if (record?.locked) return judgeLock(record.lockReason);
  if (wt.branch && record && record.branch !== wt.branch) {
    const holder = record.branch ? record.branch : "a detached checkout";
    return { blocker: `git registers ${holder} at that checkout now, not ${wt.branch}` };
  }
  return {};
}

async function removalBlocker(wt: Worktree): Promise<RemovalGuard> {
  const records = await listWorktrees(wt.repoPath).catch(() => null);
  if (records === null) return removalBlockerFromAdminDir(wt);
  const target = resolve(wt.path);
  return removalBlockerFromRecord(
    wt,
    records.find((r) => resolve(r.path) === target),
  );
}

/**
 * The main repository may have been moved or partially deleted before anton is asked to forget it. In
 * that case git cannot remove the worktree, but the checkout is still ours if its `.git` file points
 * into this repo's worktree administration directory. Remove only that narrowly verified orphan;
 * never recursively delete an arbitrary path from a database row.
 */
async function removeIfOrphaned(wt: Worktree): Promise<void> {
  if (!existsSync(wt.path)) return;
  try {
    const gitFile = await readFile(join(wt.path, ".git"), "utf8");
    const gitDir = parseGitDirMarker(gitFile);
    const adminRoot = resolve(wt.repoPath, ".git", "worktrees") + sep;
    if (gitDir && resolve(wt.path, gitDir).startsWith(adminRoot)) {
      await rm(wt.path, { recursive: true, force: true });
    }
  } catch {
    // Missing/unreadable marker means ownership cannot be proven; leave it for residue
    // verification to report instead of risking user data.
  }
}

/**
 * Remove the worktree (force, so dirty state is discarded) and prune. If `deleteBranch` is set,
 * also delete the branch. Safe to call when the worktree is already gone (idempotent), and a no-op
 * that REPORTS itself when the checkout is locked by another owner — including another anton process
 * holding a claim on it — or the path has since been registered to a different branch (see
 * {@link removalBlocker}).
 */
/**
 * What {@link removeWorktree} does when the first `git worktree remove` refuses: re-read the guard
 * (a race the pre-check couldn't see), break a dead claim's lock and retry, or reclaim a proven
 * orphan. Returns a skip reason when the caller must stop here; undefined once it may fall through to
 * pruning and branch deletion exactly as a clean removal would.
 */
async function retryRemoval(wt: Worktree): Promise<{ skip: string } | undefined> {
  // git refuses a checkout another owner locked in exactly the same way it fails on a moved repo,
  // and a lock taken after the pre-check above lands here. Re-read it before the fallback: the
  // recursive delete is for a STALE registration, never for a checkout someone just claimed —
  // that owner's uncommitted work is precisely what the lock says must not be destroyed.
  const raced = await removalBlocker(wt);
  if (raced.blocker) return { skip: raced.blocker };
  if (raced.staleClaimLock) {
    // A dead claim's lock appearing only now is the one refusal a retry can clear.
    await unlockWorktree(wt.repoPath, wt.path);
    await git(wt.repoPath, ["worktree", "remove", "--force", wt.path]).catch(() => {
      // Still refused — fall through to the orphan check, which proves ownership before deleting.
    });
  }
  await removeIfOrphaned(wt);
  return undefined;
}

export async function removeWorktree(
  wt: Worktree,
  opts?: { deleteBranch?: boolean },
): Promise<WorktreeRemoval> {
  const guard = await removalBlocker(wt);
  if (guard.blocker) return { removed: false, skipped: guard.blocker, branchDeleted: false };

  const existed = existsSync(wt.path);
  if (existed) {
    // A crashed anton's claim lock still sits on the checkout, and `git worktree remove --force`
    // refuses a locked worktree — break the dead claim rather than leaking the checkout forever.
    if (guard.staleClaimLock) await unlockWorktree(wt.repoPath, wt.path);
    const failure = await git(wt.repoPath, ["worktree", "remove", "--force", wt.path]).then(
      () => undefined,
      () => retryRemoval(wt),
    );
    if (failure?.skip) return { removed: false, skipped: failure.skip, branchDeleted: false };
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
  return { removed, branchDeleted, branchSkipped };
}
