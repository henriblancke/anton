/**
 * THE DECISION LOG (anton-q5ixf): write every decide() call down, learn later what the operator did
 * about the same question, and fold the settled pairs into one number per point.
 *
 * This is what makes shadow mode worth running. A point in shadow computes exactly the answer `auto`
 * would have acted on and then acts on nothing (decide/index.ts), so the only evidence it ever
 * produces is the comparison between that answer and the operator's own — and that comparison only
 * exists if both halves are recorded. {@link recordDecision} writes the first half at decision time;
 * {@link settleDecision} writes the second whenever the operator's answer becomes known, which is
 * usually a different request and sometimes a different day. {@link agreement} is the fold.
 *
 * Three rules the fold has to get right, or it inverts:
 *
 *   • AN UNSETTLED ROW IS NOT A DISAGREEMENT. Most rows are unsettled at any moment — nobody has
 *     answered yet. Counting them would drive every point's agreement toward zero as it is used.
 *   • NO ANSWER IS NOT AN ANSWER. A row decide() produced no answer for (`off`, or a fallback to a
 *     human) settles nothing about the point's judgment: a backend that times out all week is a
 *     broken backend, not a point that disagrees with its operator. Such rows are excluded in the
 *     QUERY, before the window applies, for the reason `pickerTrackRecord` narrows in its own — a
 *     point whose backend was down through a whole window would otherwise fetch nothing but
 *     answerless rows, filter them all away, and report an EMPTY record over a log that has real
 *     pairs to weigh one row past the limit.
 *   • THE WINDOW ROLLS. Only the newest {@link DECISION_AGREEMENT_WINDOW} settled rows count, so a
 *     point re-pointed at a new backend or a new model is not judged forever by the record of the one
 *     it replaced.
 *
 * db-injectable, like `picker-veto` and `escalations`: a job and its tests share one connection, and
 * the UI read path goes through the shared anton.db.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { toEpoch } from "../db/epoch";
import type { AntonDb, Clock } from "../jobs/queue";
import { isValidAnswer, type DecideResult } from "./index";
import { narrowState, type AnswerValue, type DecisionPoint, type DecisionState } from "./points";

/**
 * How many settled decisions a point's agreement is measured over.
 *
 * Thirty, matching `EARNED_AUTONOMY_WINDOW`: the same question is being asked (has this judgment
 * earned the operator's trust lately), so the two surfaces should not disagree about how much
 * "lately" is. Big enough that a single disagreement does not swing the figure, small enough that a
 * point fixed last week can show it.
 */
export const DECISION_AGREEMENT_WINDOW = 30;

/**
 * A digest of the state a point actually sent — narrowed by the point's own `stateFields` first, so
 * the log never carries a claim about state the backend did not see ({@link narrowState}).
 *
 * Hashed rather than stored: the inputs are unbounded untrusted text (a PR comment, a bead body), and
 * the column is only ever compared for equality — two decisions over the same input, or a re-decision
 * after the input moved.
 *
 * Key order is sorted before hashing, because a point's `stateFields` order is a declaration detail
 * and an object's own key order is an accident of how a caller built it: the same inputs must digest
 * identically either way, or a re-decision over unchanged state would look like a new input. Values
 * go through `JSON.stringify`, and a value that cannot be encoded (a cycle, a BigInt) is recorded as
 * the marker `\u0000unencodable` rather than throwing — a log write must not be the thing that fails a
 * decision, and an input nobody can serialize is still an input that differs from an absent one.
 */
export function decisionInputHash(point: DecisionPoint, state: DecisionState): string {
  const narrowed = narrowState(point, state);
  const hash = createHash("sha256");
  for (const key of Object.keys(narrowed).sort()) {
    hash.update(`${key}\u0000${encodeValue(narrowed[key])}\u0000`);
  }
  return hash.digest("hex").slice(0, 32);
}

/** A declared field the caller's state never set (`narrowState` inserts `undefined` for it, and
 * `buildPrompt`'s own `JSON.stringify` in claude-local.ts drops it from the prompt entirely) must
 * digest differently from an explicit `null` — the backend DOES see the latter. `JSON.stringify`
 * collapses both to the same string otherwise (it returns `undefined`, the JS value, for `undefined`
 * itself), so `undefined` is caught up front rather than left to fall through. */
