/**
 * `featureLedger(db, projectId, beadId)` (anton-8zckg) — the read that turns the pure fold into an
 * answer: resolve the feature's scope from the board, pull every source the fold needs, and compose
 * what `feature-ledger.ts` computes from them.
 *
 * Cost and friction are ONE read (anton-sdz00), so a surface answers "what did this feature cost"
 * and "what did it cost us in attention" from a single resolved scope. Each source lands on the
 * counter that owns it: invocation rows and delivery times for the money and the clock; jobs,
 * escalations and the target's review thread for the intervention counters. Only the send-back
 * notes need no read of their own — they come off the board snapshot the scope was resolved from.
 *
 * Kept out of `feature-ledger.ts` for the same reason `feature-scope.ts` is (see that module's own
 * header): the fold is pure and dependency-free on purpose so a client component can import it, and
 * every source here is impure — a board snapshot and a comment-thread read (`tickets.ts` /
 * `beads`, which reach node:fs through the bd CLI wrapper) beside the anton.db reads. This is the
 * "caller" both of those modules' headers describe as owning the DB side.
 *
 * `undefined` when `projectId` names no project on this anton.db — there is no board to resolve a
 * scope from, which is a different fact from a scope that resolved and recorded nothing.
 */
import { beads, type Bead } from "./beads/bd";
import { parseTicketNotes } from "./beads/notes";
import { invocationsForBeads, type ClaudeInvocationRow } from "./claude-invocations";
import { getDb } from "./db";
import { escalationsForBeads, type EscalationRow } from "./escalations";
import {
  isOverheadRow,
  lastDeliveryMs,
  ledgerFriction,
  ledgerTiming,
  ledgerTotals,
  type FrictionNote,
  type LedgerFriction,
  type LedgerTiming,
  type LedgerTotals,
} from "./feature-ledger";
import { currentRunTargetOf, ledgerScope, type LedgerScope } from "./feature-scope";
import { jobsForBeads, type AntonDb } from "./jobs/queue";
import type { GatewayPricing } from "./model-pricing";
import { getProjectById } from "./projects";
import { reviewReportOf, type ReviewReportRound } from "./review-report";
import { listDeliveriesByBead } from "./runs";
import { listAllBeads } from "./tickets";

/**
 * One feature's whole ledger: which beads it covers, what it cost, how long it took, and how much
 * human attention it needed.
 *
 * Cost and friction ride together on purpose (anton-sdz00) — "what did this feature cost" and "what
 * did it cost US" are the same question asked twice, and a caller that had to compose them from two
 * reads would inevitably render one against a scope the other never saw.
 */
export interface FeatureLedger {
  scope: LedgerScope;
  totals: LedgerTotals;
  timing: LedgerTiming;
  /** The intervention counters, every one a PROXY signal — see {@link LedgerFriction}. */
  friction: LedgerFriction;
  /**
   * The scope's `claude_invocations` rows — the same read `totals`/`timing` are folded from, cut at
   * {@link FeatureLedgerOptions.asOfMs} exactly as those two are. Exposed so a caller that already
   * needs this ledger (`cohort-read.ts`) does not re-run `invocationsForBeads` over the identical
   * scope for its own copy of the rows.
   */
  rows: readonly ClaudeInvocationRow[];
  /** The scope's last delivery, epoch ms — {@link lastDeliveryMs}, same value `timing.leadMs` ends at. */
  deliveredAtMs: number | undefined;
}

/** What a caller can hand this read instead of letting it fetch — see {@link featureLedger}. */
export interface FeatureLedgerOptions {
  /**
   * The board snapshot the caller already holds, passed in rather than re-fetched.
   *
   * Same discipline `feature-scope.ts` states for `ledgerScope` itself, extended one level out: a
   * surface that resolves a feature before asking for its ledger has ALREADY read the board to do
   * it, and the two reads must agree. Fetching a second one here leaves the page's 404 decision and
   * the scope the money is summed over resolved against boards that a concurrent bd write can put
   * out of step — a ledger rendered under a title from a different snapshot.
   *
   * Omitted, the read fetches its own (a CLI or a job holding no board).
   */
  board?: Bead[];
  /** Gateway prices for models `model-pricing` has no direct rate for. */
  gatewayPricing?: GatewayPricing;
  /**
   * Cut every source at this instant rather than folding the scope's whole life — for a target still
   * live on a rerun of an already-delivered feature (`cohort-read.ts`'s `activeRunTargetIds`), the
   * open attempt's own start (or the prior delivery's own timestamp, when no open run row exists to
   * be more precise with). The rerun has no outcome yet, so its own invocations, jobs, escalations,
   * review rounds and send-back notes must not reach a ledger read for the delivery that already
   * happened (PR #331 review) — `undefined` (the default) folds the whole life, unbounded.
   */
  asOfMs?: number;
  /**
   * `asOfMs` is an EXCLUSIVE cutoff — `ts < asOfMs` rather than `ts <= asOfMs`.
   *
   * Both run starts and invocation/friction timestamps are stored at whole-second precision, so an
   * open attempt's own first invocation can land in the SAME SECOND as `asOfMs` when it names that
   * attempt's `attemptStartedAt` — an inclusive cutoff would then keep that unfinished event in the
   * preserved delivery it is cut for (PR #331 review, boundary follow-up). Set this whenever `asOfMs`
   * names an open attempt's start; leave it `false` (the default) when `asOfMs` instead falls back to
   * a prior delivery's own timestamp, which must stay inclusive to keep that delivery's own final
   * event.
   */
  asOfExclusive?: boolean;
}

