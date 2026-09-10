/**
 * Founder-facing escalations (anton-wvcy): the durable record that anton asked a human about a
 * stalled run, and what they answered.
 *
 * The unstick pass (jobs/unstick.ts) splits every run-health finding two ways — provably-safe parks
 * auto-resume, everything else lands here. An escalation is deliberately NOT a retry: nothing in
 * anton acts on one, so a stall that needs judgment waits for judgment instead of burning attempts
 * in a loop nobody is watching.
 *
 * Idempotence is the whole contract: re-raising the same finding while its escalation is still open
 * updates nothing and inserts nothing (`escalations_open_unique` + the transactional guard here), so
 * a sweep running hourly over an unchanged stall produces exactly one board item, not one per hour.
 *
 * db-injectable (like runs/run-health) so the sweep and its tests share one connection; the UI read
 * path goes through the shared anton.db.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import { toEpoch } from "./db/epoch";
import type { AntonDb, Clock } from "./jobs/queue";
import type { RunHealthFindingKind } from "./run-health";

export type EscalationStatus = "open" | "resolved";

/**
 * What an escalation can be about: every way a run stalls, plus an autopilot DISARM (R4.6).
 *
 * A disarm is not a stalled run — it is a frozen policy with no run behind it — but it belongs in
 * the same strip for the reason the strip exists: it is work that has stopped and will not restart
 * until a person decides. A disarm that only painted the lane header would be invisible to an
 * operator who scans "Needs you" and nothing else.
 */
export type EscalationKind = RunHealthFindingKind | "autopilot-disarm";

/**
 * What {@link raiseEscalation} needs from whatever detected the stall. A run-health finding
 * satisfies it as it stands; the autopilot breakers supply the same shape with no run, bead or job
 * to point at, and their case in `evidence` instead.
 */
export interface EscalationFinding {
  kind: EscalationKind;
  /** Stable across passes for the same stall, so re-detecting it updates nothing. */
  key: string;
  reason: string;
  /** ms epoch the stall started. */
  since: number;
  ageMs?: number;
  runId?: string;
  beadId?: string;
  jobId?: string;
  prNumber?: number;
  prUrl?: string;
  gateId?: string;
  /** The ticket that raised a `needs-human` ask — where an answer goes (see EscalationView). */
  askBeadId?: string;
  /** One line per run — the case a disarm asks the operator to re-arm (or not) on. */
  evidence?: string[];
}

/**
 * How a founder settled an escalation: retry the work, call it won't-do, or acknowledge a stall
 * anton cannot act on (`dismissed` — see escalation-actions.ts). A dismissal settles the ROW only;
 * the next sweep re-raises the finding if it still holds, so it can't silence a live stall.
 */
export type EscalationResolution = "resumed" | "abandoned" | "dismissed";

/**
 * The verb side of {@link EscalationResolution} — what the founder clicked, before it is recorded as
 * how the row was settled. It lives here rather than with the code that applies it so that every
 * handler taking a verb can name one without importing back through escalation-actions.ts.
 *
 * `restore` is the odd one out: it is the only verb that acts on a row that is already SETTLED, and
 * it records no resolution at all — it takes one away (see {@link restoreEscalation}).
 */
export type EscalationAction = "resume" | "abandon" | "dismiss" | "restore";

export type EscalationRow = typeof schema.escalations.$inferSelect;

