/**
 * gardener job (anton-3nv7). The scheduled patrol that keeps the board's mechanical hygiene — a peer
 * of the review-fix sweep and run-health, and like them one deterministic pass with no LLM in it.
 *
 * It composes bd's OWN hygiene verbs (the seam in beads/bd.ts, anton-6qbc) rather than
 * reimplementing epic-closure, staleness or duplicate detection over a board read: bd owns those
 * rules, and a second implementation here would drift from the one `bd ready` and the CLI answer to.
 *
 * Two tiers, in this order:
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
import { nudgeSync, type NudgeTarget } from "../beads/sync-nudge";
import {
  saveHygieneReport,
  summarizeReport,
  type HygieneActions,
  type HygieneFinding,
} from "../hygiene";
import { getProjectById } from "../projects";
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

    // Pull first: the patrol's writes are derived from what it reads, and the local Dolt working set
    // can be a sync heartbeat behind. Best-effort — an unreachable remote must not cost the project
    // its whole patrol, and every verb below is still correct against the local board.
    await beads.pull(repo).catch((e) => console.error(`[gardener] board pull failed for ${repo}`, e));

    // ── tier 1: the safe verbs ──
    const sweep = await beads.epicCloseEligible(repo, { apply: true });
    await ctx.heartbeat();
    const rowsRecomputed = await beads.recomputeBlocked(repo);
    const actions: HygieneActions = { closedEpics: sweep.closed, rowsRecomputed };
    await ctx.heartbeat();

    // Propagate the writes before the (slower) report tier: what this patrol closed is what other
    // machines most need, and a report-verb failure below must not strand it locally. Only when
    // something actually changed — an idle patrol pushing every slot would make a clean board the
    // noisiest thing on the remote.
    //
    // Logged HERE, not only in the summary below: both verbs are idempotent, so a failure in the
    // report tier retries the whole pass and the retry's report honestly says it closed nothing —
    // this line is then the only record of which epics THIS attempt closed.
    if (actions.closedEpics.length > 0 || rowsRecomputed > 0) {
      console.log(
        `[gardener] ${projectId}: closed ${actions.closedEpics.length} epic(s)` +
          `${actions.closedEpics.length ? ` (${actions.closedEpics.join(", ")})` : ""}, ` +
          `recomputed ${rowsRecomputed} blocked row(s)`,
      );
      nudge({ id: project.id, repoPath: repo });
    }

    // ── tier 2: the report verbs (read-only) ──
    //
    // A failure here propagates rather than degrading to "nothing found": the report REPLACES what
    // the board shows, so a partial one is indistinguishable from a clean bill of health. The runner
    // retries the pass, and a verb that keeps failing parks the job for a human — which is the
    // honest outcome for a patrol that can no longer see the board.
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
    // the bd reads settle on their own — so the write is gated here explicitly: a cancelled patrol
    // must not persist a half-collected report as this run's answer.
    ctx.signal.throwIfAborted();
    await saveHygieneReport(db, clock, { projectId, jobId: ctx.jobId, actions, findings });

    console.log(`[gardener] ${projectId}: ${summarizeReport({ actions, findings })}`);
  };
}