function encodeValue(value: unknown): string {
  if (value === undefined) return "\u0000missing";
  try {
    return JSON.stringify(value) ?? "\u0000missing";
  } catch {
    return "\u0000unencodable";
  }
}

/**
 * An answer as the log stores it: JSON, so the three question shapes round-trip through one column
 * and agreement can compare them as plain string equality. `1` and `"1"` are different answers and
 * must never read as the same one — which is exactly what storing the raw value as text would do.
 */
function encodeAnswer(value: AnswerValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeAnswer(encoded: string | null): AnswerValue | undefined {
  if (encoded === null) return undefined;
  try {
    return JSON.parse(encoded) as AnswerValue;
  } catch {
    return undefined;
  }
}

/**
 * The next `settle_seq` value, computed as MAX+1 in the same statement — the same pattern
 * `nextWriteSeq` (runs.ts) uses for `runs.writeSeq`, and for the same reason: a plain read-then-write
 * from application code races two settles landing in the same tick, while a subquery inside the
 * UPDATE itself is one atomic statement.
 */
function nextSettleSeq() {
  return sql`(SELECT IFNULL(MAX(w.settle_seq), 0) + 1 FROM decisions w)`;
}

export interface RecordDecisionInput {
  /** The decision as decide() produced it — every field of the log's first half comes from here. */
  result: DecideResult;
  /** The point that produced it, needed to narrow the state before hashing it. */
  point: DecisionPoint;
  /** The FULL caller state; only the point's own `stateFields` reach the digest. */
  state: DecisionState;
  projectId?: string;
}

/**
 * Write the decision half of a row and return its id — the handle a later settle needs.
 *
 * Best-effort by contract, like `recordInvocation`: it NEVER throws, and returns `undefined` when
 * nothing was written. A decision that was made and acted on must not fail because the log could not
 * be written, and the caller is already past the point of no return by the time it gets here. A
 * missing row loses one sample, which reads as "not measured" — never as a disagreement.
 *
 * `result.point` is checked against `point.id` before the insert: `RecordDecisionInput` does not
 * type-link the two, and a caller that mismatches them would store the row under the wrong point
 * while hashing the right one's state — a later `settleDecision` keyed on the correct point would
 * then refuse to match it, leaving the row permanently unsettled (PR #332 review). Treated as a
 * failed write, not thrown: the contract above is "never throws", and a caller bug here is no less
 * a reason to skip the write than a failed insert is.
 */
export async function recordDecision(
  db: AntonDb,
  clock: Clock,
  input: RecordDecisionInput,
): Promise<string | undefined> {
  const { result, point, state, projectId } = input;
  if (result.point !== point.id) return undefined;
  try {
    const id = randomUUID();
    await db.insert(schema.decisions).values({
      id,
      projectId: projectId ?? null,
      point: result.point,
      mode: result.mode,
      decidedBy: result.decidedBy,
      answer: encodeAnswer(result.answer),
      confidence: result.confidence,
      distribution: result.distribution ? JSON.stringify(result.distribution) : null,
      backend: result.backend ?? null,
      modelVersion: result.modelVersion ?? null,
      inputHash: decisionInputHash(point, state),
      acted: result.acted,
      reason: result.reason ?? null,
      decidedAt: secDate(clock.now()),
    });
    return id;
  } catch {
    // Swallowed on purpose — see the contract above.
    return undefined;
  }
}

export interface SettleDecisionInput {
  /** The point being settled, needed to validate `operatorAnswer` against its own question shape
   * before it is trusted as evidence. */
  point: DecisionPoint;
  /** What the operator's answer turned out to be, in the point's own answer vocabulary. */
  operatorAnswer: AnswerValue;
  /** The affordance that produced it (`fix`, `park`, `release`) — recorded, never counted. */
  operatorAction?: string;
  /** How it turned out, when that is already known. Settable later via {@link recordDecisionOutcome}. */
  outcome?: string;
}

/**
 * Record what the operator answered the same question — the half that makes a row evidence.
 *
 * The unsettled guard lives in the UPDATE's WHERE, like `settleEscalation`'s status guard: a row
 * carries ONE operator answer, so a second settle of the same decision updates zero rows and reports
 * false rather than overwriting the first. That is the honest reading of a double-click, and of a
 * retry of a request that already landed.
 *
 * `operatorAnswer` is checked against `input.point.question` with the same {@link isValidAnswer}
 * decide() itself trusts a model's answer through, and BEFORE the update runs: settlement is
 * first-write-wins, so a typo (`"fixed"` for `"fix"`) or an answer lifted from a different question
 * would otherwise stamp `settledAt` permanently and read as a disagreement in {@link agreement}
 * forever after, with no way to correct it (PR #332 review).
 *
 * The WHERE also pins `point` to `input.point.id`, not just `id`: validating `operatorAnswer`
 * above only proves it fits `input.point`'s own question shape, so a caller passing an `id` that
 * belongs to a different point would otherwise settle THAT row against the wrong point's answer —
 * again permanent, again unfixable once `agreement()` has counted it (PR #332 review).
 *
 * Unlike {@link recordDecision} this does NOT swallow: a settle is the operator's own act, and a
 * caller that asked whether it landed must be able to tell "already settled" (false) from "the write
 * failed" (a throw). Collapsing the two would let a route report success over a lost answer. An
 * invalid answer is the same kind of caller bug and throws for the same reason.
 */
export async function settleDecision(
  db: AntonDb,
  clock: Clock,
  id: string,
  input: SettleDecisionInput,
): Promise<boolean> {
  if (!isValidAnswer(input.point.question, input.operatorAnswer)) {
    throw new Error(
      `decide: "${input.point.id}" cannot settle with ${JSON.stringify(input.operatorAnswer)} — not a valid answer to its own question`,
    );
  }
  const rows = await db
    .update(schema.decisions)
    .set({
      operatorAnswer: JSON.stringify(input.operatorAnswer),
      operatorAction: input.operatorAction ?? null,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      settledAt: secDate(clock.now()),
      settleSeq: nextSettleSeq(),
    })
    .where(
      and(
        eq(schema.decisions.id, id),
        eq(schema.decisions.point, input.point.id),
        isNull(schema.decisions.settledAt),
      ),
    )
    .returning({ id: schema.decisions.id });
  return rows.length > 0;
}

/**
 * Record how a settled decision turned out, after the fact.
 *
 * Separate from the settle because it is knowable LATER: the operator picks `fix`, and whether that
 * fix held is a different observation, sometimes days apart. Refuses an UNSETTLED row (reporting
 * false) — an outcome with no operator answer beside it explains nothing, and writing one would leave
 * the log claiming a result for a question nobody answered.
 */
export async function recordDecisionOutcome(
  db: AntonDb,
  id: string,
  outcome: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.decisions)
    .set({ outcome })
    .where(and(eq(schema.decisions.id, id), isNotNull(schema.decisions.settledAt)))
    .returning({ id: schema.decisions.id });
  return rows.length > 0;
}

