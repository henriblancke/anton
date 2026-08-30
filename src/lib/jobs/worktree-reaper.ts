/**
 * worktree-reaper job (anton-hrun.1). The janitor pass over the residue anton's own runs left on
 * disk: a checkout still registered under `.anton-worktrees/` whose bead has long since closed, and
 * the run branch beside it.
 *
 * Teardown at the end of a run (see `releaseRunWorktree`) is what stops residue accruing; this pass
 * is what reclaims what accrued before it, and what a crash, a kill -9 or a moved repo leaves behind
 * afterwards. It runs deterministically — a board read, a `git worktree list`, one `for-each-ref` over
 * anton's branch prefix, and one `gh` lookup per otherwise-reapable branch — with no Claude session
 * and nothing written to the board. The two git reads are also what BOUNDS the pass: only a resource
 * that still exists is a candidate, so a project's sweep cost tracks its residue, not its run count.
 *
 * Every decision is conservative and reported: only a settled bead's residue is touched, a checkout
 * another tool locked is skipped by name, and a branch still carrying an open PR is kept. The pass
 * opens a session only when it has something to say, so an idle project leaves no empty row behind.
 */
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { lookupOpenPullRequest } from "../git/ops";
import { listBranches, listWorktrees, type Worktree } from "../git/worktree";
import {
  formatReapReport,
  reapCandidates,
  reapWorktrees,
  releaseRunWorktree,
  type ReapCandidate,
  type ReapEntry,
  type ReapReport,
  type Revalidate,
  type RunTeardown,
} from "../git/worktree-reaper";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import { deferPassSession } from "./pass-preamble";
import { systemClock, type AntonDb, type Clock } from "./queue";
import * as schema from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { JobContext, JobHandler } from "./runner";

export interface WorktreeReaperPayload {
  projectId: string;
  scheduleId?: string;
}

export interface WorktreeReaperDeps {
  db: AntonDb;
  clock?: Clock;
  /** anton's run-branch prefix — the same default execute-epic composes its branches with. */
  branchPrefix?: string;
  /** How the pass reads the board. Injectable so a test needn't stand up a bd repo. */
  readBoard?: (repoPath: string) => Promise<Bead[]>;
  /** How a branch's open PR is looked up. Injectable so a test needn't shell out to `gh`. */
  lookupPr?: typeof lookupOpenPullRequest;
  /** How one bead is re-read at deletion time. Injectable so a test needn't stand up a bd repo. */
  showBead?: (repoPath: string, beadId: string) => Promise<{ status: string }>;
}

/**
 * A bead's state as the reaper reads it. An ABANDONED bead is a closed one, so `closed` covers both
 * won't-do and shipped; a bead the board doesn't carry stays `unknown`, which the sweep never reaps.
 */
export function beadStateOf(board: Bead[]): (beadId: string) => "settled" | "open" | "unknown" {
  const byId = new Map(board.map((b) => [b.id, b]));
  return (beadId) => {
    const bead = byId.get(beadId);
    if (!bead) return "unknown";
    return bead.status === "closed" ? "settled" : "open";
  };
}

/**
 * The one-line summary the job logs when it changed something. Counted over BOTH lists, off each
 * entry's own flags: a candidate whose checkout went but whose branch git refused to delete is
 * classified as skipped, and the worktree it did reclaim still has to show up in the count.
 */
export function reapSummary(report: ReapReport): string {
  const all = [...report.reaped, ...report.skipped];
  const worktrees = all.filter((e) => e.worktreeRemoved).length;
  const branches = all.filter((e) => e.branchDeleted).length;
  return `reaped ${worktrees} worktree(s) and ${branches} branch(es); skipped ${report.skipped.length}`;
}

/**
 * Hand back a STOPPED run's worktree and branch, and record what was released and what was kept
 * (anton-hrun.1). Called on every terminal outcome — delivered, failed, killed, abandoned, and a
 * park whose bead has since settled — so no outcome but "still resumable" leaves a checkout behind.
 * The exception is a stop that left work behind (`holdsPartialWork`): that tree is what an operator
 * was told to clear by hand, so it is kept rather than force-removed.
 *
 * The bead's status is re-read here rather than taken from the run's own snapshot: an abandon closes
 * the bead while the run it killed is still unwinding, and a stale "open" would keep the branch of
 * work that is already won't-do.
 *
 * Best-effort by design and reported either way: a run whose real work (branch + PR) landed must not
 * fail over a cleanup, and residue this misses is what the scheduled pass above exists to reclaim.
 */
