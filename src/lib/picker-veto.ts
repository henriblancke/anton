/**
 * THE VETO (anton-jqvy): what an operator answered the board-picker, and for how long it holds.
 *
 * Disagreeing with a pick has to be cheap AND cumulative. Cheap is the deferral: `✕ not now` takes
 * one target out of the next passes' plans for a bounded window and nothing else — not the pass, not
 * the project, not the target's approval. Cumulative is the RECORD: every veto is a decline against
 * the decision that produced the pick, stored beside the accept that release writes, so the pair is
 * the track record earned autonomy reads. A dismissal that taught nothing would make the same
 * argument again next week.
 *
 * Two things this deliberately is NOT:
 *
 *   • NOT a blocklist. A decline carries an expiry, so the window is what un-defers the target —
 *     there is no state anybody has to remember to clear, and no per-bead "never" anywhere in the
 *     store. A rule that should hold forever belongs in the policy, which is exactly where `Never`
 *     sends the operator.
 *   • NOT a board write. bd's own `bd defer` is shared, unbounded state a human must undo; this is
 *     machine-local pacing on one operator's queue, like the plan and the policy it answers.
 *
 * db-injectable, like `board-picker-plan`: the pass and its tests share one connection, and the UI
 * read path goes through the shared anton.db.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { PolicyCriterionKey } from "./policy/types";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * How long a veto holds a target out of the plan.
 *
 * A day, and the bound is the point: long enough that the next few passes do not re-argue a pick the
 * operator just refused, short enough that a target vetoed on a Monday premise is re-offered once
 * that premise can have changed. A window an operator had to clear by hand would be a blocklist with
 * extra steps.
 */
export const PICKER_DEFER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which affordance produced a verdict — the act, kept beside the verdict it implies. */
export type PickerVerdictAction = "not-now" | "never" | "release";

/** What the operator said about the pick. `release` accepts; both vetoes decline. */
export type PickerVerdict = "accepted" | "declined";

/** One recorded answer to one pick. */
export interface PickerVerdictRow {
  beadId: string;
  verdict: PickerVerdict;
  action: PickerVerdictAction;
  rule?: string;
  criterion?: PolicyCriterionKey;
  rank?: number;
  planId?: string;
  /** Epoch ms the deferral expires; absent when the verdict defers nothing. */
  deferredUntilMs?: number;
  decidedAtMs: number;
}

/** A target currently held out of the plan, and until when (epoch ms). */
export interface PickerDeferral {
  beadId: string;
  untilMs: number;
}

/** The other half of the record: what an operator ACCEPTED, and which pick they accepted. */
export interface RecordAcceptInput {
  projectId: string;
  beadId: string;
  /** The admitting rule the plan recorded for this pick, when the caller read one. */
  rule?: string;
  rank?: number;
  /** The generation id of the plan being answered — what identifies the PICK, not just the bead. */
  planId?: string;
}

export interface RecordVetoInput {
  projectId: string;
  beadId: string;
  action: Exclude<PickerVerdictAction, "release">;
  /** The admitting rule the plan recorded for this pick, when the caller read one. */
  rule?: string;
  /** The criterion `Never` opens the editor at; absent when the policy narrows nothing. */
  criterion?: PolicyCriterionKey;
  rank?: number;
  planId?: string;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function msOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value * 1000;
  return undefined;
}

