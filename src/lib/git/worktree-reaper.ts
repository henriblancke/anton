/**
 * Worktree reaper (anton-hrun.1) — anton janitoring the resources its own runs spawn.
 *
 * Two policies over one mechanism. {@link planRunTeardown} answers what a run that has STOPPED owes
 * back: every terminal outcome (delivered, failed, killed, abandoned, parked with nothing left to
 * resume) releases its worktree, and takes the branch with it once the run's bead is settled and no
 * open PR still needs it. {@link planReap} answers the same question for residue already on disk —
 * a checkout or branch whose run is long gone — and is deliberately more conservative: it touches
 * only what it can prove is finished.
 *
 * Both refuse the same two things. A checkout LOCKED by another tool is skipped and named, never
 * force-removed (see `removeWorktree`) — the lock is another owner saying the directory is theirs.
 * And a branch that still carries an open PR is kept whatever its bead says, because deleting it
 * would close the PR out from under the reviewer; a PR check that FAILED reads the same way, so an
 * unreachable `gh` costs the sweep a branch, never a live PR.
 *
 * The plans are pure and the executor is thin on purpose: what may be deleted is the part that has
 * to be provable, and every decision — reaped or skipped — carries the sentence the session log
 * prints (see {@link formatReapReport}).
 */
import { lookupOpenPullRequest, type OpenPullRequestLookup } from "./ops";
import {
  removeWorktree,
  worktreePathFor,
  worktreesRootFor,
  type Worktree,
  type WorktreeRecord,
} from "./worktree";
import { resolve, sep } from "node:path";

/** What may be done to one worktree/branch pair, and the clause that says why. */
export interface ReapPlan {
  removeWorktree: boolean;
  deleteBranch: boolean;
  /**
   * WHY — never what happened. The log line is composed from the plan's reason plus what the
   * removal actually achieved, so a checkout that was already gone can't be reported as reclaimed.
   */
  reason: string;
}

/**
 * What became of a candidate — the ACT, not the plan. A lock can appear between planning and
 * removal, so a plan that intended to reap can still end in `refused`; classifying off the plan
 * reported such a refusal as reaped and left the sweep's skip count at zero.
 */
export type ReapOutcome =
  /** The removal ran. Either resource may already have been gone; `actedLine` says which. */
  | "acted"
  /** The plan intended nothing: the resource is still in use. */
  | "kept"
  /** The plan intended to act and removal refused — a lock that appeared after planning. */
  | "refused";

