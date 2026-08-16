/**
 * APPLY-ON-APPROVE (anton-1t3n): the half of the gardener that changes the board. A proposal that
 * nobody can act on is a report line with extra steps, so this is where approval stops being a label
 * and becomes `bd update --parent` / `bd link` / `bd supersede` / `bd close --reason` / `bd defer`.
 *
 * Three properties carry the module, and each answers a way apply could do harm:
 *
 *   • THE PLAN IS DATA, NOT PROSE. The move rides on the proposal bead as metadata, written in the
 *     same `bd create` (see emit.ts). Nothing here parses a description: a human is free to edit the
 *     ask's wording, and an apply that re-derived the move from that wording would mutate beads the
 *     approver never read about.
 *   • THE BOARD DECIDES, NOT THE PLAN. Every precondition is re-checked against a FRESH board read
 *     at approve time, because a proposal filed last night describes a board that has since moved.
 *     That includes the bar every detector proposes under — work a run owns is off limits — since
 *     the run that now holds the bead usually started AFTER the proposal was filed. Stale plans
 *     refuse loudly; a board that already reads as applied SETTLES the proposal instead of writing
 *     again — re-confirmed under the affected beads' own locks, because that path runs no step and
 *     so has nothing else to re-read them — and a retry after a half-finished approve therefore
 *     converges rather than double-moves. And
 *     because a snapshot is stale the instant it is taken, every bead a write rests on — the subject,
 *     the home/blocker/survivor it points at, and the run target whose ticket set a retirement would
 *     take it out of — is re-read and re-judged under its own write lock
 *     immediately before the write, on the same lock a run's claim takes (see apply-steps.ts
 *     `applyStep`), so a lease published mid-approval orders against this apply instead of racing
 *     it. A fresh read is not the whole answer either: it shows the board as it IS, never as it
 *     MOVED. So the two facts it cannot express — that the bead's claim is the one the plan was made
 *     about, and that a `stale` subject really has stayed silent — are settled against the
 *     PROPOSAL's own filing stamp, the one filing-time fact bd already keeps and no hand-edited plan
 *     can rewrite.
 *   • NO PARTIAL SILENT STATE. The only multi-write move is a cluster re-parent, and its steps carry
 *     their own undo: a failure part-way rolls the applied prefix back and leaves the proposal OPEN
 *     with the error attached as a note. Applying a proposal is serialized on the PROPOSAL's own
 *     lock for the same reason, so a second approve can't be part-way through the same steps while
 *     this one rolls them back or declares them done. What a reader must never find is a board
 *     half-moved and a proposal reading as done.
 *
 * Declining is the other half of the loop and needs no store of its own: a declined proposal is an
 * ABANDONED bead (closed + `abandoned`) still carrying its fingerprint label, which is exactly what
 * emission already suppresses on (see emit.ts `suppressedFingerprints`). The board is the memory.
 *
 * The module reads as composition (anton-ni1j): the DECISION lives in apply-plan.ts, the WRITES in
 * apply-steps.ts, and this file is what locks the proposal, asks the one for the other, and settles.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLock, withBeadWriteLocks } from "../beads/claim-lock";
import { notePrefix, planApply, type ApplyMoment, type ApplyStep } from "./apply-plan";
import {
  applyStep,
  messageOf,
  oneLine,
  readWholeBoard,
  rollbackSteps,
  SubjectMovedError,
} from "./apply-steps";
import {
  fingerprintLabelOf,
  GARDENER_OBSERVED_AT_KEY,
  isProposalBead,
  proposalPlanOf,
  type GardenerPlan,
} from "./detections";

export { planApply } from "./apply-plan";
export type { ApplyDecision, ApplyMoment, ApplyStep } from "./apply-plan";

/** Why a proposal could not be applied — mapped to a status by the route, never swallowed. */
export type ApplyFailure =
  /** The bead is not an applicable proposal (not one at all, no readable plan, already settled). */
  | "unusable"
  /** Preconditions no longer hold. Nothing was written; a human re-decides. */
  | "refused"
  /**
   * A bd write failed mid-flight. Whatever landed was rolled back — EXCEPT when what failed was the
   * SETTLEMENT, which runs after every step and has nothing left to undo them with (see
   * {@link settleProposal}); there the writes stand and ride on the error's `changed`. The proposal
   * stays open either way.
   */
  | "failed";

