/**
 * One ATTEMPT at a run target, as its phases pass it between them (anton-1lix).
 *
 * The walk is a sequence — begin → prepare → dispatch → run phase → settle — and every phase after
 * the first reads what the ones before it learned: the board this attempt adopted, the checkout it
 * warmed, the reservations it took, the timeouts it absorbed, the wait it armed. That state is
 * mutable by construction (a run re-reads the board several times, and the stopping paths have to
 * hand back exactly what the try took), so it lives on ONE object rather than in a closure the
 * phases would have to stay inside.
 *
 * Only the fields a LATER phase reads are here. Anything a phase computes and consumes itself —
 * the formula split, the per-ticket skip ledger — stays local to it.
 */
import type { Bead } from "../beads/bd";
import { releaseWorktreeClaim, type Worktree } from "../git/worktree";
import type { ProjectSettings } from "../projects";
import type { Project } from "../types";
import { updateRun, type RunPatch, type RunRow } from "../runs";
import type { RunReadiness, TicketTimeoutOutcome } from "./execute-epic-board";
import type { LiveArmedAsk } from "./execute-epic-human-gate";
import type { RunLease } from "./execute-epic-lease";
import { safe } from "./execute-epic-persist";
import type { AntonDb, Clock } from "./queue";
import type { JobContext } from "./runner";

export interface EpicRun {
  readonly db: AntonDb;
  readonly clock: Clock;
  readonly ctx: JobContext;
  readonly projectId: string;
  readonly project: Project;
  readonly settings: ProjectSettings;
  /** The project's checkout — every bd and git call is rooted here. */
  readonly repo: string;
  readonly targetId: string;
  readonly branch: string;
  readonly runId: string;
  /** The open run row this attempt RESUMED, if any — what pins the pipeline it walks. */
  readonly existing: RunRow | undefined;
  /**
   * Whether the target is a graph unit (feature/epic). Type-only, so unlike the grouping shape it
   * genuinely can't change across a pull — captured once and reused against every refreshed board.
   */
  readonly targetIsUnit: boolean;
  /** One ticket's budget (anton-t1mo), read once so every ticket is measured against one clock. */
  readonly ticketTimeoutMs: number;
  /** The project's OWN `.claude/agents` ids — never gated by the active-agents allowlist. */
  readonly userAgentIds: string[];
  readonly lease: RunLease;

  /** The board as this attempt last adopted it, and the target/tickets derived from that read. */
  all: Bead[];
  target: Bead;
  standaloneRun: boolean;
  tickets: Bead[];

  /** Tickets this run had to stop, and whether each got its work committed before it was stopped. */
  timedOut: TicketTimeoutOutcome[];
  /**
   * What the review gate found on the branch when it failed with an error anton rethrows unchanged
   * (a usage limit, a transient claude failure) — the settle folds it into that attempt's run error,
   * which is the only report those paths get.
   */
  orphanNotice: string;
  /**
   * The children this run reserved for its actor when it claimed the target (anton-0d85). The
   * stopping paths have to hand back what the run took — and only that. Null until the claim gate
   * runs, so every gate that parks before it releases nothing.
   */
  childCascade: { actor: string; ids: string[] } | null;
  /**
   * A needs-human wait this attempt left LIVE on the board — whether or not the park row landed
   * beside it. The cleanup is the last window a force-kill can land in (anton-287p), and reconciling
   * that window means taking THIS arm back.
   */
  armedPark: LiveArmedAsk | undefined;
  /**
   * Tear the checkout down after all — set only when the teardown KEPT it for the park above, and
   * called only when the cleanup's kill window unseats that park.
   */
  releaseGateKeptWorktree: (() => Promise<void>) | undefined;
  /**
   * The worktree this attempt warmed. EVERY terminal outcome owes it back (anton-hrun.1) and the
   * stopping paths live outside the phase that created it. Null until it is warmed, so a run that
   * parked earlier releases nothing.
   */
  worktree: Worktree | null;
  /** This attempt's claim on the checkout, held for as long as it is executing in it. */
  worktreeClaim: string | null;
  /** The operator this run executes as, once the claim gate has resolved one. */
  operator: string | undefined;

  /** Read {@link RunReadiness} for this target off any board snapshot. */
  readiness(board: Bead[]): RunReadiness;
  /**
   * Give the checkout back. Called before every teardown — the teardown force-removes the directory,
   * and a live claim (this run's own included) is precisely what refuses that — and again in the
   * cleanup, which covers the stops that KEEP the worktree: a parked run resumes in it, but is no
   * longer executing in it, so nothing may go on reading the claim as occupancy. Idempotent, and
   * best-effort like the teardown it precedes.
   */
  releaseWorktreeHold(): Promise<void>;
  /**
   * Write the run row, ANSWERING with the failure instead of throwing (anton-287p): the settle paths
   * behind a live gate must report a rejected write in the run's error rather than let it swallow
   * the ask they exist to deliver.
   */
  reportSettle(patch: RunPatch): Promise<string | undefined>;
}

/** Everything an {@link EpicRun} cannot derive for itself — decided by the phase that begins it. */
export type EpicRunSeed = Pick<
  EpicRun,
  | "db"
  | "clock"
  | "ctx"
  | "projectId"
  | "project"
  | "settings"
  | "repo"
  | "targetId"
  | "branch"
  | "runId"
  | "existing"
  | "targetIsUnit"
  | "ticketTimeoutMs"
  | "userAgentIds"
  | "lease"
  | "all"
  | "target"
  | "standaloneRun"
  | "tickets"
  | "readiness"
>;

export function makeEpicRun(seed: EpicRunSeed): EpicRun {
  const run: EpicRun = {
    ...seed,
    timedOut: [],
    orphanNotice: "",
    childCascade: null,
    armedPark: undefined,
    releaseGateKeptWorktree: undefined,
    worktree: null,
    worktreeClaim: null,
    operator: undefined,
    async releaseWorktreeHold() {
      const owner = run.worktreeClaim;
      if (!owner) return;
      run.worktreeClaim = null;
      await safe(() => releaseWorktreeClaim(run.repo, run.branch, owner));
    },
    async reportSettle(patch) {
      try {
        await updateRun(run.db, run.clock, run.runId, patch);
        return undefined;
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
    },
  };
  return run;
}