/** What a point has earned: how many settled decisions it has, and how many the operator matched. */
export interface DecisionAgreement {
  point: string;
  /** Settled rows carrying a real answer, within the window — the denominator. */
  settled: number;
  /** Of those, how many the operator's own answer matched exactly. */
  agreed: number;
}

/**
 * A row is evidence only if decide() answered at all. An answerless row (`off`, or a fallback to a
 * human) says nothing about the point's judgment, so it is dropped in the query rather than filtered
 * afterwards — see the header for why that distinction decides whether a broken backend reads as a
 * point that disagrees.
 */
const isJudgmentEvidence = and(
  isNotNull(schema.decisions.settledAt),
  isNotNull(schema.decisions.answer),
);

/**
 * How often this point's answer matched the operator's, over the rolling window.
 *
 * Compared as encoded JSON rather than raw string equality, so a `score` point answering `1` and an
 * operator answering `"1"` would disagree instead of reading as the same value. Belt-and-suspenders
 * today: `settleDecision`'s own {@link isValidAnswer} check already keeps a `"1"` from ever reaching
 * `operatorAnswer` for a `score` point, since decide()'s `answer` is validated the same way — but the
 * encoded comparison stays the honest one to make regardless.
 *
 * Scoped to `projectId` when given, since the same point runs across every project: without it, one
 * project's successes or failures bleed into another's figure and can encourage a promotion to `auto`
 * that this project's own history never earned.
 *
 * Also scoped to the CURRENT backend/model version: a row records both specifically to pin trust to
 * the model that earned it, so a point re-pointed at a new backend or model must be judged only on
 * what that one has produced, never on its predecessor's record. The cohort pair is read off the
 * newest MODEL-ATTRIBUTED row that also carries a `modelVersion` (not just `backend`) regardless of
 * settlement OR answer validity — a model that just took over may have produced only unsettled
 * decisions yet, and gating this lookup on `isJudgmentEvidence` too would keep reading the
 * predecessor's backend/model as "current" for the whole window it takes the first new decision to
 * settle, which is exactly the stale-agreement window a promotion to `auto` must not be based on.
 * Requiring a non-null `answer` here has the same effect for a replacement model that is failing
 * every call: `decide()` still attributes the attempt (`backend`/`modelVersion`) to an invalid
 * answer, but the row's `answer` stays null, and gating on it would keep the predecessor as
 * "current" for as long as the replacement keeps failing (PR #332 review) — the one case where
 * "current" most needs to reflect what is actually running. But a driver-level failure BEFORE any
 * model is identified (timeout, abort, stall — claude-local.ts's outer `catch`) attributes only
 * `backend`, never `modelVersion`; such a row is excluded from the cohort candidates entirely
 * rather than read as "the current cohort has no model", because the latter makes `cohortFilter`
 * `undefined` below and drops cohort scoping altogether, folding every predecessor model's
 * settled rows back in — exactly the cross-model bleed this scoping exists to prevent (PR #332
 * review). A hard rule has neither backend nor model (it is deterministic, not model trust), so
 * rule-produced rows are kept as evidence unconditionally — unscoped by cohort, never filtered
 * out — while model-produced rows are still restricted to the current cohort; reading the cohort
 * off the newest row of any kind would let an exceptional rule hit go unscoped instead and fold in
 * a predecessor model's whole history.
 */