export class ProposalApplyError extends Error {
  constructor(
    readonly failure: ApplyFailure,
    message: string,
    /**
     * The board writes this failure LEFT STANDING, so a caller can record what actually moved.
     * Non-empty for exactly one failure — a settlement that broke after its steps landed — because
     * every other one either wrote nothing or rolled back what it wrote.
     */
    readonly changed: string[] = [],
  ) {
    super(message);
    this.name = "ProposalApplyError";
  }
}

export interface ApplyResult {
  proposalId: string;
  plan: GardenerPlan;
  /** One line naming what changed — the proposal's close reason and its closing note. */
  summary: string;
  /** The beads this apply actually wrote to. Empty when the board already read as applied. */
  changed: string[];
}

/**
 * WHO applied a proposal (anton-4ab3) — the one thing an unattended write owes a reader that an
 * approve does not.
 *
 * `approval` is a human on the approve route: somebody read the ask and said yes. `policy` is a
 * scheduled pass writing under the project's proposal autonomy (anton-nbyy): nobody was asked. The
 * two leave the same board move and are not the same event, so the note says which one this was —
 * a founder who finds a bead moved overnight must be able to tell "I approved this last week" from
 * "the policy I set does this".
 */
export type ApplyActor = "approval" | "policy";

/**
 * Apply an approved proposal and close it with a note of what changed.
 *
 * `board` is the caller's FRESH `--status all` read (the approve route forces one before it decides
 * anything; the armed pass takes one per proposal): every precondition is judged against it, so a
 * proposal filed against a board that has since moved refuses instead of acting on last night's
 * picture.
 *
 * Throws {@link ProposalApplyError} on every failure — and attaches the reason to the proposal as a
 * note first, so the bead a human comes back to says why it is still open. The one thing this never
 * does is close a proposal whose move did not land.
 *
 * `actor` has no default on purpose. It is the one field that says whether a human chose this, and a
 * default would let a future caller write "somebody approved this" onto a bead nobody was asked
 * about — the exact claim this function exists to keep honest.
 */
export async function applyProposal(
  repo: string,
  proposal: Bead,
  board: Bead[],
  actor: ApplyActor,
): Promise<ApplyResult> {
  if (!isProposalBead(proposal)) {
    throw new ProposalApplyError("unusable", `${proposal.id} is not a proposal bead`);
  }
  if (proposal.status === "closed") {
    throw new ProposalApplyError(
      "unusable",
      `${proposal.id} is already settled — a proposal is applied or declined once`,
    );
  }
  const plan = proposalPlanOf(proposal);

  // The WHOLE application — decide, write every step, settle — runs under the proposal's own write
  // lock, not just its closing write. A cluster re-parent releases each subject's lock between
  // steps, so two approvals of one proposal could interleave there: one fails part-way and restores
  // a subject to its stale `undoParent` while the other, which had already moved that subject, runs
  // on and closes the proposal — a settled proposal claiming a cluster the board only half holds.
  // Serialized, the second approval finds the proposal already closed and writes nothing at all.
  return withBeadWriteLock(repo, proposal.id, async () => {
    if (!plan) {
      // No plan, or one that disagrees with the bead's own fingerprint. Either way there is no move
      // to run, and guessing one from the prose would mutate beads nobody approved. Inside the lock
      // like every other write this module makes to a proposal — the refusal still notes the bead.
      throw await attachFailure(
        repo,
        proposal,
        new ProposalApplyError(
          "unusable",
          `${proposal.id} carries no readable proposal move — it cannot be applied; apply it by hand and decline it`,
        ),
      );
    }
    return applyApproved(repo, proposal, plan, board, actor);
  });
}

/** The application itself: decide, write, settle — always under the proposal's lock (see caller). */
async function applyApproved(
  repo: string,
  proposal: Bead,
  plan: GardenerPlan,
  board: Bead[],
  actor: ApplyActor,
): Promise<ApplyResult> {
  await assertStillOpen(repo, proposal);
  // Dated from the proposal the approver read, not from the live re-read: its observation stamp is
  // the moment the patrol judged the board, which is what every "has this moved since we asked"
  // check compares to.
  const at: ApplyMoment = { nowMs: Date.now(), observedAtMs: observedAtOf(proposal) };
  const decision = planApply(plan, board, at);
  if (decision.status === "refuse") {
    throw await attachFailure(
      repo,
      proposal,
      new ProposalApplyError("refused", `cannot apply ${proposal.id}: ${decision.reason}`),
    );
  }
  if (decision.status === "settled") {
    return settleUnwritten(repo, proposal, plan, decision.summary, at, actor);
  }
  return applySteps(repo, proposal, plan, decision.steps, decision.summary, actor);
}