/**
 * ONE ANSWER PER PICK, settled where the race actually is (PR #212 review).
 *
 * The accept and the decline are written by two different routes, so nothing on the client can
 * serialize them: the same pick open in two tabs, or a budget-aware card whose `Queue` sits beside
 * its veto controls, can land a release and a veto against the SAME decision. Recording both would
 * leave the track record earned autonomy reads holding two contradictory answers to one question,
 * and the target deferred while its own run is under way.
 *
 * So each writer takes the write lock BEFORE it reads (an IMMEDIATE transaction — nothing can commit
 * between the guard and the insert) and records nothing when this pick already carries the OPPOSITE
 * verdict. First answer wins; the second is told it lost rather than contradicting it.
 *
 * Scoped to the PICK — project + bead + plan id — not to the bead: a later plan that re-picks the
 * same target is a new decision and takes its own answer, which is why the id names the plan
 * GENERATION and never the reusable board digest (`planIdFor`). A plan-less verdict answers no
 * recorded pick and stays unconstrained, exactly as `picker_verdicts_accept_unique` leaves it.
 *
 * Answers with the ROW that got there first, not just a flag, so a veto that loses can be pinned to
 * the accept it lost to (see {@link contestedVetoes}).
 */
function pickAlreadyAnswered(
  tx: Pick<AntonDb, "select">,
  input: { projectId: string; beadId: string; planId?: string },
  verdict: PickerVerdict,
): string | undefined {
  if (!input.planId) return undefined;
  return tx
    .select({ id: schema.pickerVerdicts.id })
    .from(schema.pickerVerdicts)
    .where(
      and(
        eq(schema.pickerVerdicts.projectId, input.projectId),
        eq(schema.pickerVerdicts.beadId, input.beadId),
        eq(schema.pickerVerdicts.planId, input.planId),
        eq(schema.pickerVerdicts.verdict, verdict),
      ),
    )
    .limit(1)
    .all()[0]?.id;
}

/**
 * The decline already standing against this pick, when there is one (PR #212 review).
 *
 * A pick gets one DECLINE row, not one per click: two tabs vetoing the same card, or a client
 * retrying after it lost the response, are the same answer restated. Counting them twice would
 * inflate the negative half of the record `pickerTrackRecord` reads and push other decisions out of
 * its rolling window — so the repeat extends the standing decline instead of filing a new one.
 *
 * Keyed on the PICK where there is one, like {@link pickAlreadyAnswered}: a later plan that re-picks
 * the target is a new decision and takes its own answer.
 *
 * A PLAN-LESS veto names no decision to key on, so the HOLD it placed is its identity instead (PR
 * #212 review): while this target is still deferred, another plan-less veto of it is the same answer
 * restated — the stale tab the route stripped the generation from, retried after a lost response —
 * and extends that hold rather than filing a second decline the record would count twice. Once the
 * window has run out there is nothing standing: the target was offered again and refused again,
 * which is a new decision.
 */
function standingDecline(
  tx: Pick<AntonDb, "select">,
  input: { projectId: string; beadId: string; planId?: string },
  now: Date,
) {
  const identity = input.planId
    ? eq(schema.pickerVerdicts.planId, input.planId)
    : and(
        isNull(schema.pickerVerdicts.planId),
        gt(schema.pickerVerdicts.deferredUntil, now),
      );
  return (
    tx
      .select({
        id: schema.pickerVerdicts.id,
        rule: schema.pickerVerdicts.rule,
        criterion: schema.pickerVerdicts.criterion,
        rank: schema.pickerVerdicts.rank,
        deferredUntil: schema.pickerVerdicts.deferredUntil,
      })
      .from(schema.pickerVerdicts)
      .where(
        and(
          eq(schema.pickerVerdicts.projectId, input.projectId),
          eq(schema.pickerVerdicts.beadId, input.beadId),
          eq(schema.pickerVerdicts.verdict, "declined"),
          identity,
        ),
      )
      // The longest-standing hold first: a plan-less veto never shortens a window already running, so
      // the row it extends is the one whose expiry is furthest out.
      .orderBy(desc(schema.pickerVerdicts.deferredUntil))
      .limit(1)
      .all()[0]
  );
}

/**
 * File the decline: extend the standing one, or write a new row, and answer with the hold in force.
 *
 * Shared by the veto itself and by the REPLAY a withdrawn reservation performs
 * ({@link withdrawPickerAccept}) — one place decides what a decline does, so a replayed veto lands
 * exactly as the original would have.
 */