export async function releaseRunResources(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  repoPath: string;
  worktree: Worktree;
  /** The run being torn down — the teardown account belongs on ITS timeline, not the job's. */
  runId: string;
  beadId: string;
  status: RunTeardown["status"];
  /** The run stopped on ANOTHER machine's live lease — this machine touches neither resource. */
  foreign?: boolean;
  /** The run stopped leaving uncommitted work a human was told to clear from this checkout. */
  holdsPartialWork?: boolean;
}): Promise<ReapEntry> {
  const entry = await releaseRunWorktree({
    repoPath: args.repoPath,
    run: {
      branch: args.worktree.branch,
      path: args.worktree.path,
      beadId: args.beadId,
      status: args.status,
      foreign: args.foreign,
      holdsPartialWork: args.holdsPartialWork,
    },
    isBeadSettled: async () => (await beads.show(args.repoPath, args.beadId)).status === "closed",
  });
  // A pure keep released nothing and has nothing to account for. Without this gate every quota park
  // — which stops with the worktree deliberately intact so the run resumes in it — would leave one
  // empty "skipped" teardown session on the run's timeline, per attempt.
  if (entry.outcome !== "kept") {
    const session = deferPassSession(args.db, args.clock, {
      ctx: args.ctx,
      projectId: args.projectId,
      runId: args.runId,
      kind: "worktree-reaper",
    });
    await session.log(
      formatReapReport(
        // Classified off the outcome exactly as the sweep's report is: a teardown the checkout's
        // holder refused released nothing and does not belong in the reaped column.
        entry.outcome === "acted" ? { reaped: [entry], skipped: [] } : { reaped: [], skipped: [entry] },
        `worktree-reaper: run ${args.beadId} settled as ${args.status}`,
      ),
    );
    await session.end("done");
  }
  return entry;
}

/**
 * The board the sweep judges from, pulled first and FAIL-CLOSED — the one pass whose pull is not
 * best-effort. This checkout's Dolt working set trails the remote by a sync heartbeat, so a bead
 * another machine reopened still reads as closed here; sweeping from that stale board would classify
 * live work as residue and delete its worktree and branch. A failed pull therefore fails the pass,
 * which the runner retries: unreaped residue costs disk until the next sweep, the other way costs
 * someone's checkout. `beads.pull` already resolves for the boards with nothing to pull — a
 * shared-server board and a workspace with no remote — so only a real sync failure lands here.
 */
export async function readBoardOrFail(
  repo: string,
  pull: (repo: string) => Promise<void> = beads.pull,
): Promise<Bead[]> {
  await pull(repo);
  return loadAllIssues(repo);
}

/**
 * The last-moment proof that a candidate is still residue (anton-hrun.1). The board and run rows the
 * plan was made from are already stale by the time the per-branch `gh` lookup returns, and a bead
 * reopened in that window has a new run recreating this exact branch and checkout — which the sweep
 * would then force-remove, uncommitted work and all. Both reads fail CLOSED: a bead that cannot be
 * re-read keeps its resources.
 *
 * Run under the branch's lock (see `withBranchLock`), which is what makes it a proof rather than a
 * narrower guess: a run cannot check the branch out between this read and the removal that follows.
 */
export function makeRevalidator(args: {
  db: AntonDb;
  projectId: string;
  repoPath: string;
  showBead: (repoPath: string, beadId: string) => Promise<{ status: string }>;
}): Revalidate {
  return async (candidate: ReapCandidate) => {
    const rows = await args.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(and(eq(schema.runs.projectId, args.projectId), eq(schema.runs.branch, candidate.branch)));
    if (rows.some((r) => r.status === "running" || r.status === "queued")) {
      return "a run started on it during the sweep";
    }
    if (!candidate.beadId) return undefined;
    const bead = await args.showBead(args.repoPath, candidate.beadId).catch(() => null);
    if (!bead) return `${candidate.beadId} could not be re-read before deletion`;
    if (bead.status !== "closed") return `${candidate.beadId} was reopened during the sweep`;
    return undefined;
  };
}

export function makeWorktreeReaperHandler(deps: WorktreeReaperDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";
  const readBoard = deps.readBoard ?? ((repo: string) => readBoardOrFail(repo));
  const showBead = deps.showBead ?? beads.show;

  return async function worktreeReaper(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as WorktreeReaperPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;

    // A failed board read FAILS the pass rather than degrading: with no board, every candidate reads
    // as "no bead owns this branch", which is a skip — but the same absence one refactor later could
    // read as residue, and the sweep deletes things.
    const board = await readBoard(repo);
    const runs = await db
      .select({
        branch: schema.runs.branch,
        worktreePath: schema.runs.worktreePath,
        status: schema.runs.status,
        epicBeadId: schema.runs.epicBeadId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.projectId, projectId));

    // Both reads are what proves a resource still EXISTS, and neither depends on the other.
    const [worktrees, branches] = await Promise.all([
      listWorktrees(repo),
      listBranches(repo, branchPrefix),
    ]);
    const candidates = reapCandidates({
      repoPath: repo,
      worktrees,
      branches,
      runs,
      beadStatus: beadStateOf(board),
      branchPrefix,
    });
    if (candidates.length === 0) return;

    await ctx.heartbeat();
    const session = deferPassSession(db, clock, { ctx, projectId, kind: "worktree-reaper" });
    const report = await reapWorktrees({
      repoPath: repo,
      candidates,
      lookupPr: deps.lookupPr,
      revalidate: makeRevalidator({ db, projectId, repoPath: repo, showBead }),
      // An operator's cancel (or the runner's no-progress timeout) must stop the sweep between
      // candidates; what it already released is still reported below.
      signal: ctx.signal,
    });
    if (report.reaped.length > 0 || report.skipped.length > 0) {
      await session.log(formatReapReport(report, `worktree-reaper: ${reapSummary(report)}`));
      await session.end(report.aborted ? "failed" : "done");
    }
    // Thrown AFTER the partial account is written, because the runner only turns a timed-out or
    // cancelled attempt into a failure when the handler throws. Returning here would mark the job
    // successful and strand the unjudged residue until the next daily sweep.
    if (report.aborted) throw new Error("worktree-reaper: sweep stopped before judging every candidate");
  };
}
