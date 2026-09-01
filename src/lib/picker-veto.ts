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
import { and, desc, eq, gt } from "drizzle-orm";
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
 */
function pickAlreadyAnswered(
  tx: Pick<AntonDb, "select">,
  input: { projectId: string; beadId: string; planId?: string },
  verdict: PickerVerdict,
): boolean {
  if (!input.planId) return false;
  return (
    tx
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
      .all().length > 0
  );
}

/**
 * The decline already standing against this pick, when there is one (PR #212 review).
 *
 * A pick gets one DECLINE row, not one per click: two tabs vetoing the same card, or a client
 * retrying after it lost the response, are the same answer restated. Counting them twice would
 * inflate the negative half of the record `pickerTrackRecord` reads and push other decisions out of
 * its rolling window — so the repeat extends the standing decline instead of filing a new one.
 *
 * Keyed on the PICK, like {@link pickAlreadyAnswered}: a plan-less veto answers no recorded decision
 * and has nothing to extend, and a later plan that re-picks the target is a new decision with its
 * own answer.
 */
function standingDecline(
  tx: Pick<AntonDb, "select">,
  input: { projectId: string; beadId: string; planId?: string },
) {
  if (!input.planId) return undefined;
  return tx
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
        eq(schema.pickerVerdicts.planId, input.planId),
        eq(schema.pickerVerdicts.verdict, "declined"),
      ),
    )
    .limit(1)
    .all()[0];
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
 * filing a decline against a decision the operator already took the other side of. A REPEAT veto is
 * allowed — the same answer, not the opposite one — and EXTENDS the standing decline rather than
 * writing a second one (see {@link standingDecline}), keeping the later expiry and whatever
 * provenance either veto carried: a stale tab that no longer knows the rank must not erase it.
 */
export async function recordPickerVeto(
  db: AntonDb,
  clock: Clock,
  input: RecordVetoInput,
): Promise<PickerVetoOutcome> {
  const nowMs = clock.now();
  const untilMs = nowMs + PICKER_DEFER_WINDOW_MS;
  return db.transaction(
    (tx) => {
      if (pickAlreadyAnswered(tx, input, "accepted")) {
        return { recorded: false, reason: "released" } as const;
      }
      const standing = standingDecline(tx, input);
      const heldUntilMs = Math.max(untilMs, standing ? (msOf(standing.deferredUntil) ?? 0) : 0);
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
      return {
        recorded: true,
        deferral: { beadId: input.beadId, untilMs: secDate(heldUntilMs).getTime() },
      } as const;
    },
    { behavior: "immediate" },
  );
}

/** Why an accept recorded nothing: the same pick was vetoed, or already accepted. */
export type PickerAcceptRefusal = "vetoed" | "duplicate";

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
 */
export async function recordPickerAccept(
  db: AntonDb,
  clock: Clock,
  input: RecordAcceptInput,
): Promise<PickerAcceptRefusal | undefined> {
  return db.transaction(
    (tx) => {
      if (pickAlreadyAnswered(tx, input, "declined")) return "vetoed" as const;
      const written = tx
        .insert(schema.pickerVerdicts)
        .values({
          id: randomUUID(),
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
      return written.changes > 0 ? undefined : ("duplicate" as const);
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
    if (current === undefined || untilMs > current) held.set(row.beadId, untilMs);
  }
  return held;
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
  const lines = [...held].map(([beadId, untilMs]) => `${beadId}@${untilMs}`).sort();
  // Digested rather than listed: the token rides in a poll's query string, and a project whose
  // operator has vetoed freely would otherwise put every bead id in every board request's URL.
  return createHash("sha256").update(lines.join(",")).digest("hex").slice(0, 16);
}

/** UI/board read path over the shared anton.db. */
export function latestPickerDeferrals(
  projectId: string,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  return activeDeferrals(getDb(), projectId, now);
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
    .orderBy(desc(schema.pickerVerdicts.decidedAt), desc(schema.pickerVerdicts.id))
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
    .orderBy(desc(schema.pickerVerdicts.decidedAt), desc(schema.pickerVerdicts.id))
    .limit(limit);
  return rows.map((row) => ({
    beadId: row.beadId,
    verdict: row.verdict as PickerVerdict,
    action: row.action as PickerVerdictAction,
    ...(row.rule ? { rule: row.rule } : {}),
    ...(row.criterion ? { criterion: row.criterion as PolicyCriterionKey } : {}),
    ...(typeof row.rank === "number" ? { rank: row.rank } : {}),
    ...(row.planId ? { planId: row.planId } : {}),
    ...(msOf(row.deferredUntil) !== undefined ? { deferredUntilMs: msOf(row.deferredUntil)! } : {}),
    decidedAtMs: msOf(row.decidedAt) ?? 0,
  }));
}