function writeDecline(
  tx: Pick<AntonDb, "select" | "insert" | "update">,
  input: RecordVetoInput,
  nowMs: number,
): PickerDeferral {
  const standing = standingDecline(tx, input, new Date(nowMs));
  const heldUntilMs = Math.max(
    nowMs + PICKER_DEFER_WINDOW_MS,
    standing ? (msOf(standing.deferredUntil) ?? 0) : 0,
  );
  if (standing) {
    tx.update(schema.pickerVerdicts)
      .set({
        action: input.action,
        rule: input.rule ?? standing.rule,
        criterion: input.criterion ?? standing.criterion,
        rank: input.rank ?? standing.rank,
        deferredUntil: secDate(heldUntilMs),
        decidedAt: secDate(nowMs),
      })
      .where(eq(schema.pickerVerdicts.id, standing.id))
      .run();
  } else {
    tx.insert(schema.pickerVerdicts)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        beadId: input.beadId,
        verdict: "declined",
        action: input.action,
        rule: input.rule ?? null,
        criterion: input.criterion ?? null,
        rank: input.rank ?? null,
        planId: input.planId ?? null,
        deferredUntil: secDate(heldUntilMs),
        decidedAt: secDate(nowMs),
      })
      .run();
  }
  return { beadId: input.beadId, untilMs: secDate(heldUntilMs).getTime() };
}

/**
 * Vetoes that lost to a RESERVATION, held against the accept row each lost to (PR #212 review).
 *
 * A release reserves its accept before it enqueues, so a veto racing it is refused: the pick is
 * running. But the reservation is provisional — an enqueue that throws takes it back — and a veto
 * dropped on the floor there would leave the operator with no run, no accept and no hold, on a pick
 * they refused and were told was already under way. So the loser rides with the winner and is
 * replayed by {@link withdrawPickerAccept} inside the very transaction that deletes it.
 *
 * In memory on purpose: a reservation lives for the length of one request in one process, and a
 * process that dies mid-release leaves the accept standing with nobody to withdraw it either. An
 * entry whose accept kept its run is never claimed, so entries are aged out on the next loss rather
 * than by a timer nothing else needs.
 */
const CONTESTED_TTL_MS = 10 * 60 * 1000;
const contestedVetoes = new Map<string, { input: RecordVetoInput; atMs: number }>();

function holdContestedVeto(acceptId: string, input: RecordVetoInput, nowMs: number): void {
  for (const [id, held] of contestedVetoes) {
    if (nowMs - held.atMs > CONTESTED_TTL_MS) contestedVetoes.delete(id);
  }
  contestedVetoes.set(acceptId, { input, atMs: nowMs });
}

/** What a veto did: the hold it placed, or the release that answered this pick first. */
export type PickerVetoOutcome =
  | { recorded: true; deferral: PickerDeferral }
  | { recorded: false; reason: "released" };

/**
 * Record a veto: a decline against this pick, deferring the target for the bounded window.
 *
 * BOTH vetoes defer, and for the same window. `Never` differs in where it sends the operator next —
 * the policy editor, at the criterion that admitted this bead — not in how long the target stays
 * out: a veto that left the card in the very next pass's plan while its author was still editing the
 * rule would be a veto that did nothing. The window bounds it either way, so a `Never` whose policy
 * edit is abandoned quietly reverts to "anton may offer this again", which is the honest outcome.
 *
 * Refused outright when a release already accepted this pick (see {@link pickAlreadyAnswered}): the
 * run is under way, so there is nothing left to set aside, and the caller reports that rather than
 * filing a decline against a decision the operator already took the other side of. The refusal is
 * not the end of it, though — the accept may still be a RESERVATION whose run never starts, so the
 * loss is remembered against that row ({@link contestedVetoes}) and replayed if it is withdrawn.
 *
 * A REPEAT veto is allowed — the same answer, not the opposite one — and EXTENDS the standing
 * decline rather than writing a second one (see {@link standingDecline}), keeping the later expiry
 * and whatever provenance either veto carried: a stale tab that no longer knows the rank must not
 * erase it.
 */