/** One judged worktree/branch pair, carrying what actually happened to it. */
export interface ReapEntry {
  outcome: ReapOutcome;
  branch: string;
  /** The registered checkout, when there still is one — residue can be a branch with none left. */
  path?: string;
  beadId?: string;
  reason: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

export interface ReapReport {
  reaped: ReapEntry[];
  skipped: ReapEntry[];
}

/** A worktree/branch pair the sweep found, before anything is decided about it. */
export interface ReapCandidate {
  branch: string;
  path?: string;
  beadId?: string;
  /** Git's lock reason, when another owner locked the checkout ("" when locked without one). */
  lock?: string;
  /** A run is EXECUTING on this branch right now (queued or running) — off limits. */
  runLive: boolean;
  /** The bead's state on the board: `settled` = closed (an abandoned bead is closed too). */
  bead: "settled" | "open" | "unknown";
}

/** How an open-PR check came out, phrased for the log. Undefined ⇒ gh confirmed there is none. */
export type OpenPrNotice = string | undefined;

/**
 * What the janitor sweep may do to residue. Conservative by construction: it removes only what it
 * can prove nothing is using — the run is not executing, the bead is settled, no open PR — and
 * reports every other candidate rather than guessing.
 */
export function planReap(candidate: ReapCandidate, openPr: OpenPrNotice): ReapPlan {
  const keep = (reason: string): ReapPlan => ({ removeWorktree: false, deleteBranch: false, reason });
  const bead = candidate.beadId ?? "its bead";

  if (candidate.lock !== undefined) {
    return keep(`locked by another owner (${candidate.lock || "no reason given"})`);
  }
  if (candidate.runLive) return keep("a run is executing on it");
  if (candidate.bead === "open") return keep(`${bead} is still open`);
  if (candidate.bead === "unknown") return keep("no bead on the board owns it");
  if (openPr) return { removeWorktree: true, deleteBranch: false, reason: openPr };
  return {
    removeWorktree: true,
    deleteBranch: true,
    reason: `${bead} is closed and no open PR needs it`,
  };
}

/** How a run settled, as the teardown reads it. */
export interface RunTeardown {
  branch: string;
  path: string;
  beadId: string;
  /** The run row's settled status. `parked` is the only one that can still be resumed. */
  status: "done" | "failed" | "parked";
  /** The run parked on ANOTHER machine's live lease — that machine owns the branch, not this one. */
  foreign?: boolean;
  /** The bead is closed or abandoned: nothing will ever resume in this worktree. */
  beadSettled: boolean;
}

/**
 * What a run that has stopped owes back. Every terminal outcome releases the worktree — a delivered
 * run's work is on its branch, and a failed, killed or abandoned run's worktree is residue the next
 * attempt recreates from the branch anyway.
 *
 * A PARK is the one stop that is not terminal: the run is waiting on a quota window, a blocking
 * review, or a held tail, and resumes IN THIS WORKTREE — unless its bead has since been closed or
 * abandoned, which is exactly the park nothing will come back to.
 */
export function planRunTeardown(run: RunTeardown, openPr: OpenPrNotice): ReapPlan {
  const keep = (reason: string): ReapPlan => ({ removeWorktree: false, deleteBranch: false, reason });

  if (run.foreign) return keep("the run is live on another machine");
  if (run.status === "parked" && !run.beadSettled) return keep("the run is parked and resumes here");
  if (!run.beadSettled) {
    return { removeWorktree: true, deleteBranch: false, reason: `${run.beadId} is still open` };
  }
  if (openPr) return { removeWorktree: true, deleteBranch: false, reason: openPr };
  return { removeWorktree: true, deleteBranch: true, reason: `${run.beadId} is closed` };
}

/** Look up the branch's open PR, phrased for the log. A FAILED check keeps the branch (fail closed). */
export async function openPrNotice(
  repoPath: string,
  branch: string,
  lookup: typeof lookupOpenPullRequest = lookupOpenPullRequest,
): Promise<OpenPrNotice> {
  const found: OpenPullRequestLookup = await lookup(repoPath, branch).catch(() => ({ failed: true }));
  if (found.failed) return "the open-PR check failed, so the branch is kept until it can be proven unused";
  return found.pr ? `it still carries open PR ${found.pr.ref}` : undefined;
}

/**
 * The residue this project's runs left behind, from the two places it can still EXIST — a checkout
 * registered under anton's worktrees root, or a local branch under anton's prefix. A run row is
 * consulted for what it knows (the bead behind a branch, the path it checked out) but is never on
 * its own evidence of residue: a settled row outlives both resources it names, so treating every row
 * as a candidate would make each finished run a permanent `gh` call on every sweep, and a project's
 * sweep cost would grow with its lifetime run count.
 *
 * Branches are the reason a run row is not the third source either: a branch whose row is gone — the
 * shape a recreated `anton.db` leaves — is exactly the residue this sweep exists to reclaim, and it
 * is visible only in git.
 *
 * Pure: the caller does the git/db/board reads. Scoping to the worktrees root is what keeps the
 * sweep off `.claude/worktrees` and off the operator's own checkouts, and the main working tree is
 * never a candidate whatever else is true of it.
 */
export function reapCandidates(input: {
  repoPath: string;
  worktrees: WorktreeRecord[];
  /** Every local branch under `branchPrefix/`, as `listBranches` reports it. */
  branches: string[];
  /** This project's run rows — every status, since a live row still names what it is using. */
  runs: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    status: string;
    epicBeadId: string;
  }>;
  /** Bead status by id, from one board read. Ids absent from it read as `unknown`. */
  beadStatus: (beadId: string) => "settled" | "open" | "unknown";
  /** Branch prefix anton names its run branches with (`anton/<bead>`). */
  branchPrefix: string;
}): ReapCandidate[] {
  const { repoPath, worktrees, runs, beadStatus, branchPrefix } = input;
  const root = resolve(worktreesRootFor(repoPath)) + sep;
  const scoped = worktrees.filter(
    (wt) => !wt.isMain && wt.branch && (resolve(wt.path) + sep).startsWith(root),
  );
  // What still exists, and therefore what may be a candidate at all.
  const checkedOut = new Set(scoped.map((wt) => wt.branch));
  const existingBranches = new Set(input.branches);
  // A run row is the only place a branch's bead id is recorded; a checkout found on disk falls back
  // to parsing it out of the branch name, which is how anton composes it in the first place.
  const beadIdOf = (branch: string): string | undefined =>
    runs.find((r) => r.branch === branch)?.epicBeadId ??
    (branch.startsWith(`${branchPrefix}/`) ? branch.slice(branchPrefix.length + 1) : undefined);
  const liveBranches = new Set(
    runs.filter((r) => r.status === "running" || r.status === "queued").map((r) => r.branch),
  );

  const candidates = new Map<string, ReapCandidate>();
  const add = (c: ReapCandidate) => {
    const existing = candidates.get(c.branch);
    // The checkout carries facts a run row cannot (its live path, its lock); the run row carries the
    // bead. Neither half may erase the other's.
    candidates.set(c.branch, {
      ...existing,
      ...c,
      path: c.path ?? existing?.path,
      beadId: c.beadId ?? existing?.beadId,
      bead: c.beadId ? c.bead : (existing?.bead ?? c.bead),
      lock: c.lock ?? existing?.lock,
    });
  };

  for (const r of runs) {
    // A row whose checkout and branch are both gone has nothing left to reap — the run already
    // handed them back — so it contributes its bead and path only while one of them survives.
    if (!r.branch || !(checkedOut.has(r.branch) || existingBranches.has(r.branch))) continue;
    add({
      branch: r.branch,
      path: r.worktreePath ?? undefined,
      beadId: r.epicBeadId,
      runLive: liveBranches.has(r.branch),
      bead: beadStatus(r.epicBeadId),
    });
  }
  for (const wt of scoped) {
    const branch = wt.branch as string;
    const beadId = beadIdOf(branch);
    add({
      branch,
      path: wt.path,
      beadId,
      lock: wt.locked ? (wt.lockReason ?? "") : undefined,
      runLive: liveBranches.has(branch),
      bead: beadId ? beadStatus(beadId) : "unknown",
    });
  }
  for (const branch of input.branches) {
    if (candidates.has(branch)) continue;
    const beadId = beadIdOf(branch);
    add({
      branch,
      beadId,
      runLive: liveBranches.has(branch),
      bead: beadId ? beadStatus(beadId) : "unknown",
    });
  }
  return [...candidates.values()];
}

