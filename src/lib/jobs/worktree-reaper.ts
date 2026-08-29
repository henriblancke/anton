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
  type ReapEntry,
  type ReapReport,
  type RunTeardown,
} from "../git/worktree-reaper";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import { deferPassSession } from "./pass-preamble";
import { systemClock, type AntonDb, type Clock } from "./queue";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
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

/** The one-line summary the job logs when it changed something. */
export function reapSummary(report: ReapReport): string {
  const worktrees = report.reaped.filter((e) => e.worktreeRemoved).length;
  const branches = report.reaped.filter((e) => e.branchDeleted).length;
  return `reaped ${worktrees} worktree(s) and ${branches} branch(es); skipped ${report.skipped.length}`;
}

/**
 * Hand back a STOPPED run's worktree and branch, and record what was released and what was kept
 * (anton-hrun.1). Called on every terminal outcome — delivered, failed, killed, abandoned, and a
 * park whose bead has since settled — so no outcome but "still resumable" leaves a checkout behind.
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
}): Promise<ReapEntry> {
  const entry = await releaseRunWorktree({
    repoPath: args.repoPath,
    run: {
      branch: args.worktree.branch,
      path: args.worktree.path,
      beadId: args.beadId,
      status: args.status,
      foreign: args.foreign,
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
        { reaped: [entry], skipped: [] },
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

export function makeWorktreeReaperHandler(deps: WorktreeReaperDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";
  const readBoard = deps.readBoard ?? ((repo: string) => readBoardOrFail(repo));

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
    const report = await reapWorktrees({ repoPath: repo, candidates, lookupPr: deps.lookupPr });
    if (report.reaped.length === 0 && report.skipped.length === 0) return;

    await session.log(formatReapReport(report, `worktree-reaper: ${reapSummary(report)}`));
    await session.end("done");
  };
}