export async function recordPickerVeto(
  db: AntonDb,
  clock: Clock,
  input: RecordVetoInput,
): Promise<PickerVetoOutcome> {
  const nowMs = clock.now();
  return db.transaction(
    (tx) => {
      const accepted = pickAlreadyAnswered(tx, input, "accepted");
      if (accepted) {
        holdContestedVeto(accepted, input, nowMs);
        return { recorded: false, reason: "released" } as const;
      }
      return { recorded: true, deferral: writeDecline(tx, input, nowMs) } as const;
    },
    { behavior: "immediate" },
  );
}

/** Why an accept recorded nothing: the same pick was vetoed, or already accepted. */
export type PickerAcceptRefusal = "vetoed" | "duplicate";

/** What an accept did: the row it filed (so its writer can take it back), or why it filed none. */
export type PickerAcceptOutcome =
  | { recorded: true; id: string }
  | { recorded: false; reason: PickerAcceptRefusal };

/**
 * Record an accept: the operator RELEASED this pick, so anton's choice became a run (anton-d2h6).
 *
 * The mirror of the veto above — same table, same shape, opposite verdict — because earned autonomy
 * weighs accepts against declines, and two stores for one track record would be two answers that can
 * disagree. An accept defers nothing: agreeing with a pick has no window to bound.
 *
 * Idempotent per PICK rather than per click. A release that hits the enqueue dedupe (a double-click,
 * a retry after a slow response) starts no second run, so it must not leave a second accept inflating
 * the evidence a future arming decision reads. The pick is identified by the id of the plan
 * generation it was offered by; a release against no recorded plan has no pick to dedupe on and
 * always records.
 *
 * The dedupe is the INSERT, not a read before it: two overlapping releases of one pick both pass a
 * separate existence check and both write. So the conflict is resolved where it is atomic — against
 * `picker_verdicts_accept_unique`, the partial index over accepted verdicts — and a plan-less
 * accept, which that index leaves unconstrained (NULLs are distinct), still always records.
 *
 * And refused outright when a veto already declined this pick (see {@link pickAlreadyAnswered}). The
 * approve route asks the same question off its pre-write snapshot, but that read cannot see a veto
 * still in flight; this one holds the write lock, so the two verdicts cannot both land. The run is
 * NOT refused with it — the operator asked for it and approve is approve — only the evidence is,
 * which is the half that has to stay consistent.
 *
 * The row's id rides back on success so the caller can WITHDRAW it (see {@link withdrawPickerAccept}).
 * The release reserves its answer before it starts the run — that is what keeps a veto from landing
 * in between — so it needs a way to take the reservation back when no run follows it.
 */
export async function recordPickerAccept(
  db: AntonDb,
  clock: Clock,
  input: RecordAcceptInput,
): Promise<PickerAcceptOutcome> {
  return db.transaction(
    (tx) => {
      if (pickAlreadyAnswered(tx, input, "declined")) {
        return { recorded: false, reason: "vetoed" } as const;
      }
      const id = randomUUID();
      const written = tx
        .insert(schema.pickerVerdicts)
        .values({
          id,
          projectId: input.projectId,
          beadId: input.beadId,
          verdict: "accepted",
          action: "release",
          rule: input.rule ?? null,
          criterion: null,
          rank: input.rank ?? null,
          planId: input.planId ?? null,
          deferredUntil: null,
          decidedAt: secDate(clock.now()),
        })
        .onConflictDoNothing()
        .run();
      return written.changes > 0
        ? ({ recorded: true, id } as const)
        : ({ recorded: false, reason: "duplicate" } as const);
    },
    { behavior: "immediate" },
  );
}

