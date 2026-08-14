/**
 * gardener job (anton-3nv7). The scheduled patrol that keeps the board's mechanical hygiene — a peer
 * of the review-fix sweep and run-health, and like them one deterministic pass with no LLM in it.
 *
 * It composes bd's OWN hygiene verbs (the seam in beads/bd.ts, anton-6qbc) rather than
 * reimplementing epic-closure, staleness or duplicate detection over a board read: bd owns those
 * rules, and a second implementation here would drift from the one `bd ready` and the CLI answer to.
 *
 * Three tiers, in this order:
 *
 *   1. SAFE VERBS — the only two writes the patrol may make, both provably mechanical:
 *      `bd epic close-eligible` (an epic whose children are ALL closed is done by definition; bd
 *      refuses an epic with an open child and a childless one) and `bd recompute-blocked` (rebuild
 *      the denormalized `is_blocked` flag from the graph — `bd ready` trusts that flag, so a stale
 *      one hides ready work or serves blocked work to a claimer).
 *   2. REPORT VERBS — read-only, run AFTER the writes so the report describes the board as it now
 *      stands: lint, stale (per status), orphans, dep cycles, duplicates. Everything they find is
 *      REPORTED and nothing more. Merging duplicates, retiring stale work, relinking orphans are
 *      judgment moves that need a human (anton-bci0 "Out of scope"); the seam deliberately has no
 *      wrapper for `--auto-merge`/`--fix`, so one cannot leak in here either.
 *   3. PROPOSALS (anton-9qwq) — the judgment tier. The board-shape claims the report has no verb for
 *      (misfiled work, missing ordering edges, retirement candidates) become approvable proposal
 *      beads, deduplicated by fingerprint so a nightly patrol over an unfixed board asks once — and,
 *      for the duplicates only overlapping patrols on different machines can create, folded back to
 *      one ask before new ones are filed and arbitrated again right after, so a twin filed by
 *      another machine is withdrawn within seconds rather than at the next patrol. This tier writes
 *      to PROPOSALS alone: applying one is an approval away (anton-1t3n), so nothing here touches
 *      the beads a proposal is about.
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
import { beads, type DuplicateGroup } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { nudgeSync, type NudgeTarget } from "../beads/sync-nudge";
import { detectBoard } from "../gardener/detect";
import {
  arbitrateEmission,
  emitProposals,
  MAX_PROPOSALS_PER_PASS,
  NO_REMOTE_SKIP,
  PartialEmissionError,
  reconcileDuplicateProposals,
  type ArbitrationResult,
  type EmissionArbitrationDeps,
  type EmissionResult,
  type EmittedProposal,
} from "../gardener/emit";
import { shadowProposals } from "../gardener/shadow";
import {
  completeHygieneReport,
  startHygieneReport,
  summarizeReport,
  type HygieneActions,
  type HygieneFinding,
} from "../hygiene";
import { getProjectById, getProjectSettings, resolveAutonomyPolicy } from "../projects";
import { appendSessionLog, endSession, startJobSession, type JobSession } from "../sessions";
import { PoisonError } from "./errors";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

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

/**
 * How long untouched is "stale", per status. The two differ because the same silence means different
 * things: a month-old `open` bead is backlog (bd's own default window), while an `in_progress` one
 * untouched for a week is an abandoned run that still reads as in-flight to every other reader of
 * the board — including anton's own claim protocol.
 */
export const STALE_OPEN_DAYS = 30;
export const STALE_IN_PROGRESS_DAYS = 7;