export async function agreement(
  db: AntonDb,
  point: string,
  window: number = DECISION_AGREEMENT_WINDOW,
  projectId?: string,
): Promise<DecisionAgreement> {
  const pointScope = and(
    eq(schema.decisions.point, point),
    projectId === undefined ? undefined : eq(schema.decisions.projectId, projectId),
  );
  const scope = and(pointScope, isJudgmentEvidence);
  // `decidedAt`/`settledAt` are whole-second values (`secDate`), so two decisions logged in the
  // same second need a tiebreaker with real ordering. `id` is a `randomUUID()` — no chronological
  // meaning at all. `rowid` tracks INSERT order, which is the right proxy for a `decidedAt` tie
  // (the decision half is written once, at insert) but the wrong one for a `settledAt` tie: the
  // operator can settle two rows in the REVERSE of their insertion order, and a rowid tiebreak would
  // then call the earlier-inserted row "newest" even though it settled last — retaining the wrong
  // answer in a limited agreement window (PR #332 review). `settleSeq` is stamped at settle time
  // (`nextSettleSeq`), so it orders by settlement itself; `rowid` remains the fallback for rows
  // settled before that column existed.
  const rowidDesc = desc(sql`rowid`);
  const orderNewestFirst = [
    desc(schema.decisions.settledAt),
    desc(schema.decisions.settleSeq),
    rowidDesc,
  ] as const;

  // A hard rule's answer carries neither `backend` nor `modelVersion` (it is deterministic, not
  // model trust). If the newest answer is a rule hit, the newest-answered row overall is that
  // all-null row — but the cohort a MODEL-produced answer must be judged against is still
  // whichever model most recently answered, not "unscoped". Reading the cohort off the newest
  // MODEL-attributed row specifically (rather than the newest answered row of any kind, which a
  // rule hit can null out) keeps that pinned even when a rule interleaves; the query below then
  // keeps every rule row as evidence regardless of cohort, since a rule owes no model any credit
  // or blame, and restricts model rows to that cohort alone.
  const [modelCohort] = await db
    .select({ backend: schema.decisions.backend, modelVersion: schema.decisions.modelVersion })
    .from(schema.decisions)
    .where(
      and(
        pointScope,
        isNotNull(schema.decisions.backend),
        isNotNull(schema.decisions.modelVersion),
      ),
    )
    .orderBy(desc(schema.decisions.decidedAt), rowidDesc)
    .limit(1);

  const cohortFilter = modelCohort?.backend && modelCohort.modelVersion
    ? or(
        and(isNull(schema.decisions.backend), isNull(schema.decisions.modelVersion)),
        and(
          eq(schema.decisions.backend, modelCohort.backend),
          eq(schema.decisions.modelVersion, modelCohort.modelVersion),
        ),
      )
    : undefined;

  const rows = await db
    .select({
      answer: schema.decisions.answer,
      operatorAnswer: schema.decisions.operatorAnswer,
    })
    .from(schema.decisions)
    .where(and(scope, cohortFilter))
    .orderBy(...orderNewestFirst)
    .limit(window);
  const agreed = rows.filter((row) => row.answer === row.operatorAnswer).length;
  return { point, settled: rows.length, agreed };
}

