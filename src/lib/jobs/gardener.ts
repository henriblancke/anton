/**
 * gardener job (anton-3nv7). The scheduled patrol that keeps the board's mechanical hygiene — a peer
 * of the review-fix sweep and run-health, and like them one deterministic pass with no LLM in it.
 *
 * It composes bd's OWN hygiene verbs (the seam in beads/bd.ts, anton-6qbc) rather than
 * reimplementing epic-closure, staleness or duplicate detection over a board read: bd owns those
 * rules, and a second implementation here would drift from the one `bd ready` and the CLI answer to.
 *
 * Three tiers, in this order — the handler below is that order and little else, with each tier's own
 * reasoning next to its code (anton-l4do):
 *
 *   1. SAFE VERBS (gardener-hygiene.ts) — the only two writes the patrol may make, both provably
 *      mechanical.
 *   2. REPORT VERBS (gardener-hygiene.ts) — read-only, run AFTER the writes so the report describes
 *      the board as it now stands. Everything they find is REPORTED and nothing more; merging
 *      duplicates, retiring stale work and relinking orphans are judgment moves that need a human
 *      (anton-bci0 "Out of scope"), and the seam deliberately has no wrapper for `--auto-merge`.
 *   3. PROPOSALS (gardener-proposals.ts, anton-9qwq) — the judgment tier: what the report can only
 *      describe becomes an approvable proposal bead. A kind the operator has ARMED (anton-nbyy) is
 *      then applied by the pass itself, capped, through the approve route's own `applyProposal`
 *      (anton-4ab3); everything else waits for a human.
 *
 * The board is PULLED first and NUDGED after — the patrol reads the shared board and writes to it,
 * so it must not act on a working set that is a sync heartbeat behind (an epic whose child another
 * machine reopened would otherwise read as closeable), and what it closes has to reach the other
 * machines. Both go through the same per-repo coalescer as every other sync, so neither can overlap
 * an in-flight push.
 *
 * Off by default: the schedule is seeded disabled (schedules.ts), so a project opts in. A patrol
 * never overlaps itself — the scheduler skips a due slot while a job of the same (type, project) is
 * still in flight — so a pass that outruns its slot on a big board costs a skipped slot, not two
 * concurrent sweeps racing the same `epic close-eligible`.
 */
import { nudgeSync, type NudgeTarget } from "../beads/sync-nudge";
import { completeHygieneReport, startHygieneReport, summarizeReport } from "../hygiene";
import { getProjectSettings, resolveAutonomyPolicy } from "../projects";
import { applySafeVerbs, collectFindings } from "./gardener-hygiene";
import { fileGardenerProposals, type EmissionArbitrationDeps } from "./gardener-proposals";
import { remainingApplyBudget } from "./pass-budget";
import { deferPassSession, passProject, pullBoard, type PassScope } from "./pass-preamble";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobEffect, JobHandler } from "./runner";

export { STALE_IN_PROGRESS_DAYS, STALE_OPEN_DAYS } from "./gardener-hygiene";

export interface GardenerPayload {
  projectId: string;
  scheduleId?: string;
}

export interface GardenerDeps {
  db: AntonDb;
  clock?: Clock;
  /**
   * How the patrol propagates its board writes. Injectable so a test can assert the nudge happened
   * without driving a real push; the default is the shared write-sync nudge every operator write
   * uses (immediate coalesced push + durable sync-push backstop).
   */
  nudge?: (project: NudgeTarget) => void;
  /**
   * The emission-arbitration seam — the sync verbs and the settle window a pass uses to withdraw a
   * twin another machine filed. Injectable for the same reason `nudge` is: staging a rival patrol
   * needs neither a real remote nor a real propagation wait. Defaults to the live bd seam.
   */
  arbitration?: EmissionArbitrationDeps;
}