/**
 * `items` at or before `asOfMs` (strictly before when `exclusive`), or every item when `asOfMs` is
 * `undefined` — the ordinary whole-life read. An item whose own timestamp `at` cannot place (missing,
 * or an unparseable string) is KEPT rather than dropped: an unplaceable date is not evidence the item
 * belongs to the unfinished rerun this cutoff exists to exclude, and refusing to guess means erring
 * toward the whole-life reading every other source already gets when `asOfMs` is absent.
 */
function cutAt<T>(
  items: readonly T[],
  asOfMs: number | undefined,
  at: (item: T) => number | undefined,
  exclusive = false,
): T[] {
  if (asOfMs === undefined) return [...items];
  return items.filter((item) => {
    const ts = at(item);
    return ts === undefined || (exclusive ? ts < asOfMs : ts <= asOfMs);
  });
}

/** A comment/note's own ISO timestamp, or `undefined` when absent or unparseable. */
function timestampOf(at: string | undefined): number | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * What `beadId` — plus its working-layer children (`ledgerScope`) — cost and how long it took,
 * folded from rows anton already writes. `undefined` when `projectId` names no project.
 */
export async function featureLedger(
  db: AntonDb,
  projectId: string,
  beadId: string,
  { board: given, gatewayPricing, asOfMs, asOfExclusive = false }: FeatureLedgerOptions = {},
): Promise<FeatureLedger | undefined> {
  const project = await getProjectById(db, projectId);
  if (!project) return undefined;

  const board = given ?? (await listAllBeads(project));
  const scope = ledgerScope(board, beadId);
  const [rawRows, deliveries, rawJobs, rawEscalations, rawRounds] = await Promise.all([
    invocationsForBeads(db, projectId, scope.ids),
    // A ticket's own local commit is only a feature delivery when the run it committed inside
    // actually delivered — a run that parks or fails before pushing must not hand this feature a
    // `leadMs` ending at an unpublished commit (PR #320 review). `listDeliveriesByBead` checks that
    // per session rather than dropping local commits outright, which still credits a non-final
    // grouped-run child reparented onto a different feature later (PR #320 review, P2).
    listDeliveriesByBead(db, projectId, scope.ids, { includeLocalCommits: false }),
    jobsForBeads(db, projectId, scope.ids),
    escalationsForBeads(db, projectId, scope.ids),
    reviewRoundsOf(project.repoPath, beadId),
  ]);

  // Every friction source is cut at `asOfMs` on its OWN clock — a job's last mutation, an
  // escalation's `raisedAt`, a review round's comment timestamp, a send-back note's header — rather
  // than inferred from the invocation rows. Folding the rerun's jobs/escalations/rounds/notes into a
  // preserved delivery's friction is exactly as premature as folding its invocations would be (PR
  // #331 review): both are evidence of an attempt that has not reached an outcome yet.
  //
  // Jobs cut on `updatedAt`, not `createdAt` (PR #331 review, P2 follow-up): a job row is mutable
  // and carries no history, so `createdAt <= asOfMs` alone proves nothing about its CURRENT status —
  // an open rerun's own execute job is necessarily created before the run's `attemptStartedAt`, so a
  // creation-time cutoff keeps it, and an operator cancelling that job before the rerun settles would
  // then read as this delivery's own cancel. `updatedAt` is the row's last mutation; requiring it at
  // or before `asOfMs` excludes any job touched after the cutoff, however old its `createdAt` is.
  const rows = cutAt(rawRows, asOfMs, (row) => row.recordedAt.getTime(), asOfExclusive);
  const jobs = cutAt(rawJobs, asOfMs, (job) => job.updatedAt.getTime(), asOfExclusive);
  const escalations = cutAt(rawEscalations, asOfMs, (row) => row.raisedAt.getTime(), asOfExclusive);
  const rounds = cutAt(rawRounds, asOfMs, (round) => timestampOf(round.at), asOfExclusive);
  const notes = cutAt(sendBackNotes(board, scope.ids), asOfMs, (note) => timestampOf(note.at), asOfExclusive);

  // Overhead is excluded before timing is folded, the same split `ledgerTotals` already applies at
  // the bucket level (design §D4) — otherwise a scheduled pass attributed to this scope would
  // silently inflate the feature's own `activeMs` (PR #329 review).
  const timingRows = rows.filter((row) => !isOverheadRow(row));
  const deliveredAtMs = lastDeliveryMs(deliveries, scope.ids);

  return {
    scope,
    totals: ledgerTotals(rows, gatewayPricing),
    timing: ledgerTiming(timingRows, deliveredAtMs),
    friction: ledgerFriction({
      rounds,
      jobs,
      escalations: scopedEscalations(board, scope, escalations),
      notes,
    }),
    rows,
    deliveredAtMs,
  };
}