export type DecisionRow = typeof schema.decisions.$inferSelect;

/** One logged decision, with its answers decoded back into the vocabulary callers speak. */
export interface DecisionView {
  id: string;
  point: string;
  mode: string;
  decidedBy: string;
  answer?: AnswerValue;
  confidence: number;
  distribution?: Record<string, number>;
  backend?: string;
  modelVersion?: string;
  inputHash: string;
  acted: boolean;
  reason?: string;
  decidedAtMs: number;
  operatorAnswer?: AnswerValue;
  operatorAction?: string;
  outcome?: string;
  settledAtMs?: number;
}

export function toDecisionView(row: DecisionRow): DecisionView {
  const decidedAt = toEpoch(row.decidedAt);
  const settledAt = toEpoch(row.settledAt);
  const answer = decodeAnswer(row.answer);
  const operatorAnswer = decodeAnswer(row.operatorAnswer);
  return {
    id: row.id,
    point: row.point,
    mode: row.mode,
    decidedBy: row.decidedBy,
    ...(answer === undefined ? {} : { answer }),
    confidence: row.confidence,
    ...(row.distribution ? { distribution: parseDistribution(row.distribution) } : {}),
    ...(row.backend ? { backend: row.backend } : {}),
    ...(row.modelVersion ? { modelVersion: row.modelVersion } : {}),
    inputHash: row.inputHash,
    acted: row.acted,
    ...(row.reason ? { reason: row.reason } : {}),
    decidedAtMs: (decidedAt ?? 0) * 1000,
    ...(operatorAnswer === undefined ? {} : { operatorAnswer }),
    ...(row.operatorAction ? { operatorAction: row.operatorAction } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(settledAt === undefined ? {} : { settledAtMs: settledAt * 1000 }),
  };
}

function parseDistribution(encoded: string): Record<string, number> | undefined {
  try {
    return JSON.parse(encoded) as Record<string, number>;
  } catch {
    return undefined;
  }
}

/**
 * This point's decisions, newest first — the audit trail behind the agreement figure. Ordered on the
 * same tiebreaker for the same reason: the trail and the number it explains must not disagree about
 * which decisions are the newest.
 */
export async function listDecisions(
  db: AntonDb,
  point: string,
  limit: number = DECISION_AGREEMENT_WINDOW,
): Promise<DecisionView[]> {
  const rows = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.point, point))
    .orderBy(desc(schema.decisions.decidedAt), desc(sql`rowid`))
    .limit(limit);
  return rows.map(toDecisionView);
}

/** UI read path over the shared anton.db — the figure a Settings row shows per point, scoped to the
 * project asking so it never shows another project's successes or failures. */
export function latestAgreement(point: string, projectId?: string): Promise<DecisionAgreement> {
  return agreement(getDb(), point, DECISION_AGREEMENT_WINDOW, projectId);
}

/** UI read path over the shared anton.db. */
export function latestDecisions(point: string, limit?: number): Promise<DecisionView[]> {
  return listDecisions(getDb(), point, limit);
}

/** The timestamp columns store seconds as a Date; match the rest of the lib layer's truncation. */
function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}