/**
 * Refuse unless the proposal is still open, judged from a read taken under its own write lock.
 *
 * The settled check in `applyProposal` judged the CALLER's snapshot — taken before whoever held this
 * lock ran — so two Approve clicks both pass it, and the loser must refuse rather than re-run a move
 * that already landed.
 *
 * A read that FAILS is not permission to proceed. The proposal is what RECORDS the decision, and
 * every path out of the apply ends in a note + close on it — which runs OUTSIDE the rollback block.
 * A proposal we cannot read is one we probably cannot settle either (a deleted bead, an unreachable
 * bd), so falling through would move subjects and then fail to record any of it, leaving board
 * mutations with no settled proposal explaining them. Nothing has been written yet, so refusing here
 * costs nothing and a retry re-decides against a board it can actually see.
 */
async function assertStillOpen(repo: string, proposal: Bead): Promise<void> {
  let live: Bead;
  try {
    live = await beads.show(repo, proposal.id);
  } catch (e) {
    throw new ProposalApplyError(
      "refused",
      `cannot apply ${proposal.id}: it could not be re-read under its own write lock ` +
        `(${messageOf(e)}) — nothing was written`,
    );
  }
  if (live.status === "closed" || beads.isAbandoned(live)) {
    throw new ProposalApplyError(
      "unusable",
      `${proposal.id} is already settled — a proposal is applied or declined once`,
    );
  }
}

/**
 * Settle a proposal the board already reads as applied.
 *
 * A SETTLED decision writes nothing, so — unlike an applied one — NO step ever locks or re-reads the
 * beads it rests on: the whole claim is the caller's snapshot, and a snapshot is stale the instant
 * it is taken. Re-confirm it under those beads' own write locks, and settle the proposal inside
 * them, so a subject moved away or an edge dropped after the route's refresh cannot leave this
 * proposal closed as applied over a board that no longer holds the state its summary names.
 */
function settleUnwritten(
  repo: string,
  proposal: Bead,
  plan: GardenerPlan,
  summary: string,
  at: ApplyMoment,
  actor: ApplyActor,
): Promise<ApplyResult> {
  return withBeadWriteLocks(repo, affectedBeads(plan), async () => {
    const drifted = await settledDrifted(repo, plan, at);
    if (drifted) {
      throw await attachFailure(
        repo,
        proposal,
        new ProposalApplyError("refused", `cannot apply ${proposal.id}: ${drifted}`),
      );
    }
    return settleProposal(repo, proposal, plan, summary, [], actor);
  });
}

/**
 * Write every step in order and settle — rolling the applied prefix back if one of them fails.
 *
 * Only steps that actually WROTE are collected: a step the board already satisfied is not ours to
 * roll back (see apply-steps.ts `alreadySatisfied`), and `changed` is both the rollback prefix and
 * what the proposal reports as touched.
 */
async function applySteps(
  repo: string,
  proposal: Bead,
  plan: GardenerPlan,
  steps: ApplyStep[],
  summary: string,
  actor: ApplyActor,
): Promise<ApplyResult> {
  const changed: ApplyStep[] = [];
  try {
    for (const step of steps) {
      if (await applyStep(repo, step)) changed.push(step);
    }
  } catch (e) {
    throw await attachFailure(repo, proposal, await stepFailure(repo, proposal.id, changed, e));
  }
  return settleProposal(repo, proposal, plan, summary, changed, actor);
}

/**
 * Roll the applied prefix back and say what the failure WAS. A subject that moved under us is the
 * board refusing, not a bd write breaking — but only while nothing has landed yet. Once a prefix is
 * written the outcome is a partial apply that was rolled back, which is `failed` whatever tripped it.
 */
async function stepFailure(
  repo: string,
  proposalId: string,
  changed: ApplyStep[],
  e: unknown,
): Promise<ProposalApplyError> {
  const rollback = await rollbackSteps(repo, changed);
  const stale = e instanceof SubjectMovedError && changed.length === 0;
  return stale
    ? new ProposalApplyError("refused", `cannot apply ${proposalId}: ${messageOf(e)}`)
    : new ProposalApplyError("failed", `applying ${proposalId} failed: ${messageOf(e)}${rollback}`);
}

