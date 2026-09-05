/**
 * The IRREVERSIBLE half of a start: the enqueue, and the two records that say it happened.
 *
 * Everything behind this module can be taken back; a run cannot, so this is the narrowest it can be
 * made — an idempotent insert, the resume it cannot do on its own, and best-effort audit writes that
 * must never turn a started target into a reported failure. What it still owes the pass is the
 * teardown question, re-asked at every seam between those writes and handed back for the awaits the
 * CALLER spends after the return (see {@link ConfirmStart}).
 */
import { beads } from "../beads/bd";
import type { PickerPlanEntry } from "../board-picker-plan";
import { recordPickerStart } from "../picker-starts";
import type { ClaimedTarget } from "./picker-apply-claim";
import {
  cancelled,
  type ConfirmStart,
  type PickerApplyOutcome,
} from "./picker-apply-outcome";
import {
  activeExecuteEpicId,
  enqueueExecuteEpicIfAbsent,
  resumableExecuteEpicId,
  resumeJob,
  type AntonDb,
  type Clock,
} from "./queue";

/**
 * The actor every unattended board write is attributed to (R1.7), matching `gardener/apply.ts`:
 * a start nobody watched is recorded as made by nobody, so a reader scanning `bd` history can tell
 * anton's own decisions from a founder's without opening anton at all.
 */
export const POLICY_ACTOR = "policy";

/**
 * The queue half of a start, behind a seam.
 *
 * The raw `./queue` functions insert unconditionally; the runner's methods of the same name check
 * the project's quiesce barrier FIRST, in the same synchronous step as the insert, so a delete that
 * raised the barrier cannot have a run slip in behind it (PR #218 review). Only the runner can make
 * that check atomic — the barrier is its own in-memory set — so the pass takes the verbs from it.
 */
export interface PickerRunOps {
  enqueueIfAbsent(projectId: string, epicBeadId: string): string | undefined;
  /**
   * Un-park the epic's settled job AS A POLICY START — the operator's `bypassBudget` flag comes off
   * inside the resume's own CAS, so a manual resume racing this one either keeps the flag or loses
   * the row outright (`resumeJob`'s `stripBypassBudget`, PR #218 review).
   */
  resume(jobId: string): Promise<boolean>;
}

/**
 * The bead note that records a start (R1.7) — one line, because beads stores notes as a single
 * newline-joined blob where each unindented line is its own entry.
 *
 * It names the RULE and the RANK because those are the two questions asked of an unattended start:
 * which of my criteria let this through, and why this one before the others. The last sentence is
 * the one the gardener's armed applies also carry — the answer to "who approved this" is nobody, and
 * the setting is what a reader has to change.
 */
export function pickerStartNote(entry: PickerPlanEntry, ranked: number): string {
  return (
    `anton: started by POLICY — rank ${entry.rank} of ${ranked}, admitted by ${entry.rule}. ` +
    `Nobody approved this: this project's picker autonomy is set to apply.`
  );
}

/**
 * Resume the epic's settled-but-recoverable run, and answer with the job that is now running.
 *
 * `enqueueExecuteEpicIfAbsent` counts a `parked`/`failed` job as COVERING the epic, so it withholds
 * an id for one — but nothing redispatches a parked job on its own. Left there, the approval and the
 * claim this pass just wrote would hide the target from every later pass with no run behind them
 * (PR #218 review). Reached exactly where the unstick pass reaches for the same verb, and for the
 * same reason: a parked run is revived by resuming THAT job, so it reuses its open run and worktree
 * rather than starting a duplicate beside it.
 *
 * Undefined when there is nothing to resume, or when the resume lost its own CAS — an operator's
 * cancel, or a fresh job that took the epic's active slot first. The caller decides what that means
 * for its writes.
 */
async function resumeSettledRun(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  resume: (jobId: string) => Promise<boolean>,
): Promise<string | undefined> {
  const resumable = await resumableExecuteEpicId(db, projectId, epicBeadId);
  if (!resumable) return undefined;
  return (await resume(resumable)) ? resumable : undefined;
}

export interface StartRunInput {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  /** The plan's top-ranked entry — the one target this pass starts. */
  entry: PickerPlanEntry;
  /** How many the plan ranked, for the note's "rank N of M". */
  ranked: number;
  /** The writes this pass made, and the two ways it can put them down. */
  claimed: ClaimedTarget;
  /** Publish this pass's writes — called on every path that made one. */
  publish: () => void;
  signal?: AbortSignal;
  run?: PickerRunOps;
}

/**
 * The two queue verbs, db-direct by default because a test drives them that way; the scheduled pass
 * is handed the runner's, which refuse a project mid-teardown. See {@link PickerRunOps}.
 */
function resolveRunOps(db: AntonDb, clock: Clock, run: PickerRunOps | undefined): PickerRunOps {
  return {
    enqueueIfAbsent:
      run?.enqueueIfAbsent ??
      ((project: string, epic: string) => enqueueExecuteEpicIfAbsent(db, clock, project, epic)),
    resume:
      run?.resume ?? ((jobId: string) => resumeJob(db, clock, jobId, { stripBypassBudget: true })),
  };
}