/** Trim a bead title for a one-line finding — a wrapped title reads as noise in a report. */
function short(title: string | undefined, max = 80): string {
  const text = (title ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── finding builders (pure; each turns one bd verb's output into report rows) ──

/** `bd lint`: beads missing the template sections their type requires. */
export function lintFindings(
  violations: Array<{ id: string; title: string; type: string; missing: string[] }>,
): HygieneFinding[] {
  return violations.map((v) => ({
    kind: "lint" as const,
    key: `lint:${v.id}`,
    beadId: v.id,
    title: short(v.title),
    detail: v.missing.length
      ? `${v.type || "bead"} is missing ${v.missing.join(", ")}`
      : `${v.type || "bead"} does not match its template`,
  }));
}

/**
 * `bd stale`, scoped to one status. Kept separate per status rather than merged into one kind
 * because the two need different answers: a stale `open` bead is a backlog decision, a stale
 * `in_progress` one is a run nobody finished.
 */
export function staleFindings(
  beadsList: Array<{ id: string; title?: string; assignee?: string | null }>,
  status: "open" | "in_progress",
  days: number,
): HygieneFinding[] {
  const kind = status === "open" ? ("stale-open" as const) : ("stale-in-progress" as const);
  return beadsList.map((b) => ({
    kind,
    key: `${kind}:${b.id}`,
    beadId: b.id,
    title: short(b.title),
    detail:
      status === "open"
        ? `open and untouched for over ${days} days`
        : `in progress and untouched for over ${days} days${b.assignee ? ` (assignee ${b.assignee})` : ""}`,
  }));
}

/** `bd orphans`: work a commit shipped that nobody ever closed. */
export function orphanFindings(
  orphans: Array<{ id: string; title: string; status: string; latestCommit?: string }>,
): HygieneFinding[] {
  return orphans.map((o) => ({
    kind: "orphan" as const,
    key: `orphan:${o.id}`,
    beadId: o.id,
    title: short(o.title),
    detail: `named by a commit${o.latestCommit ? ` (${o.latestCommit})` : ""} but still ${o.status}`,
  }));
}

/**
 * `bd dep cycles`. A cycle whose member ids bd's payload doesn't spell out is still reported — "the
 * graph has a cycle we can't name" is the finding, and dropping it would hide the one condition this
 * verb exists to surface. Unnamed cycles are keyed by index so two of them don't collapse into one.
 */
export function cycleFindings(cycles: Array<{ ids: string[] }>): HygieneFinding[] {
  return cycles.map((cycle, i) => ({
    kind: "dep-cycle" as const,
    key: `dep-cycle:${cycle.ids.length ? [...cycle.ids].sort().join("+") : `unnamed-${i}`}`,
    ids: cycle.ids,
    detail: cycle.ids.length
      ? `dependency cycle: ${cycle.ids.join(" → ")}`
      : "dependency cycle bd reported in a shape anton could not read — inspect with `bd dep cycles`",
  }));
}

/**
 * `bd duplicates`: groups of beads with identical content, with bd's suggested merge target carried
 * through. Reported only — the merge is a judgment move, so the finding names the target instead of
 * applying it. Keyed on the whole member set so a group that gains a third duplicate reads as a new
 * finding rather than silently mutating the old one.
 */
export function duplicateFindings(groups: DuplicateGroup[]): HygieneFinding[] {
  return groups.flatMap((group) => {
    const ids = group.members.map((m) => m.id).sort();
    if (ids.length < 2) return []; // not a duplicate group at all
    return [
      {
        kind: "duplicate" as const,
        key: `duplicate:${ids.join("+")}`,
        ids,
        title: short(group.title),
        detail:
          `${ids.length} beads with identical content: ${ids.join(", ")}` +
          (group.target ? ` — bd suggests keeping ${group.target}` : ""),
      },
    ];
  });
}

/** Build the runner handler bound to a db/clock. Register it as the "gardener" handler. */
export function makeGardenerHandler(deps: GardenerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const nudge = deps.nudge ?? ((project: NudgeTarget) => nudgeSync(project, "gardener"));

  return async function gardener(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as GardenerPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;
    // How far this project lets a filed proposal go, per kind (anton-nbyy) — read once, so a policy
    // edit mid-patrol cannot have one proposal shadowed under a rule the next one is not.
    const policy = resolveAutonomyPolicy(await getProjectSettings(db, projectId));

    /**
     * The patrol's session log, opened on FIRST WRITE. The gardener runs no claude session, so a row
     * exists only for a pass that has something to say — today, its shadow records (anton-lmps) —
     * and a nightly patrol with nothing to shadow leaves no empty session behind.
     *
     * Linked to the job BOTH ways: `ctx.report` for the live tail while the pass runs, and `jobId` on
     * the row for after it settles. The durable link is the one that matters here — this patrol opens
     * its session in its last few seconds, so a nightly pass is settled long before anyone looks, and
     * the live handle is gone by then.
     */
    let session: JobSession | undefined;
    const log = async (chunk: string): Promise<void> => {
      if (!session) {
        session = await startJobSession(db, clock, {
          projectId,
          kind: "gardener",
          jobId: ctx.jobId,
        });
        ctx.report({ sessionId: session.sessionId });
      }
      await appendSessionLog(session.logPath, chunk);
    };
    const closeSession = async (status: "done" | "failed"): Promise<void> => {
      if (session) await endSession(db, clock, session.sessionId, status);
    };

    // Pull first: the patrol's writes are derived from what it reads, and the local Dolt working set
    // can be a sync heartbeat behind. Best-effort — an unreachable remote must not cost the project
    // its whole patrol, and every verb below is still correct against the local board.
    await beads.pull(repo).catch((e) => console.error(`[gardener] board pull failed for ${repo}`, e));

    // ── tier 1: the safe verbs ──
    const sweep = await beads.epicCloseEligible(repo, { apply: true });
    await ctx.heartbeat();
    const rowsRecomputed = await beads.recomputeBlocked(repo);
    const applied: HygieneActions = { closedEpics: sweep.closed, rowsRecomputed };
    await ctx.heartbeat();

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
      nudge({ id: project.id, repoPath: repo });
    }

    // ── tier 2: the report verbs (read-only) ──
    //
    // A failure here propagates rather than degrading to "nothing found": the report REPLACES what
    // the board shows, so a partial one is indistinguishable from a clean bill of health. The runner
    // retries the pass, and a verb that keeps failing parks the job for a human — which is the
    // honest outcome for a patrol that can no longer see the board.
    //
    // The premise fence opens HERE, before the first read this pass judges from — not just before
    // tier 3's board snapshot. A retirement's evidence IS a hygiene finding (retire.ts reads the
    // stale and duplicate rows below), so a fence stamped after these verbs would date an edit that
    // landed mid-report as already observed, and approval would settle a bead against a premise
    // that edit falsified. Stamped BEFORE rather than after for the same reason at every read: a
    // bead written while one is in flight may or may not be in its result, and the earlier fence
    // dates it as unseen — a refusal at approve time, which is the safe direction. This is what
    // apply compares "has this moved since we asked" against; the proposals' own `created_at` land
    // later, once the sequential creates in tier 3 run.
    const observedAtMs = clock.now();
    const lint = await beads.lintReport(repo);
    const staleOpen = await beads.staleList(repo, { status: "open", days: STALE_OPEN_DAYS });
    const staleInProgress = await beads.staleList(repo, {
      status: "in_progress",
      days: STALE_IN_PROGRESS_DAYS,
    });
    await ctx.heartbeat();
    const orphans = await beads.orphansList(repo);
    const cycles = await beads.depCycles(repo);
    const duplicates = await beads.duplicateGroups(repo);

    const findings: HygieneFinding[] = [
      ...lintFindings(lint.violations),
      ...staleFindings(staleOpen, "open", STALE_OPEN_DAYS),
      ...staleFindings(staleInProgress, "in_progress", STALE_IN_PROGRESS_DAYS),
      ...orphanFindings(orphans),
      ...cycleFindings(cycles),
      ...duplicateFindings(duplicates),
    ];

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
    // and not its findings. The board read spans EVERY status for two reasons: detection reads
    // container-ness and superseding twins off the whole graph, and a DECLINED proposal is a closed
    // bead — a live-only read would miss it and re-ask a question a human already answered. Through
    // `loadAllIssues`, not a bare `bd list --status all`: that flag is unsupported on some bd
    // versions, and a patrol that threw here would park every pass without ever filing a proposal.
    ctx.signal.throwIfAborted();
    const board = await loadAllIssues(repo);
    const detections = detectBoard({ board, hygiene: { findings }, now: clock.now() });
    await ctx.heartbeat();
    // Re-check RIGHT before the first write. The board read and detection above take real time, and
    // a cancel arriving inside them is invisible to `ctx.heartbeat()` — which does not inspect the
    // signal — so without this a cancelled patrol would still file judgment-tier proposal beads.
    // `emitProposals` carries the signal on from here and re-checks between its own creates.
    ctx.signal.throwIfAborted();

    // Converge on ONE ask per claim before filing new ones. Fingerprint suppression is only atomic
    // within a patrol: two on different machines each read a working set the other's proposal has
    // not synced into yet, so the same claim can reach the board twice with nothing to refuse the
    // second. Folding the twins here is the only place that duplication is ever undone — see
    // gardener/emit.ts. Best-effort by design: a failed fold is noise the next patrol retries, not a
    // reason to cost this pass its proposals.
    const reconciled = await reconcileDuplicateProposals(repo, board, { signal: ctx.signal });
    if (reconciled.folded.length > 0) {
      console.log(
        `[gardener] ${projectId}: folded ${reconciled.folded.length} duplicate proposal(s) ` +
          `(${reconciled.folded.map((f) => `${f.id}→${f.into}`).join(", ")})`,
      );
      nudge({ id: project.id, repoPath: repo });
    }
    // Neither silence nor a fold: a twin an approval or a run holds is left for a human, and a close
    // that failed is a duplicate still standing. Both have to be visible to tell either from a board
    // that simply has no duplicates.
    if (reconciled.held.length > 0 || reconciled.failed.length > 0) {
      console.log(
        `[gardener] ${projectId}: left ${reconciled.held.length} duplicate proposal(s) standing ` +
          `(approved or claimed: ${reconciled.held.join(", ") || "none"})` +
          `${reconciled.failed.length > 0 ? `, ${reconciled.failed.length} fold(s) failed: ${reconciled.failed.join(", ")}` : ""}`,
      );
    }
    ctx.signal.throwIfAborted();

    // Whatever landed before a create failed is real board state living only in the local working
    // set. Report and propagate it on the way out, or a pass that parks on the failing proposal
    // leaves the ones that DID file invisible to every other machine.
    const report = (emission: EmissionResult) => {
      if (emission.created.length > 0) {
        console.log(
          `[gardener] ${projectId}: filed ${emission.created.length} proposal(s) ` +
            `(${emission.created.map((p) => p.id).join(", ")})` +
            `${emission.suppressed > 0 ? `, ${emission.suppressed} already on the board` : ""}`,
        );
        nudge({ id: project.id, repoPath: repo });
      }
      // Never a silent cap: the overflow is deterministic and the next pass files it, but a reader
      // has to be able to tell "the board is this clean" from "we stopped at ten".
      if (emission.deferred > 0) {
        console.log(
          `[gardener] ${projectId}: held back ${emission.deferred} proposal(s) — one pass files at ` +
            `most ${MAX_PROPOSALS_PER_PASS}; the next patrol picks them up`,
        );
      }
    };

    // Publish what this pass filed and withdraw the twin a patrol on another machine filed for the
    // same claim — the run-lease arbitration applied to emission (gardener/emit.ts). Without it a
    // duplicate only ever goes away when the NEXT patrol reconciles, which on a nightly schedule
    // leaves an operator a whole day to act on one ask twice. Best-effort like every other fold: it
    // reports why it stood down rather than costing the pass anything.
    const arbitrate = async (emission: EmissionResult): Promise<Set<string>> => {
      if (emission.created.length === 0) return new Set();
      const arbitrated = await arbitrateEmission(repo, emission.created, {
        ...deps.arbitration,
        signal: ctx.signal,
      }).catch((e): ArbitrationResult => {
        // Never the pass's failure, and never a stopped pass's REPORTED failure either: the
        // proposals stand, and the next patrol folds whatever this could not.
        console.error(`[gardener] ${projectId}: emission arbitration failed`, e);
        return { folded: [], held: [], failed: [], skipped: "arbitration itself failed" };
      });
      if (arbitrated.folded.length > 0) {
        console.log(
          `[gardener] ${projectId}: withdrew ${arbitrated.folded.length} proposal(s) another ` +
            `patrol had already filed (${arbitrated.folded.map((f) => `${f.id}→${f.into}`).join(", ")})`,
        );
        nudge({ id: project.id, repoPath: repo });
      }
      // A twin left standing is a duplicate an operator can still see, so it is never silent —
      // whether arbitration stood down, ran into a held twin, or failed its close. The one silent
      // case is a board with no remote: nothing can have filed the claim twice there, so saying
      // "duplicates left" every pass would be noise about an impossible state.
      const unjudged = arbitrated.skipped && arbitrated.skipped !== NO_REMOTE_SKIP;
      if (unjudged || arbitrated.held.length > 0 || arbitrated.failed.length > 0) {
        console.log(
          `[gardener] ${projectId}: emission arbitration left duplicates for the next patrol` +
            `${unjudged ? ` — ${arbitrated.skipped}` : ""}` +
            `${arbitrated.held.length > 0 ? ` (held: ${arbitrated.held.join(", ")})` : ""}` +
            `${arbitrated.failed.length > 0 ? ` (failed: ${arbitrated.failed.join(", ")})` : ""}`,
        );
      }
      return new Set(arbitrated.folded.map((f) => f.id));
    };

    /**
     * What the armed patrol WOULD have done with what it just filed (anton-lmps) — decided against a
     * board read fresh at this moment, exactly as an approval would, and writing nothing.
     *
     * Runs AFTER arbitration and skips what it withdrew: a proposal folded into another machine's
     * twin is a closed ask, and shadowing it would report on a question nobody is being asked.
     */
    const shadow = (created: EmittedProposal[], withdrawn: Set<string>) =>
      shadowProposals({
        repo,
        created: created.filter((p) => !withdrawn.has(p.id)),
        policy,
        observedAtMs,
        nowMs: clock.now(),
        producer: "[gardener]",
        log,
        signal: ctx.signal,
      });

    try {
      const emission = await emitProposals(repo, {
        board,
        detections,
        observedAtMs,
        signal: ctx.signal,
      });
      report(emission);
      await shadow(emission.created, await arbitrate(emission));
    } catch (e) {
      // The proposals a stopped pass DID file are on the board like any other, so they get the same
      // arbitration — a pass that parked on its third create must not leave the first two doubled.
      // Not shadowed, though: the pass is failing and will retry, and its commentary is worth less
      // than getting the beads that landed onto the other machines.
      if (e instanceof PartialEmissionError) {
        report(e.result);
        await arbitrate(e.result);
      }
      await closeSession("failed");
      throw e;
    }
    await closeSession("done");
  };
}