/**
 * Record what changed on the proposal itself and settle it — a plain close, not an abandon: the ask
 * was answered, and only a DECLINE suppresses the fingerprint (see the module header). Always under
 * the lock the whole application holds, so no second approve can be part-way through the same steps
 * while this one declares them done.
 *
 * These two writes are the LAST an apply makes and the one pair that cannot fail quietly: by the time
 * they run every step has landed, so a settlement that breaks leaves board moves with no settled
 * proposal answering for them. It is REPORTED rather than undone — {@link ProposalApplyError} carries
 * the beads that stayed written, and both callers record them (the armed pass in gardener/armed.ts,
 * the route in its 500) instead of describing an untouched board. See {@link unsettled} for why the
 * rollback is not the answer here.
 */
async function settleProposal(
  repo: string,
  proposal: Bead,
  plan: GardenerPlan,
  summary: string,
  changed: ApplyStep[],
  actor: ApplyActor,
): Promise<ApplyResult> {
  const written = changed.map((s) => s.id);
  try {
    await beads.note(repo, proposal.id, appliedNote(plan, summary, actor));
    await beads.close(repo, proposal.id, `applied: ${summary}`);
  } catch (e) {
    throw await attachFailure(repo, proposal, unsettled(proposal.id, written, e));
  }
  return { proposalId: proposal.id, plan, summary, changed: written };
}

/**
 * The failure that leaves a proposal OPEN over a board that already carries its move.
 *
 * NOT rolled back, and the wording is what makes that honest. Only a re-parent can be undone at all
 * (apply-steps.ts `rollbackSteps` strands every other verb), so undoing a move the board wanted
 * because a note or a close failed would trade a state that converges for one a human has to
 * reconstruct: the ask left standing is the state approving it again SETTLES — `planApply` re-decides
 * against the live board, reads it as already applied, and closes the proposal writing nothing
 * ({@link settleUnwritten}).
 *
 * So the error says three things a caller has to be able to repeat: what stayed written, that the ask
 * is still open, and what closes it.
 */
function unsettled(proposalId: string, changed: string[], e: unknown): ProposalApplyError {
  const landed =
    changed.length > 0
      ? `the move LANDED (${changed.join(", ")}) and was not rolled back`
      : `the board already carried the move, so nothing was written`;
  return new ProposalApplyError(
    "failed",
    `applying ${proposalId} could not be settled: ${landed}, but the proposal itself could not be ` +
      `closed (${messageOf(e)}) — it stays open over a board that already holds its move, and ` +
      `approving it again settles it without writing anything`,
    changed,
  );
}

/**
 * The note a settled proposal keeps — and, for a policy apply, the only place the board says nobody
 * was asked.
 *
 * The unattended wording names the SETTING rather than just the fact, because that is what a reader
 * has to act on: the answer to "why did this move overnight" is a kind armed at `apply`, and the
 * note is where they find which one to change.
 */
function appliedNote(plan: GardenerPlan, summary: string, actor: ApplyActor): string {
  const prefix = notePrefix(plan);
  return actor === "policy"
    ? `${prefix}: applied by POLICY — ${summary}. Nobody approved this: this project's proposal ` +
        `autonomy for \`${plan.kind}\` is set to apply.`
    : `${prefix}: applied — ${summary}.`;
}

/** Every bead a plan's outcome rests on: the subjects it acts on, plus the bead it points at. */
function affectedBeads(plan: GardenerPlan): string[] {
  return plan.target ? [...plan.subjects, plan.target] : [...plan.subjects];
}

/**
 * Why the board no longer reads as already-applied, or undefined when it still does. Re-decided from
 * a FRESH board read through `planApply` itself rather than a hand-rolled per-verb re-check, so the
 * confirmation cannot hold the live board to a different bar than the decision held the snapshot to.
 */
async function settledDrifted(
  repo: string,
  plan: GardenerPlan,
  at: ApplyMoment,
): Promise<string | undefined> {
  let board: Bead[];
  try {
    board = await readWholeBoard(repo);
  } catch (e) {
    // Same rule as `reread`'s: a board we could not read says nothing, so the proposal stays open.
    return `the board could not be re-read to confirm the move is already applied (${messageOf(e)}) — nothing was written`;
  }
  const now = planApply(plan, board, { ...at, nowMs: Date.now() });
  switch (now.status) {
    case "settled":
      return undefined;
    case "refuse":
      return `the board no longer reads as applied — ${now.reason}`;
    default:
      return (
        "the board no longer reads as applied — the move was undone since this approval was " +
        "decided, so approving it again against the current board is what applies it"
      );
  }
}