/**
 * Re-ask the teardown question at a seam between two of this pass's writes.
 *
 * A cancel that lands past the enqueue is teardown sweeping the project's rows, and the row it
 * deletes may be the one this pass just wrote — or the live one it deferred to. So the run is
 * re-read rather than assumed: gone means the approval and the claim now cover nothing and are ours
 * to take back, exactly as when no run could be started at all. A cancel whose run SURVIVED (a
 * runner stop, a lost lease) leaves real queued work, so those writes stand.
 */
function sweptAway(input: StartRunInput, reason: string): ConfirmStart {
  return async () => {
    if (!cancelled(input.signal)) return undefined;
    if (activeExecuteEpicId(input.db, input.projectId, input.entry.beadId)) return undefined;
    return input.claimed.standDown(reason);
  };
}

/**
 * The audit half of a start (R1.7): the board-native note bd's own history carries, and the
 * operator-facing log entry beside it (anton-vfvg).
 *
 * Both are best-effort — the run is already enqueued, and failing the pass over an audit line would
 * leave a started target reported as unstarted, the one lie they exist to prevent. The teardown
 * question is re-asked at every seam between them, not once before them: each is another await for
 * teardown to delete the row under, and a pass that slept through one would answer `started` with
 * the approval and the claim standing over a run that no longer exists.
 */
async function recordStart(
  input: StartRunInput,
  jobId: string,
  confirmStart: ConfirmStart,
): Promise<PickerApplyOutcome | undefined> {
  const { repoPath, entry } = input;

  const sweptBeforeNote = await confirmStart();
  if (sweptBeforeNote) return sweptBeforeNote;

  // Written as `policy` so bd's own history says who decided.
  await beads
    .note(repoPath, entry.beadId, pickerStartNote(entry, input.ranked), POLICY_ACTOR)
    .catch((e) => console.error(`[picker-apply] could not note the start of ${entry.beadId}`, e));

  const sweptDuringNote = await confirmStart();
  if (sweptDuringNote) return sweptDuringNote;

  // The note answers a reader already looking at the bead; this answers one who does not yet know
  // anything happened.
  await recordPickerStart(input.db, input.clock, {
    projectId: input.projectId,
    beadId: entry.beadId,
    rank: entry.rank,
    ranked: input.ranked,
    rule: entry.rule,
    jobId,
  }).catch((e) => console.error(`[picker-apply] could not log the start of ${entry.beadId}`, e));

  return confirmStart();
}

/**
 * Enqueue the run and record it — or say why the target ended up with none.
 *
 * The enqueue is idempotent: a run already covering this epic locally withholds an id rather than
 * spawning a second, which is what makes two overlapping passes one run. No `bypassBudget` — a
 * policy start is paced by the governor exactly as a queued one is. Both verbs go through the runner
 * in production, so a project whose teardown raised the quiesce barrier throws here instead of being
 * handed a fresh row, and the writes are taken back.
 */
export async function startRun(input: StartRunInput): Promise<PickerApplyOutcome> {
  const { db, projectId, entry, claimed } = input;
  const ops = resolveRunOps(db, input.clock, input.run);

  let jobId: string | undefined;
  try {
    jobId = ops.enqueueIfAbsent(projectId, entry.beadId);
    jobId ??= await resumeSettledRun(db, projectId, entry.beadId, ops.resume);
  } catch (e) {
    console.error(`[picker-apply] could not start a run for ${entry.beadId}`, e);
    return claimed.standDown("the run could not be enqueued");
  }

  if (!jobId) {
    // Nothing of this pass's making runs. An ACTIVE job genuinely covers the target — an overlapping
    // pass, or a run already in flight — and the approval and the claim are what that run needs, so
    // they stand and only the note is skipped: no second start happened. With no active job the
    // writes cover nothing, and left standing they hide the target from every later pass (its own
    // guard reads a claimed bead as taken), so they come back off (PR #218 review).
    if (!activeExecuteEpicId(db, projectId, entry.beadId)) {
      return claimed.standDown("no run could be started for this target");
    }
    input.publish();
    // The approval and the claim STAND here, so the caller's plan — stamped against a board where
    // this target was neither — is as stale as it would be after a start (PR #218 review). And for
    // the same reason the caller re-confirms a start after its restamp, it re-confirms this: the
    // covering run is a project row like any other, and teardown landing in that restamp deletes it
    // (PR #218 review), leaving this pass's approval and claim over nothing.
    return {
      skipped: {
        beadId: entry.beadId,
        reason: "a run already covers this target",
        wroteBoard: true,
      },
      confirmStart: sweptAway(
        input,
        "the pass was cancelled and the run covering this target removed with it",
      ),
    };
  }

  const confirmStart = sweptAway(input, "the pass was cancelled and its run removed with it");
  const swept = await recordStart(input, jobId, confirmStart);
  if (swept) return swept;

  // Publish the approval and the claim, exactly as the approve route does after its own write.
  input.publish();

  return {
    started: { beadId: entry.beadId, rank: entry.rank, rule: entry.rule, jobId },
    confirmStart,
  };
}