/** One escalation as the board renders it — the finding's evidence plus its decision state. */
export interface EscalationView {
  id: string;
  findingKey: string;
  kind: EscalationKind;
  /** Why it's stuck: the park reason, the PR's idle state, the job's last error. */
  reason: string;
  beadId?: string;
  /** The epic a resume re-enqueues — jobs are keyed by epic, not by the ticket that stalled. */
  epicBeadId?: string;
  /**
   * The human gate a `needs-human` wait hangs on — what resolve-and-resume closes (see
   * escalation-gate.ts). Absent on every other kind: nothing else stalls on a gate.
   */
  gateId?: string;
  /**
   * The ticket that raised a `needs-human` ask — the one bead an ANSWER belongs on, which is not
   * `epicBeadId`: a resume re-enqueues the feature, while the notes steering it are read off the
   * child that stopped. Absent on a gate a person hung by hand.
   */
  askBeadId?: string;
  runId?: string;
  jobId?: string;
  prNumber?: number;
  prUrl?: string;
  /** Unix seconds the stall started, so the panel can age it live rather than as of the sweep. */
  since?: number;
  /** How long it had been stuck when the sweep saw it (ms) — the evidence, frozen. */
  ageMs: number;
  /** The detector's case, one line each — printed in full on the kinds that carry one (a disarm). */
  evidence?: string[];
  status: EscalationStatus;
  resolution?: EscalationResolution;
  /** Whether the board-native `bd note` landed on the target bead. */
  noted: boolean;
  /** Unix seconds this escalation was first raised. */
  raisedAt: number;
  /**
   * Unix seconds a HUMAN put this alert down, absent on every other row — including one the sweep
   * itself retired, which records `resolution: "dismissed"` and no stamp (see the column's note).
   * Its presence is what the Dismissed list and the suppression on the raise path both key off.
   */
  dismissedAt?: number;
  /** The stall's identity as it was when dismissed — what a later raise is compared against. */
  signature?: string;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

/** The finding an escalation was raised from, or an empty shell when the blob is unreadable. */
function parseEvidence(json: string): Partial<EscalationFinding> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<EscalationFinding>) : {};
  } catch {
    // A corrupt blob degrades to "no extra evidence" — the row's own columns still carry the
    // reason, target and age, so the escalation stays actionable instead of vanishing.
    return {};
  }
}

export function toEscalationView(row: EscalationRow): EscalationView {
  const evidence = parseEvidence(row.evidenceJson);
  return {
    id: row.id,
    findingKey: row.findingKey,
    kind: row.kind as EscalationKind,
    reason: row.reason,
    beadId: row.beadId ?? undefined,
    epicBeadId: row.epicBeadId ?? undefined,
    // No column of its own: the gate is evidence the detector recorded, like the PR pointers below.
    gateId: typeof evidence.gateId === "string" ? evidence.gateId : undefined,
    askBeadId: typeof evidence.askBeadId === "string" ? evidence.askBeadId : undefined,
    runId: row.runId ?? undefined,
    jobId: row.jobId ?? undefined,
    prNumber: typeof evidence.prNumber === "number" ? evidence.prNumber : undefined,
    prUrl: typeof evidence.prUrl === "string" ? evidence.prUrl : undefined,
    since: toEpoch(row.since),
    ageMs: typeof evidence.ageMs === "number" ? evidence.ageMs : 0,
    evidence: Array.isArray(evidence.evidence)
      ? evidence.evidence.filter((line): line is string => typeof line === "string")
      : undefined,
    status: row.status as EscalationStatus,
    resolution: (row.resolution ?? undefined) as EscalationResolution | undefined,
    noted: row.notedAt != null,
    raisedAt: toEpoch(row.raisedAt) ?? 0,
    dismissedAt: toEpoch(row.dismissedAt) ?? undefined,
    signature: row.signature ?? undefined,
  };
}

/**
 * The rendered ages inside a finding's `reason`, replaced by a placeholder so they can't move the
 * signature (PR #261 review).
 *
 * Four detectors build `reason` around `humanAge(ageMs)` — `run parked 4h: …`, `PR #12 idle 3d …`,
 * `run-lease expired 90m ago …`, `waiting on a human 2h: …` (jobs/run-health.ts) — and that text is
 * a CLOCK, not evidence: an
 * untouched stall re-renders as `4h` then `5h` the moment it crosses an hour boundary. Hashing it
 * raw gave the next sweep a signature the dismissed row could not match, so the alert an operator
 * put down came straight back — the one thing durable dismissal exists to prevent.
 *
 * A normalization rather than a separate stable-evidence field on the finding, because the same
 * function must also run over the `reason` COLUMN when a legacy row's signature is backfilled at
 * dismissal time ({@link signatureFor}), where all that survives of the finding is the rendered
 * text. One rule applied to both keeps a backfilled row hashing identically to the same stall
 * raised fresh.
 *
 * Matches `humanAge`'s whole output shape (`<n>m` / `<n>h` / `<n>d`) wherever it appears, so an
 * error blob quoting its own duration (`timed out after 30m`) is normalized too. That is the safe
 * direction to be wrong in: it makes the signature slightly coarser — one failure whose only
 * difference is a duration reads as the same failure — where the opposite error re-raises a
 * dismissed alert on a tick of the clock.
 */