/**
 * Take back an accept whose run never followed it (PR #212 review).
 *
 * The release RESERVES its answer before it enqueues, so a veto racing it cannot slip in between the
 * run starting and the decision being settled. The cost of reserving early is that the run may still
 * fail to start — and an accept for a run that never started is evidence of nothing. So the reserver
 * compensates: it deletes the row it wrote, by id, and only ever that one.
 *
 * And a veto that lost ONLY to that reservation is replayed with it (PR #212 review). The refusal it
 * got said the target was already running; once the run turns out not to exist, the operator is left
 * with no run, no accept and no hold on a pick they refused — so the decline they were denied is
 * filed here instead, in the same transaction, exactly as {@link recordPickerVeto} would have filed
 * it. A veto that lost to an accept whose run DID start stays lost, which is the honest outcome.
 *
 * @returns the hold a replayed veto placed, or undefined when nothing was replayed.
 */
export async function withdrawPickerAccept(
  db: AntonDb,
  id: string,
  clock: Clock,
): Promise<PickerDeferral | undefined> {
  return db.transaction(
    (tx) => {
      tx.delete(schema.pickerVerdicts).where(eq(schema.pickerVerdicts.id, id)).run();
      // Claimed under the write lock, so a veto arriving between the delete and the replay is
      // refused by neither: the accept is already gone, so it records its own decline.
      const contested = contestedVetoes.get(id);
      if (!contested) return undefined;
      contestedVetoes.delete(id);
      return writeDecline(tx, contested.input, clock.now());
    },
    { behavior: "immediate" },
  );
}

/**
 * Every target currently deferred on this project, bead id → expiry (epoch ms).
 *
 * Filtered by the clock rather than by a cleanup pass: an expired row is history, and history is the
 * track record's whole point. A bead vetoed twice keeps the LATER expiry — a second veto extends the
 * window, it never shortens one already running.
 *
 * Only DECLINES are read, stated rather than left to SQL's NULL semantics: an accept defers nothing
 * today, so `deferred_until > now` already skips it — but a future write that put any timestamp on
 * an accept would silently hold that target out of the plan. The verdict is the intent; the expiry
 * is only how long it lasts.
 */
export async function activeDeferrals(
  db: AntonDb,
  projectId: string,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      beadId: schema.pickerVerdicts.beadId,
      deferredUntil: schema.pickerVerdicts.deferredUntil,
    })
    .from(schema.pickerVerdicts)
    .where(
      and(
        eq(schema.pickerVerdicts.projectId, projectId),
        eq(schema.pickerVerdicts.verdict, "declined"),
        gt(schema.pickerVerdicts.deferredUntil, now),
      ),
    );
  const held = new Map<string, number>();
  for (const row of rows) {
    const untilMs = msOf(row.deferredUntil);
    if (untilMs === undefined) continue;
    const current = held.get(row.beadId);
    if (current === undefined || untilMs > current)
      held.set(row.beadId, untilMs);
  }
  return held;
}

/**
 * The picks of ONE plan generation the operator has already answered no to — bead ids carrying a
 * decline against `planId`, expired holds included (PR #212 review).
 *
 * Deliberately not filtered by the clock, unlike {@link activeDeferrals}: what this answers is "has
 * this generation been declined", and a decline does not stop having happened when its window runs
 * out. The expiry is only how long the pacing lasted. `isPlanStale` reads it together with the live
 * holds to retire a generation whose veto no pass ever got to record as an exclusion.
 *
 * Keyed on the plan id, so a decline against an EARLIER generation says nothing about this one — the
 * pass that re-offered the target after the window closed made a new decision, and it takes its own
 * answer.
 */
export async function declinedPicks(
  db: AntonDb,
  projectId: string,
  planId: string,
): Promise<Set<string>> {
  if (!planId) return new Set();
  const rows = await db
    .select({ beadId: schema.pickerVerdicts.beadId })
    .from(schema.pickerVerdicts)
    .where(
      and(
        eq(schema.pickerVerdicts.projectId, projectId),
        eq(schema.pickerVerdicts.verdict, "declined"),
        eq(schema.pickerVerdicts.planId, planId),
      ),
    );
  return new Set(rows.map((row) => row.beadId));
}