// ── declining (the other half of the loop) ──

/**
 * The note a DECLINE leaves on a proposal, or undefined when the bead is not one.
 *
 * Declining is abandon — anton's existing won't-do outcome, which already closes the bead with the
 * operator's reason and labels it `abandoned`, and abandoned is exactly what emission suppresses on.
 * So the decline needs no verb of its own; what it needs is to SAY so, because "this question will
 * never be asked again" is a consequence of the label that nothing on the bead otherwise spells out.
 */
export function declineNote(proposal: Bead): string | undefined {
  const fingerprint = fingerprintLabelOf(proposal);
  if (!fingerprint) return undefined;
  // The `abandoned` label IS the suppression, so undoing a decline means dropping that label — not
  // reopening the bead, which would leave it suppressed and confuse the next reader.
  //
  // The producer comes off the fingerprint rather than off a plan: a proposal whose metadata is
  // unreadable can still be declined, and telling the operator which pass will stop asking is the
  // whole content of the note.
  return (
    `${fingerprint.split(":")[0]}: declined — this pass will not file \`${fingerprint}\` again. ` +
    `Remove the \`${LABELS.abandoned}\` label to let it ask once more.`
  );
}

/**
 * Write the failure onto the proposal so the still-open bead explains itself, and hand the error
 * back for the caller to throw. Best-effort: a note that cannot be written must not replace the
 * real failure with a bd error about writing about it.
 */
async function attachFailure(
  repo: string,
  proposal: Bead,
  error: ProposalApplyError,
): Promise<ProposalApplyError> {
  // Off the fingerprint, not off a plan: the one failure that reaches here with NO readable plan is
  // exactly the one whose note matters most.
  const prefix = fingerprintLabelOf(proposal)?.split(":")[0] ?? "proposal";
  try {
    await beads.note(repo, proposal.id, `${prefix}: apply FAILED — ${oneLine(error.message)}`);
  } catch (e) {
    console.error(`[${prefix}] could not attach the apply failure to ${proposal.id}`, e);
  }
  return error;
}

/**
 * The moment the proposal's EVIDENCE describes, in epoch ms — the fence every "has this moved since
 * we asked" check dates against.
 *
 * Not the bead's `created_at`: one patrol pass reads the board once and then files up to ten
 * proposals through sequential bd writes, so a subject edited after that read but before ITS
 * proposal was created is a change the detection never saw, which `created_at` would date as
 * already-observed. The emitter therefore stamps the snapshot's own moment onto the bead
 * ({@link GARDENER_OBSERVED_AT_KEY}).
 *
 * Two guards make trusting a metadata value safe here:
 *   • CLAMPED to `created_at`, so the stamp can only pull the fence EARLIER — the direction that
 *     costs refusals, never permission. Metadata is hand-editable, and a LATER fence is the one
 *     edit that would let a write the detection never saw pass as observed.
 *   • FLOORED to bd's one-second stamp grid, so a subject written in the same second as the
 *     observation still reads as the unorderable tie apply-plan.ts `writtenSinceFiling` fails closed
 *     on rather than as a write the plan saw.
 *
 * A missing or unreadable stamp falls back to `created_at` — a fence later by the length of one
 * pass, which is what anton shipped before this and is far better than refusing every proposal an
 * older patrol filed. An unreadable `created_at` stays `undefined`, which every caller fails closed
 * on.
 */
function observedAtOf(proposal: Bead): number | undefined {
  const created = msOf(proposal.created_at);
  if (created === undefined) return undefined;
  const observed = msOf(proposal.metadata?.[GARDENER_OBSERVED_AT_KEY]);
  return toBdStampGrid(observed === undefined ? created : Math.min(observed, created));
}

/** An ISO stamp (or an epoch-ms number) as epoch ms, or undefined when it is neither. */
function msOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * bd stamps beads at whole seconds; the fence is floored to match — see apply-plan.ts
 * `writtenSinceFiling`.
 *
 * Exported because anything that builds an {@link ApplyMoment} from a raw wall-clock reading rather
 * than from a proposal bead — the shadow pass — has to floor it through THIS function, or it decides
 * a same-second write on a finer grid than the armed path and reports permission the armed path
 * would refuse.
 */
export const toBdStampGrid = (ms: number): number => Math.floor(ms / 1000) * 1000;