/**
 * The log line for a candidate the plan acted on: what the removal ACHIEVED, then why it was allowed
 * to. Composed from the outcome rather than the intent — most residue is a run row whose checkout is
 * long gone, and reporting those as reclaimed would inflate every sweep with work nobody did.
 */
function actedLine(
  entry: { branch: string; path?: string },
  plan: ReapPlan,
  outcome: { removed: boolean; branchDeleted: boolean },
): string {
  const parts: string[] = [];
  // Residue can be a branch alone, with no checkout ever recorded — such a line says nothing about
  // a worktree rather than inventing one.
  if (plan.removeWorktree && entry.path) {
    parts.push(
      outcome.removed ? `released worktree ${entry.path}` : `worktree ${entry.path} was already gone`,
    );
  }
  parts.push(
    plan.deleteBranch
      ? outcome.branchDeleted
        ? `deleted branch ${entry.branch}`
        : `branch ${entry.branch} was already gone`
      : `kept branch ${entry.branch}`,
  );
  return `${parts.join("; ")} — ${plan.reason}`;
}

/** Carry out one plan, and record what actually happened (a locked checkout still refuses). */
async function applyPlan(
  repoPath: string,
  entry: { branch: string; path?: string; beadId?: string },
  plan: ReapPlan,
): Promise<ReapEntry> {
  const base = { ...entry, worktreeRemoved: false, branchDeleted: false };
  if (!plan.removeWorktree && !plan.deleteBranch) {
    return { ...base, outcome: "kept", reason: `skipped ${entry.path ?? entry.branch}: ${plan.reason}` };
  }

  // Residue can be a branch whose checkout is already gone; `removeWorktree` still prunes and
  // deletes the branch off the synthetic descriptor its path would have had.
  const wt: Worktree = {
    path: entry.path ?? worktreePathFor(repoPath, entry.branch),
    branch: entry.branch,
    baseBranch: entry.branch,
    repoPath,
  };
  const outcome = await removeWorktree(wt, { deleteBranch: plan.deleteBranch });
  // The lock can appear between the plan and the act; `removeWorktree` refuses it either way, so
  // the entry reports the refusal rather than the plan's optimism.
  if (outcome.skipped) {
    return { ...base, outcome: "refused", reason: `skipped ${entry.path ?? entry.branch}: ${outcome.skipped}` };
  }
  return {
    ...base,
    outcome: "acted",
    reason: actedLine(entry, plan, outcome),
    worktreeRemoved: outcome.removed,
    branchDeleted: outcome.branchDeleted,
  };
}