/**
 * `escalations`, kept to the ones that CURRENTLY belong to `scope` — the fix for a double-count
 * `escalationsForBeads`' own broader fetch cannot avoid on its own (PR #322 review).
 *
 * That fetch matches a row whose `beadId` OR `epicBeadId` is in `scope.ids`, and both columns are
 * frozen at raise time (`raiseEscalation` never touches an already-open row again). Reparent the
 * ticket a human-gate escalation names and the row's `epicBeadId` still names its OLD feature while
 * `beadId` — the ticket's own, never-reassigned id — now falls inside a DIFFERENT feature's scope:
 * the old feature's call matches through `epicBeadId`, the new feature's through `beadId`, and one
 * interruption bills twice.
 *
 * Resolved with {@link currentRunTargetOf} on `beadId` (falling back to `epicBeadId` only when a row
 * carries no `beadId` at all, which `parked-run`/`stale-pr`/`dead-lease` rows sometimes don't) rather
 * than trusting either frozen column: that walk re-derives the CURRENT card from the board `scope`
 * itself was just resolved against, so the two can never disagree about which feature owns the row.
 */
function scopedEscalations(
  board: Bead[],
  scope: LedgerScope,
  rows: readonly EscalationRow[],
): EscalationRow[] {
  return rows.filter((row) => {
    const anchor = row.beadId ?? row.epicBeadId ?? scope.beadId;
    return currentRunTargetOf(board, anchor) === scope.beadId;
  });
}

/**
 * The review rounds recorded on the run target's comment thread — the one friction source no table
 * holds, since a gate's history lives only in the comments it appended (`review-report.ts`).
 *
 * The ONE extra bd spawn this read costs, and it is spent on the target alone: a gate reviews the
 * run's whole diff once and comments on the target, so hydrating each ticket in the scope would
 * multiply the spawns to find threads that are empty by construction.
 *
 * A failed read reports NO rounds rather than throwing. The rest of the ledger is dollars and
 * timing read from anton.db, and losing all of it to an unreadable comment thread would trade the
 * answer for the footnote — a scope with zero rounds already reads as "not reviewed", which is the
 * honest thing to say when the thread could not be replayed.
 */
async function reviewRoundsOf(repoPath: string, targetId: string): Promise<ReviewReportRound[]> {
  try {
    return reviewReportOf(await beads.showWithComments(repoPath, targetId)).rounds;
  } catch (e) {
    console.warn(`[feature-ledger] could not read ${targetId}'s review history`, e);
    return [];
  }
}

/**
 * The scope's bead notes, flattened — what `countSendBacks` matches its two send-back phrases
 * against (`rework-marks.ts`). Carries each note's own `at` (set on every send-back note, which is
 * always written as a human note via `formatHumanNote`) so {@link featureLedger} can cut it at
 * {@link FeatureLedgerOptions.asOfMs} the same as every other friction source.
 *
 * Read off the board snapshot already in hand rather than per bead: `bd list --json` carries the
 * `notes` blob, so a whole feature's send-backs cost zero extra spawns. Every bead in the scope is
 * read, not just the target: a reopen writes its instruction note on the TICKET it sent back.
 */
function sendBackNotes(board: readonly Bead[], ids: readonly string[]): (FrictionNote & { at?: string })[] {
  const wanted = new Set(ids);
  return board
    .filter((bead) => wanted.has(bead.id))
    .flatMap((bead) => parseTicketNotes(bead.notes).map((note) => ({ text: note.text, at: note.at })));
}

/** UI/read path over the shared anton.db — see {@link featureLedger}. */
export function projectFeatureLedger(
  projectId: string,
  beadId: string,
  opts?: FeatureLedgerOptions,
): Promise<FeatureLedger | undefined> {
  return featureLedger(getDb(), projectId, beadId, opts);
}