function withoutRenderedAges(reason: string): string {
  return reason.replace(/\b\d+[mhd]\b/g, "\u0001age");
}

/**
 * The stall's identity, for deciding whether a dismissed alert should stay down (anton-7gxs).
 *
 * `findingKey` is what makes two sweeps over one stall converge on one row; it is NOT enough to
 * hang a dismissal on. An `exhausted-job` key is the job id, and a `parked-run` key is the run id —
 * both survive the failure changing underneath them, so a dismissal keyed on them alone would
 * silence the next, different failure of the same job. The signature folds in the two fields that
 * DO move when the stall changes: why it stopped, and when.
 *
 * Why it stopped is taken age-free ({@link withoutRenderedAges}): the reason string carries a
 * rendered age that ticks on its own, and how long a stall has been stuck is not a way the stall
 * CHANGED. When it started (`since`) is already in the hash and is the honest test for a restart.
 *
 * Hashed rather than stored raw because `reason` is unbounded free text (a park message can carry a
 * whole API error blob), and this column is only ever compared for equality.
 *
 * `since` is rounded to the second, matching how the row itself stores it: a finding re-derived from
 * the same event must hash identically across sweeps, and sub-second drift in a re-read timestamp
 * would otherwise make every raise look like a new stall.
 */
export function escalationSignature(
  finding: Pick<EscalationFinding, "kind" | "key" | "reason" | "since">,
): string {
  const since = Math.floor(finding.since / 1000);
  const reason = withoutRenderedAges(finding.reason);
  return createHash("sha256")
    .update(`${finding.kind}\u0000${finding.key}\u0000${reason}\u0000${since}`)
    .digest("hex")
    .slice(0, 32);
}

export interface RaiseEscalationInput {
  projectId: string;
  finding: EscalationFinding;
  /** The epic a resume would re-enqueue, when the finding names one. */
  epicBeadId?: string;
}

/** What {@link raiseEscalation} did: the row that now covers this finding, and whether it's new. */
export interface RaiseEscalationResult {
  escalation: EscalationRow;
  /** False when an open escalation already covered this finding — the idempotent path. */
  created: boolean;
  /**
   * True when nothing was raised because a human had already dismissed this exact stall
   * (anton-7gxs). Distinct from `created: false` on its own, which means the row is already up and
   * on the board: a suppressed finding has NO row on the board, so the caller must not write a bd
   * note for it or count it as an escalation the operator can see.
   */
  suppressed?: boolean;
}

/**
 * Raise an escalation for a finding, or return the open one that already covers it.
 *
 * The read-then-insert runs in one better-sqlite3 transaction (single synchronous connection, so
 * the pair can't interleave) with `escalations_open_unique` as the DB-level backstop — the same
 * shape as the job queue's dedupe. Two passes racing over the same finding therefore yield ONE
 * open escalation, and the loser reports `created: false` so it doesn't re-write the bd note.
 */