/**
 * A freshness token over the deferrals in force — what a polling surface compares to decide whether
 * its copy still describes the board.
 *
 * Over the ACTIVE set, so the token moves on its own when a window closes: an expiry is not a write,
 * and a token keyed on the last write would leave a target drawn as deferred until something else
 * happened to change the board.
 */
export function deferralVersion(held: ReadonlyMap<string, number>): string {
  if (held.size === 0) return "none";
  const lines = [...held]
    .map(([beadId, untilMs]) => `${beadId}@${untilMs}`)
    .sort();
  // Digested rather than listed: the token rides in a poll's query string, and a project whose
  // operator has vetoed freely would otherwise put every bead id in every board request's URL.
  return createHash("sha256")
    .update(lines.join(","))
    .digest("hex")
    .slice(0, 16);
}

/** UI/board read path over the shared anton.db. */
export function latestPickerDeferrals(
  projectId: string,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  return activeDeferrals(getDb(), projectId, now);
}

/** UI/board read path over the shared anton.db. */
export function latestDeclinedPicks(projectId: string, planId: string): Promise<Set<string>> {
  return declinedPicks(getDb(), projectId, planId);
}

/**
 * How many of the picker's picks this operator has accepted and declined — the evidence base a floor
 * on unattended starts reads, exactly as `proposalTrackRecord` serves the gardener's kinds.
 *
 * A rolling window, newest first, for the same reason that one rolls: a picker whose ranking changed
 * must not be judged forever on the record of the ranking it replaced.
 */
export const PICKER_RECORD_WINDOW = 20;

export interface PickerTrackRecord {
  accepted: number;
  declined: number;
  settled: number;
}

export async function pickerTrackRecord(
  db: AntonDb,
  projectId: string,
  window: number = PICKER_RECORD_WINDOW,
): Promise<PickerTrackRecord> {
  const rows = await db
    .select({ verdict: schema.pickerVerdicts.verdict })
    .from(schema.pickerVerdicts)
    .where(eq(schema.pickerVerdicts.projectId, projectId))
    // The id breaks a `decidedAt` tie (PR #212 review): the column is second-resolution, so two
    // verdicts settled in the same second would otherwise leave the window's composition — and the
    // counts read off it — up to SQLite's row order.
    .orderBy(
      desc(schema.pickerVerdicts.decidedAt),
      desc(schema.pickerVerdicts.id),
    )
    .limit(window);
  const accepted = rows.filter((r) => r.verdict === "accepted").length;
  return { accepted, declined: rows.length - accepted, settled: rows.length };
}

/** This project's verdicts, newest first — the audit trail behind the counts above. */
export async function listPickerVerdicts(
  db: AntonDb,
  projectId: string,
  limit: number = PICKER_RECORD_WINDOW,
): Promise<PickerVerdictRow[]> {
  const rows = await db
    .select()
    .from(schema.pickerVerdicts)
    .where(eq(schema.pickerVerdicts.projectId, projectId))
    // Same tiebreaker as the counts above: the audit trail and the window it explains must not
    // disagree about which verdicts are the newest.
    .orderBy(
      desc(schema.pickerVerdicts.decidedAt),
      desc(schema.pickerVerdicts.id),
    )
    .limit(limit);
  return rows.map((row) => ({
    beadId: row.beadId,
    verdict: row.verdict as PickerVerdict,
    action: row.action as PickerVerdictAction,
    ...(row.rule ? { rule: row.rule } : {}),
    ...(row.criterion
      ? { criterion: row.criterion as PolicyCriterionKey }
      : {}),
    ...(typeof row.rank === "number" ? { rank: row.rank } : {}),
    ...(row.planId ? { planId: row.planId } : {}),
    ...(msOf(row.deferredUntil) !== undefined
      ? { deferredUntilMs: msOf(row.deferredUntil)! }
      : {}),
    decidedAtMs: msOf(row.decidedAt) ?? 0,
  }));
}