/** Build the runner handler bound to a db/clock. Register it as the "gardener" handler. */
export function makeGardenerHandler(deps: GardenerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const nudge = deps.nudge ?? ((project: NudgeTarget) => nudgeSync(project, "gardener"));

  return async function gardener(ctx: JobContext): Promise<JobEffect> {
    const { projectId } = ctx.payload as GardenerPayload;
    const project = await passProject(db, projectId);
    const repo = project.repoPath;

    /**
     * The patrol's session log, opened on FIRST WRITE. The gardener runs no claude session, so a row
     * exists only for a pass that has something to say — today, its shadow records (anton-lmps) —
     * and a nightly patrol with nothing to shadow leaves no empty session behind.
     */
    const session = deferPassSession(db, clock, { ctx, projectId, kind: "gardener" });

    // Held outside the try so the settle below can report it: the tiers that produce it all run
    // inside, and only a patrol that reached the end of them has an effect to state.
    let effect: JobEffect;

    // Settled on EVERY exit path, not just the proposal tier's. The budget read below opens the row
    // itself when an earlier attempt spent part of the cap (it writes a note), so any throw between
    // there and the end of the patrol — a report verb, a cancel — would otherwise strand a session
    // row reading "running" forever. `end` is a no-op for a patrol that never opened one, so a
    // blanket settle costs a clean board nothing.
    try {
      const scope: PassScope = {
        project: { id: project.id, repoPath: repo },
        slug: project.slug,
        // How far this project lets a filed proposal go, per kind (anton-nbyy) — read once, so a
        // policy edit mid-patrol cannot have one proposal shadowed under a rule the next one is not.
        policy: resolveAutonomyPolicy(await getProjectSettings(db, projectId)),
        // What earlier attempts of THIS job already tried to apply comes off the cap: a patrol that
        // died after its writes is retried under the same job id, and a fresh cap per attempt would
        // let one scheduled patrol apply several caps' worth unattended. Read here, before the
        // patrol writes a line, so this attempt's own log cannot count against it.
        applyBudget: await remainingApplyBudget({
          db,
          jobId: ctx.jobId,
          producer: "[gardener]",
          log: session.log,
        }),
        clock,
        ctx,
        nudge,
        log: session.log,
      };

      await pullBoard(repo, (e) => console.error(`[gardener] board pull failed for ${repo}`, e));

      // ── tier 1: the safe verbs ──
      const applied = await applySafeVerbs(repo, ctx);

      // Record the writes BEFORE the (fallible) report tier, on a row that stays invisible until the
      // findings land. Both verbs are idempotent, so a retry after a report-verb failure closes
      // nothing — without this the published report would say "closed 0 epics" for a patrol that did
      // close work. Re-opening the same job id merges the attempts, so `actions` below is what this
      // PATROL did, not just this attempt (hygiene.ts).
      const { id: reportId, actions } = await startHygieneReport(db, clock, {
        projectId,
        jobId: ctx.jobId,
        actions: applied,
      });

      // Propagate the writes before the (slower) report tier: what this patrol closed is what other
      // machines most need, and a report-verb failure below must not strand it locally. Gated on what
      // THIS attempt wrote — an idle patrol pushing every slot would make a clean board the noisiest
      // thing on the remote, and a retry that changed nothing has nothing new to push.
      if (applied.closedEpics.length > 0 || applied.rowsRecomputed > 0) {
        console.log(
          `[gardener] ${projectId}: closed ${applied.closedEpics.length} epic(s)` +
            `${applied.closedEpics.length ? ` (${applied.closedEpics.join(", ")})` : ""}, ` +
            `recomputed ${applied.rowsRecomputed} blocked row(s)`,
        );
        nudge(scope.project);
      }

      // ── tier 2: the report verbs (read-only) ──
      //
      // The premise fence opens HERE, before the first read this pass judges from — not just before
      // tier 3's board snapshot. A retirement's evidence IS a hygiene finding (retire.ts reads the
      // stale and duplicate rows), so a fence stamped after these verbs would date an edit that landed
      // mid-report as already observed, and approval would settle a bead against a premise that edit
      // falsified. Stamped BEFORE rather than after for the same reason at every read: a bead written
      // while one is in flight may or may not be in its result, and the earlier fence dates it as
      // unseen — a refusal at approve time, which is the safe direction. This is what apply compares
      // "has this moved since we asked" against; the proposals' own `created_at` land later, once the
      // sequential creates in tier 3 run.
      const observedAtMs = clock.now();
      const findings = await collectFindings(repo, ctx);

      // Nothing above is guaranteed to notice a cancel — `heartbeat` doesn't inspect the signal and
      // the bd reads settle on their own — so publishing is gated here explicitly: a cancelled patrol
      // must not present a half-collected report as this run's answer. Its actions row survives,
      // unpublished, and a resume of the same job completes it.
      ctx.signal.throwIfAborted();
      await completeHygieneReport(db, clock, reportId, findings);

      console.log(`[gardener] ${projectId}: ${summarizeReport({ actions, findings })}`);

      // ── tier 3: proposals (anton-9qwq) ──
      //
      // After the report is published, so a failure filing proposals costs the pass its judgment tier
      // and not its findings.
      await fileGardenerProposals(scope, { findings, observedAtMs, arbitration: deps.arbitration });

      // A patrol that closed nothing and found nothing is the healthy board's outcome, and the one
      // an operator most needs told apart from a patrol that never ran. Read from the MERGED
      // `actions`, not this attempt's `applied`: the safe verbs are idempotent, so a retry after a
      // report-verb failure sweeps nothing and would report "nothing to do" for a patrol that closed
      // work — the same misreport the report row exists to prevent.
      // Every count that made this `changed` earns its own clause — a sweep that repaired blocked
      // rows and closed nothing must not report "closed 0 epic(s)" beside a dot saying work landed.
      const closed = actions.closedEpics.length;
      const did = [
        closed > 0 && `closed ${closed} epic(s)`,
        actions.rowsRecomputed > 0 && `recomputed ${actions.rowsRecomputed} blocked row(s)`,
        findings.length > 0 && `${findings.length} finding(s)`,
      ].filter((clause): clause is string => clause !== false);
      effect =
        did.length > 0
          ? { changed: true, note: did.join(", ") }
          : { changed: false, note: "board clean" };
    } catch (e) {
      await session.end("failed");
      throw e;
    }
    await session.end("done");
    return effect;
  };
}