export async function raiseEscalation(
  db: AntonDb,
  clock: Clock,
  input: RaiseEscalationInput,
): Promise<RaiseEscalationResult> {
  const { projectId, finding } = input;
  const nowMs = clock.now();
  const signature = escalationSignature(finding);

  const openRow = (tx: Pick<AntonDb, "select">) =>
    tx
      .select()
      .from(schema.escalations)
      .where(
        and(
          eq(schema.escalations.projectId, projectId),
          eq(schema.escalations.findingKey, finding.key),
          eq(schema.escalations.status, "open"),
        ),
      )
      .limit(1)
      .all()[0];

  /**
   * A human's standing "not this one" for this exact stall. Matched on the SIGNATURE, not the key:
   * the same job failing a new way is a new stall and comes back, which is the whole reason the
   * signature exists. Read inside the same transaction as the open-row check so a dismissal landing
   * mid-sweep can't be straddled.
   */
  const dismissedRow = (tx: Pick<AntonDb, "select">) =>
    tx
      .select()
      .from(schema.escalations)
      .where(
        and(
          eq(schema.escalations.projectId, projectId),
          eq(schema.escalations.findingKey, finding.key),
          eq(schema.escalations.signature, signature),
          isNotNull(schema.escalations.dismissedAt),
        ),
      )
      .limit(1)
      .all()[0];

  try {
    return db.transaction((tx) => {
      const existing = openRow(tx);
      if (existing) return { escalation: existing, created: false };
      // Ordered after the open check on purpose: a row that is UP outranks a row that was put down,
      // so a stall re-raised and then dismissed and then re-raised again reports the live row.
      const dismissed = dismissedRow(tx);
      if (dismissed) return { escalation: dismissed, created: false, suppressed: true };

      const inserted = tx
        .insert(schema.escalations)
        .values({
          id: randomUUID(),
          projectId,
          findingKey: finding.key,
          kind: finding.kind,
          reason: finding.reason,
          beadId: finding.beadId,
          epicBeadId: input.epicBeadId,
          runId: finding.runId,
          jobId: finding.jobId,
          since: secDate(finding.since),
          evidenceJson: JSON.stringify(finding),
          status: "open",
          signature,
          raisedAt: secDate(nowMs),
          updatedAt: secDate(nowMs),
        })
        .returning()
        .all()[0]!;
      return { escalation: inserted, created: true };
    });
  } catch (e) {
    // Backstop: the partial index rejected a concurrent insert. The winner now covers this finding.
    const winner = openRow(db);
    if (winner) return { escalation: winner, created: false };
    throw e;
  }
}

/** Stamp that the board-native `bd note` landed, so later passes stop retrying it. */
export async function markEscalationNoted(
  db: AntonDb,
  clock: Clock,
  id: string,
): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.escalations)
    .set({ notedAt: secDate(nowMs), updatedAt: secDate(nowMs) })
    .where(eq(schema.escalations.id, id));
}

/** A project's open escalations, newest stall first. db-injectable; read-only. */
export async function listOpenEscalations(
  db: AntonDb,
  projectId: string,
): Promise<EscalationRow[]> {
  return db
    .select()
    .from(schema.escalations)
    .where(
      and(eq(schema.escalations.projectId, projectId), eq(schema.escalations.status, "open")),
    )
    .orderBy(desc(schema.escalations.raisedAt));
}

/** One escalation, scoped to its project so a route can't settle another project's item by id. */
export async function getEscalation(
  db: AntonDb,
  projectId: string,
  id: string,
): Promise<EscalationRow | undefined> {
  const rows = await db
    .select()
    .from(schema.escalations)
    .where(and(eq(schema.escalations.projectId, projectId), eq(schema.escalations.id, id)))
    .limit(1);
  return rows[0];
}

/**
 * Settle an escalation. The status guard lives in the UPDATE's WHERE so two clicks on the same
 * item can't both "win": the second updates zero rows and reports false, which is what stops a
 * double-click from resuming a run twice.
 *
 * `byHuman` stamps `dismissedAt`, and ONLY a person's click ever passes it: that stamp is what
 * suppresses the next raise of this stall, and the sweep's own retirement path settles as
 * `dismissed` too (see `settleEndedStalls`) while meaning the exact opposite — "this is over", not
 * "stop telling me". Defaulting it off keeps every existing caller honest by construction.
 */
export async function settleEscalation(
  db: AntonDb,
  clock: Clock,
  id: string,
  resolution: EscalationResolution,
  byHuman = false,
): Promise<boolean> {
  const nowMs = clock.now();
  const rows = await db
    .update(schema.escalations)
    .set({
      status: "resolved",
      resolution,
      updatedAt: secDate(nowMs),
      ...(byHuman ? { dismissedAt: secDate(nowMs), signature: await signatureFor(db, id) } : {}),
    })
    .where(and(eq(schema.escalations.id, id), eq(schema.escalations.status, "open")))
    .returning({ id: schema.escalations.id });
  return rows.length > 0;
}