/** Reap what the sweep proved is finished; report everything it left alone and why. */
export async function reapWorktrees(args: {
  repoPath: string;
  candidates: ReapCandidate[];
  /** Injectable so a test needn't shell out to `gh`. */
  lookupPr?: typeof lookupOpenPullRequest;
}): Promise<ReapReport> {
  const report: ReapReport = { reaped: [], skipped: [] };
  for (const candidate of args.candidates) {
    // Only a candidate that is otherwise reapable can cost a `gh` call: everything else is decided
    // before the PR is relevant, and a sweep over an idle project must stay free.
    const settled =
      candidate.lock === undefined && !candidate.runLive && candidate.bead === "settled";
    const openPr = settled
      ? await openPrNotice(args.repoPath, candidate.branch, args.lookupPr)
      : undefined;
    const plan = planReap(candidate, openPr);
    const entry = await applyPlan(args.repoPath, candidate, plan);
    // Classified on the outcome, never the plan: a checkout locked between planning and removal is
    // refused, and reporting that as reaped would claim work the sweep did not do.
    (entry.outcome === "acted" ? report.reaped : report.skipped).push(entry);
  }
  return report;
}

/**
 * Release one stopped run's worktree and branch. `isBeadSettled` is read HERE, not passed in: an
 * abandon closes the bead while the run it killed is still unwinding, so a status captured at the
 * top of the run says "open" for work that is already won't-do.
 */
export async function releaseRunWorktree(args: {
  run: Omit<RunTeardown, "beadSettled">;
  repoPath: string;
  isBeadSettled: () => Promise<boolean>;
  lookupPr?: typeof lookupOpenPullRequest;
}): Promise<ReapEntry> {
  const beadSettled = await args.isBeadSettled().catch(() => false);
  const run: RunTeardown = { ...args.run, beadSettled };
  // Only a settled bead can lose its branch, so only that case pays for a `gh` lookup.
  const openPr = beadSettled
    ? await openPrNotice(args.repoPath, run.branch, args.lookupPr)
    : undefined;
  return applyPlan(args.repoPath, run, planRunTeardown(run, openPr));
}

/** The session-log block for a pass: every worktree and branch reaped, and every one skipped, with why. */
export function formatReapReport(report: ReapReport, header: string): string {
  const lines = [header, ...report.reaped.map((e) => `  ${e.reason}`), ...report.skipped.map((e) => `  ${e.reason}`)];
  return `${lines.join("\n")}\n`;
}