/**
 * The signature to stamp on a row being dismissed — its own, or one derived now if it has none.
 *
 * A row raised before this column existed carries NULL, and a NULL never matches, so dismissing one
 * would settle it and change nothing about the next sweep. That is not an edge case: the storm that
 * motivated durable dismissal is sitting on the board of every install that upgrades into it, and a
 * feature that works for every future alert but none of the current ones is a feature that appears
 * broken on the day it ships.
 *
 * So it is backfilled at DISMISSAL time rather than by a migration. The migration has no hash
 * function to compute one with (sqlite ships no sha256), and there is nothing to gain from stamping
 * rows nobody has put down — the signature only ever matters to a row a person dismissed.
 *
 * Derived from the row's own columns, which are exactly what the finding was raised from: the
 * seconds-resolution `since` matches the flooring {@link escalationSignature} applies, so a
 * backfilled row hashes identically to the same stall raised fresh. A row with no `since` at all
 * keeps its NULL and simply doesn't suppress — the honest outcome when there is nothing to compare.
 */
async function signatureFor(db: AntonDb, id: string): Promise<string | null> {
  const rows = await db
    .select({
      kind: schema.escalations.kind,
      findingKey: schema.escalations.findingKey,
      reason: schema.escalations.reason,
      since: schema.escalations.since,
      signature: schema.escalations.signature,
    })
    .from(schema.escalations)
    .where(eq(schema.escalations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.signature) return row.signature;
  const since = toEpoch(row.since);
  if (since === undefined) return null;
  return escalationSignature({
    kind: row.kind as EscalationKind,
    key: row.findingKey,
    reason: row.reason,
    since: since * 1000,
  });
}

/**
 * Pick a dismissed alert back up (anton-7gxs): clear the stamp and put the row back on the list.
 *
 * Refused — as a no-op reporting `false` — when an open row already covers the same finding. The
 * partial `escalations_open_unique` index would reject the write anyway; refusing here makes it a
 * quiet "already back" rather than a 500, which is the honest answer when the sweep re-raised the
 * stall after a dismissal was restored elsewhere.
 *
 * The resolution is cleared with the stamp: a restored row is not "dismissed" any more, and leaving
 * the word there would leave the Dismissed list and the open list disagreeing about one row.
 */
export async function restoreEscalation(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  id: string,
): Promise<boolean> {
  const nowMs = clock.now();
  const row = await getEscalation(db, projectId, id);
  if (!row || row.dismissedAt == null) return false;

  const live = await db
    .select({ id: schema.escalations.id })
    .from(schema.escalations)
    .where(
      and(
        eq(schema.escalations.projectId, projectId),
        eq(schema.escalations.findingKey, row.findingKey),
        eq(schema.escalations.status, "open"),
      ),
    )
    .limit(1);
  if (live.length > 0) return false;

  const rows = await db
    .update(schema.escalations)
    .set({ status: "open", resolution: null, dismissedAt: null, updatedAt: secDate(nowMs) })
    .where(and(eq(schema.escalations.id, id), isNotNull(schema.escalations.dismissedAt)))
    .returning({ id: schema.escalations.id });
  return rows.length > 0;
}

/**
 * The alerts a human put down, newest dismissal first. db-injectable; read-only.
 *
 * Bounded, unlike {@link listOpenEscalations}: this list is a record of decisions rather than a
 * queue, and a project that has dismissed a thousand storms should not render a thousand rows to
 * say so. The newest are the ones a founder might want back.
 */
export async function listDismissedEscalations(
  db: AntonDb,
  projectId: string,
  limit = DISMISSED_LIMIT,
): Promise<EscalationRow[]> {
  return db
    .select()
    .from(schema.escalations)
    .where(
      and(
        eq(schema.escalations.projectId, projectId),
        isNotNull(schema.escalations.dismissedAt),
      ),
    )
    .orderBy(desc(schema.escalations.dismissedAt))
    .limit(limit);
}

/** How many dismissed alerts the Health page's disclosure will show. */
export const DISMISSED_LIMIT = 50;

/** UI read path over the shared anton.db — the board panel's source. */
export async function openEscalations(projectId: string): Promise<EscalationView[]> {
  return (await listOpenEscalations(getDb(), projectId)).map(toEscalationView);
}

/** UI read path for the Health page's Dismissed disclosure. */
export async function dismissedEscalations(projectId: string): Promise<EscalationView[]> {
  return (await listDismissedEscalations(getDb(), projectId)).map(toEscalationView);
}
