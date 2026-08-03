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
 *     again, so a retry after a half-finished approve converges rather than double-moves. And
 *     because a snapshot is stale the instant it is taken, each subject is re-read and re-judged
 *     under its own write lock immediately before it is mutated — the same lock a run's claim takes
 *     (see `applyStep`), so a lease published mid-approval orders against this apply instead of
 *     racing it.
 *   • NO PARTIAL SILENT STATE. The only multi-write move is a cluster re-parent, and its steps carry
 *     their own undo: a failure part-way rolls the applied prefix back and leaves the proposal OPEN
 *     with the error attached as a note. What a reader must never find is a board half-moved and a
 *     proposal reading as done.
 *
 * Declining is the other half of the loop and needs no store of its own: a declined proposal is an
 * ABANDONED bead (closed + `abandoned`) still carrying its fingerprint label, which is exactly what
 * emission already suppresses on (see emit.ts `suppressedFingerprints`). The board is the memory.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLock } from "../beads/claim-lock";
import { indexBoard, isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import {
  fingerprintLabelOf,
  isProposalBead,
  proposalPlanOf,
  type GardenerPlan,
} from "./detections";

/** The `notes` prefix every gardener apply writes under — one line, like anton's other job notes. */
const NOTE_PREFIX = "gardener";

/** One board write an approved proposal resolves to, with whatever it takes to undo it. */
export type ApplyStep =
  | {
      verb: "reparent";
      id: string;
      parent: string;
      /** The parent to restore on rollback; `""` is bd's detach form, for a bead that had none. */
      undoParent: string;
    }
  | { verb: "link"; id: string; blocker: string }
  | { verb: "close"; id: string; reason: string }
  | { verb: "supersede"; id: string; replacement: string }
  | { verb: "defer"; id: string };

/**
 * What approving this proposal means against the board AS IT NOW IS:
 *   • `apply`  — these writes, in this order.
 *   • `settled` — the board already reads as applied (someone did it by hand, or a previous approve
 *     landed its writes and failed before closing the proposal). Nothing to write; the proposal
 *     still closes, which is what makes a retry converge instead of re-applying.
 *   • `refuse` — a precondition the plan rests on is no longer true. Nothing is written at all.
 */
export type ApplyDecision =
  | { status: "apply"; steps: ApplyStep[]; summary: string }
  | { status: "settled"; summary: string }
  | { status: "refuse"; reason: string };

/**
 * Decide a plan against a board, writing nothing. Pure, so every precondition — the ones that
 * protect other people's beads — is testable from a fixture board rather than a live one.
 *
 * The board is read through the SAME `indexBoard` the detectors use: parentage, card attribution and
 * `blocks` edges have to mean one thing on both halves of the loop, or a proposal could be filed
 * under one answer and applied under another.
 *
 * `nowMs` is the moment the approval is being decided; it only dates the run-lease check below.
 */
export function planApply(
  plan: GardenerPlan,
  board: Bead[],
  nowMs: number = Date.now(),
): ApplyDecision {
  const index = indexBoard(board);
  switch (plan.move) {
    case "reparent":
      return planReparent(plan, index, nowMs);
    case "link":
      return planLink(plan, index, nowMs);
    case "retire":
      return planRetire(plan, index, nowMs);
  }
}

function planReparent(plan: GardenerPlan, index: BoardIndex, nowMs: number): ApplyDecision {
  // A container-orphan detection with no single obvious home deliberately files WITHOUT a target —
  // it asks the approver to pick one. Approving it as-is would have to invent that answer.
  if (!plan.target) {
    return {
      status: "refuse",
      reason: `this proposal names no new parent — it asks for a home to be chosen, so re-parent ${plan.subjects.join(", ")} by hand and decline it`,
    };
  }
  const target = index.byId.get(plan.target);
  if (!target) return { status: "refuse", reason: missing(plan.target) };
  if (!isOpenWork(target)) {
    return {
      status: "refuse",
      reason: `${plan.target} is ${settledWord(target)} — re-parenting work under it would hang it off a card nothing will run`,
    };
  }
  // The same bar the detector proposes against: a home must be a BOARD CARD, or the move recreates
  // the very state (work riding no card) the proposal exists to fix.
  if (!index.cards.ids.has(plan.target)) {
    return {
      status: "refuse",
      reason: `${plan.target} is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    };
  }
  // A home a run OWNS is off limits for the same reason a subject is, and the harm is worse: that run
  // already selected the tickets it will work through, so work attached now rides along unrun — and
  // when the run settles the card, the newcomers are left beneath a target nothing will claim, which
  // is the unreachable state this proposal exists to fix.
  if (isInFlight(target, nowMs)) {
    return { status: "refuse", reason: inFlightReason(target, nowMs, "hanging more work under it") };
  }

  const steps: ApplyStep[] = [];
  for (const id of plan.subjects) {
    const subject = index.byId.get(id);
    if (!subject) return { status: "refuse", reason: missing(id) };
    const currentParent = beads.parentOf(subject);
    if (currentParent === plan.target) continue; // already where the proposal wants it
    if (!isOpenWork(subject)) {
      return {
        status: "refuse",
        reason: `${id} is ${settledWord(subject)} — the board moved on since this was proposed`,
      };
    }
    if (isInFlight(subject, nowMs)) {
      return { status: "refuse", reason: inFlightReason(subject, nowMs, "moving it") };
    }
    // A parent that sits UNDER one of the subjects would make the subtree its own ancestor.
    if (index.isAncestor(id, plan.target)) {
      return {
        status: "refuse",
        reason: `${plan.target} sits under ${id} — re-parenting it there would make the subtree its own ancestor`,
      };
    }
    steps.push({ verb: "reparent", id, parent: plan.target, undoParent: currentParent ?? "" });
  }

  if (steps.length === 0) {
    const sit = plan.subjects.length === 1 ? "sits" : "sit";
    return { status: "settled", summary: `${list(plan.subjects)} already ${sit} under ${plan.target}` };
  }
  return {
    status: "apply",
    steps,
    summary: `re-parented ${list(steps.map((s) => s.id))} under ${plan.target}`,
  };
}

function planLink(plan: GardenerPlan, index: BoardIndex, nowMs: number): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a link proposal names exactly one blocked bead" };
  }
  if (!plan.target) return { status: "refuse", reason: "this proposal names no blocker to record" };

  const blocked = index.byId.get(id);
  const blocker = index.byId.get(plan.target);
  if (!blocked) return { status: "refuse", reason: missing(id) };
  if (!blocker) return { status: "refuse", reason: missing(plan.target) };

  // The edge the proposal asked for is already drawn: the ordering is recorded, so there is nothing
  // to write and the ask is answered.
  if (index.recordsBlocker(id, plan.target)) {
    return { status: "settled", summary: `a blocks edge already records ${plan.target} → ${id}` };
  }
  // The OPPOSITE edge is not this ask half-done — it is someone's explicit decision that the ordering
  // runs the other way, made after this was filed. Settling on it would close the proposal claiming
  // an edge the board does not hold, and writing ours would fight the human who drew theirs. Refuse,
  // and let them re-decide against the contradiction.
  if (index.hasBlocksEdge(id, plan.target)) {
    return {
      status: "refuse",
      reason: `the board records the opposite ordering — ${id} blocks ${plan.target} — which is someone's explicit decision; recording ${plan.target} as ${id}'s blocker would contradict it`,
    };
  }
  if (!isOpenWork(blocked)) {
    return {
      status: "refuse",
      reason: `${id} is ${settledWord(blocked)} — an ordering edge would constrain nothing`,
    };
  }
  if (!isOpenWork(blocker)) {
    return {
      status: "refuse",
      reason: `${plan.target} is ${settledWord(blocker)} — the work ${id} was waiting on has landed, so the edge would only make ${id} read as blocked forever`,
    };
  }
  // Only the blocked bead is written to, and a run is executing it right now: recording an ordering
  // edge against it would tell every other reader that live work is waiting on something.
  if (isInFlight(blocked, nowMs)) {
    return { status: "refuse", reason: inFlightReason(blocked, nowMs, "recording it as blocked") };
  }
  // The blocker already waits on the blocked bead through other beads: no direct edge, so the pair
  // read as unrelated above, but this edge would close the loop — and bd rejects a blocking cycle at
  // every write path, so applying it would only 500 and leave the proposal open forever.
  if (index.isBlockedBy(plan.target, id)) {
    return {
      status: "refuse",
      reason: `${plan.target} is already blocked by ${id} through other beads — recording ${plan.target} as ${id}'s blocker would close a dependency cycle, which bd refuses to write`,
    };
  }

  return {
    status: "apply",
    steps: [{ verb: "link", id, blocker: plan.target }],
    summary: `recorded that ${plan.target} blocks ${id}`,
  };
}

function planRetire(plan: GardenerPlan, index: BoardIndex, nowMs: number): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a retirement proposal names exactly one bead" };
  }
  const subject = index.byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  // Already settled by whatever means: the outcome the proposal wanted is the board's state, so
  // there is nothing to write and no reason to keep asking. An ABANDONED bead counts even in the
  // "open + abandoned" state a crashed abandon can leave — retiring it with `close` would turn a
  // recorded won't-do into work that reads as shipped, which is the one lie retirement must not tell.
  if (subject.status === "closed" || beads.isAbandoned(subject)) {
    return { status: "settled", summary: `${id} is already ${settledWord(subject)}` };
  }
  if (plan.retireAs === "defer" && beads.isDeferred(subject)) {
    return { status: "settled", summary: `${id} is already deferred` };
  }
  // Nothing left to settle, so from here every branch WRITES — and a bead a run owns is the one
  // thing retirement must not write to. Closing or deferring work an agent is mid-flight over would
  // pull the bead out from under the run that is shipping it.
  if (isInFlight(subject, nowMs)) {
    return { status: "refuse", reason: inFlightReason(subject, nowMs, "retiring it") };
  }
  // Settling a bead that still has open work under it strands that work: the children stay in the
  // ready set with a parent no run will ever reach — the unreachable state `detectContainerOrphans`
  // exists to flag, arrived at by approving a proposal. Only the SETTLING verbs are barred; `defer`
  // parks the subtree with its contract intact and is undone by reopening the parent.
  if (plan.retireAs === "close" || plan.retireAs === "supersede") {
    const open = index.openDescendants(id);
    if (open.length > 0) {
      return {
        status: "refuse",
        reason: `${id} still has open work under it (${namesSome(open.map((b) => b.id))}) — settling it would strand that work beneath a card nothing will run; close or retire the children first`,
      };
    }
  }

  switch (plan.retireAs) {
    case "close":
      return {
        status: "apply",
        steps: [{ verb: "close", id, reason: closeReason(plan) }],
        summary: `closed ${id} as shipped`,
      };
    case "defer":
      return {
        status: "apply",
        steps: [{ verb: "defer", id }],
        summary: `deferred ${id} out of the ready set`,
      };
    case "supersede": {
      if (!plan.target) {
        return { status: "refuse", reason: "this proposal names no bead that superseded it" };
      }
      const survivor = index.byId.get(plan.target);
      if (!survivor) return { status: "refuse", reason: missing(plan.target) };
      // The whole claim is "the work landed over there". A survivor that is open again means it
      // did not, and closing this one would write off work nothing has delivered.
      if (survivor.status !== "closed") {
        return {
          status: "refuse",
          reason: `${plan.target} is ${survivor.status} again — it has not landed, so ${id} is not superseded by it`,
        };
      }
      return {
        status: "apply",
        steps: [{ verb: "supersede", id, replacement: plan.target }],
        summary: `closed ${id} as superseded by ${plan.target}`,
      };
    }
    default:
      return { status: "refuse", reason: `unknown retirement verb "${plan.retireAs}"` };
  }
}

/** Why a proposal could not be applied — mapped to a status by the route, never swallowed. */
export type ApplyFailure =
  /** The bead is not an applicable proposal (not one at all, no readable plan, already settled). */
  | "unusable"
  /** Preconditions no longer hold. Nothing was written; a human re-decides. */
  | "refused"
  /** A bd write failed mid-flight. Whatever landed was rolled back; the proposal stays open. */
  | "failed";

export class ProposalApplyError extends Error {
  constructor(
    readonly failure: ApplyFailure,
    message: string,
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
 * Apply an approved proposal and close it with a note of what changed.
 *
 * `board` is the caller's FRESH `--status all` read (the approve route forces one before it decides
 * anything): every precondition is judged against it, so a proposal filed against a board that has
 * since moved refuses instead of acting on last night's picture.
 *
 * Throws {@link ProposalApplyError} on every failure — and attaches the reason to the proposal as a
 * note first, so the bead a human comes back to says why it is still open. The one thing this never
 * does is close a proposal whose move did not land.
 */
export async function applyProposal(
  repo: string,
  proposal: Bead,
  board: Bead[],
): Promise<ApplyResult> {
  if (!isProposalBead(proposal)) {
    throw new ProposalApplyError("unusable", `${proposal.id} is not a gardener proposal`);
  }
  if (proposal.status === "closed") {
    throw new ProposalApplyError(
      "unusable",
      `${proposal.id} is already settled — a proposal is applied or declined once`,
    );
  }
  const plan = proposalPlanOf(proposal);
  if (!plan) {
    // No plan, or one that disagrees with the bead's own fingerprint. Either way there is no move
    // to run, and guessing one from the prose would mutate beads nobody approved.
    throw await attachFailure(
      repo,
      proposal.id,
      new ProposalApplyError(
        "unusable",
        `${proposal.id} carries no readable gardener move — it cannot be applied; apply it by hand and decline it`,
      ),
    );
  }

  const decision = planApply(plan, board, Date.now());
  if (decision.status === "refuse") {
    throw await attachFailure(
      repo,
      proposal.id,
      new ProposalApplyError("refused", `cannot apply ${proposal.id}: ${decision.reason}`),
    );
  }

  const changed: ApplyStep[] = [];
  if (decision.status === "apply") {
    try {
      for (const step of decision.steps) {
        await applyStep(repo, step);
        changed.push(step);
      }
    } catch (e) {
      const rollback = await rollbackSteps(repo, changed);
      // A subject that moved under us is the board refusing, not a bd write breaking — but only
      // while nothing has landed yet. Once a prefix is written the outcome is a partial apply that
      // was rolled back, which is `failed` whatever tripped it.
      const stale = e instanceof SubjectMovedError && changed.length === 0;
      throw await attachFailure(
        repo,
        proposal.id,
        new ProposalApplyError(
          stale ? "refused" : "failed",
          stale
            ? `cannot apply ${proposal.id}: ${messageOf(e)}`
            : `applying ${proposal.id} failed: ${messageOf(e)}${rollback}`,
        ),
      );
    }
  }

  // The move landed (or was already true). Record what changed on the proposal itself and settle it
  // — a plain close, not an abandon: the ask was answered, and only a DECLINE suppresses the
  // fingerprint (see the module header).
  //
  // Under the PROPOSAL's own write lock, re-reading it inside: the already-settled check at the top
  // judged the caller's snapshot, so two approvals of the same proposal can both reach here — a
  // re-parent or a link re-applies idempotently, so neither trips the subject guard. Whoever loses
  // the lock finds the proposal already closed and writes nothing, rather than closing a closed bead
  // and answering 500 for a board that is correct.
  const summary = decision.summary;
  await withBeadWriteLock(repo, proposal.id, async () => {
    // A read that failed says nothing about whether the proposal settled, and the move HAS landed —
    // so fall through and let a real write failure surface rather than leaving it silently open.
    const live = await beads.show(repo, proposal.id).catch(() => undefined);
    if (live && (live.status === "closed" || beads.isAbandoned(live))) return;
    await beads.note(repo, proposal.id, `${NOTE_PREFIX}: applied — ${summary}.`);
    await beads.close(repo, proposal.id, `applied: ${summary}`);
  });

  return { proposalId: proposal.id, plan, summary, changed: changed.map((s) => s.id) };
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
  return (
    `${NOTE_PREFIX}: declined — the patrol will not file \`${fingerprint}\` again. ` +
    `Remove the \`${LABELS.abandoned}\` label to let it ask once more.`
  );
}

// ── execution (the only writes in this module) ──

/** A subject the board moved on between the decision and the write. Never a bd failure. */
class SubjectMovedError extends Error {}

/** What each verb would be DOING to the subject, for a refusal that reads as a sentence. */
const DOING: Record<ApplyStep["verb"], string> = {
  reparent: "moving it",
  link: "recording it as blocked",
  close: "retiring it",
  supersede: "retiring it",
  defer: "retiring it",
};

/**
 * One write, taken under the SUBJECT'S OWN write lock and re-judged against a read from inside it.
 *
 * `planApply` decides against the caller's board snapshot, which is already seconds old by the time
 * the first bd write spawns — and the thing it is guarding against, a runner publishing a lease or
 * flipping a status, happens in exactly that window. Worse, a run's claim is serialized on this same
 * per-bead chain (beads/claim-lock.ts, shared with claimVerified and the human-claim CAS), so an
 * apply that stayed outside it wasn't racing the claim protocol so much as ignoring it: the snapshot
 * check could pass, a claim could land, and the move would still execute against work that had begun.
 *
 * Holding the lock makes the two orders: either the claim lands first and this read sees it (refuse),
 * or this write lands first and the claim queues behind it. The re-check is deliberately the SUBJECT
 * bar only — is this bead still open, and does a run own it — because that is what the lock covers;
 * the relational preconditions (target is a card, no cycle, no open descendants) belong to the board
 * as a whole and stay with the snapshot decision.
 */
async function applyStep(repo: string, step: ApplyStep): Promise<void> {
  await withBeadWriteLock(repo, step.id, async () => {
    let subject: Bead | undefined;
    try {
      subject = await beads.show(repo, step.id);
    } catch (e) {
      // A read that failed is not a bead that vanished, and saying so would misdiagnose a flaky bd
      // as a board that moved. Either way nothing is written to this bead.
      throw new SubjectMovedError(
        `${step.id} could not be re-read before writing to it (${messageOf(e)}) — nothing was written`,
      );
    }
    const moved = subjectMoved(step, subject, Date.now());
    if (moved) throw new SubjectMovedError(moved);
    await runStep(repo, step);
  });
}

/** Why this subject can no longer be written to, or undefined when the plan still holds for it. */
function subjectMoved(step: ApplyStep, subject: Bead | undefined, nowMs: number): string | undefined {
  if (!subject) return missing(step.id);
  if (!isOpenWork(subject)) {
    return `${step.id} is ${settledWord(subject)} — the board moved on since this was proposed`;
  }
  if (isInFlight(subject, nowMs)) return inFlightReason(subject, nowMs, DOING[step.verb]);
  return undefined;
}

async function runStep(repo: string, step: ApplyStep): Promise<void> {
  switch (step.verb) {
    case "reparent":
      await beads.reparent(repo, step.id, step.parent);
      return;
    case "link":
      // `bd link a b` = b blocks a, which is the direction the detection states.
      await beads.link(repo, step.id, step.blocker, "blocks");
      return;
    case "close":
      await beads.close(repo, step.id, step.reason);
      return;
    case "supersede":
      await beads.supersede(repo, step.id, step.replacement);
      return;
    case "defer":
      await beads.defer(repo, step.id);
      return;
  }
}

/**
 * Undo the steps that DID land when a later one failed, newest first, and report the outcome as a
 * clause for the error. Only a cluster re-parent is ever multi-step, so this is the one shape that
 * can strand a half-applied move; every other move fails with nothing written.
 *
 * A rollback that itself fails is named in the error rather than swallowed: the board is then in a
 * state a human has to look at, and saying so is the whole point of failing loud.
 */
async function rollbackSteps(repo: string, applied: ApplyStep[]): Promise<string> {
  if (applied.length === 0) return " — nothing had been written";
  const stranded: string[] = [];
  for (const step of [...applied].reverse()) {
    if (step.verb !== "reparent") {
      stranded.push(step.id);
      continue;
    }
    try {
      // Undone under the same per-bead lock the write took, so a claim that queued behind the
      // failed apply doesn't interleave with its rollback.
      await withBeadWriteLock(repo, step.id, () => beads.reparent(repo, step.id, step.undoParent));
    } catch {
      stranded.push(step.id);
    }
  }
  return stranded.length === 0
    ? ` — the ${applied.length} write(s) already made were rolled back, so the board is unchanged`
    : ` — ROLLBACK INCOMPLETE: ${list(stranded)} could not be restored and need a human`;
}

/**
 * Write the failure onto the proposal so the still-open bead explains itself, and hand the error
 * back for the caller to throw. Best-effort: a note that cannot be written must not replace the
 * real failure with a bd error about writing about it.
 */
async function attachFailure(
  repo: string,
  proposalId: string,
  error: ProposalApplyError,
): Promise<ProposalApplyError> {
  try {
    await beads.note(repo, proposalId, `${NOTE_PREFIX}: apply FAILED — ${oneLine(error.message)}`);
  } catch (e) {
    console.error(`[gardener] could not attach the apply failure to ${proposalId}`, e);
  }
  return error;
}

// ── small pure helpers ──

/** The close reason a retirement writes — evidence lives on the proposal, so this stays one line. */
function closeReason(plan: GardenerPlan): string {
  return `closed by an approved gardener proposal (${plan.kind})`;
}

const missing = (id: string): string =>
  `${id} is no longer on the board — the proposal describes a board that has changed`;

/**
 * Why a bead a run owns is off limits, naming the run that owns it. Every detector already refuses
 * to PROPOSE against in-flight work (see board-index `isInFlight`) — this is the same bar re-checked
 * at approve time, because the run may have claimed the bead AFTER the proposal was filed, and a
 * proposal is only ever as fresh as the night it was written.
 */
function inFlightReason(bead: Bead, nowMs: number, doing: string): string {
  const pr = beads.getPrRef(bead);
  const owner = beads.isRunLive(bead, nowMs)
    ? `a run holds a live lease on it${bead.assignee ? ` (${bead.assignee})` : ""}`
    : `it is in review${pr ? ` on ${pr}` : ""}`;
  return `${bead.id} is mid-run — ${owner}, so ${doing} would race the run that owns it`;
}

const settledWord = (bead: Bead): string =>
  beads.isAbandoned(bead) ? "abandoned" : bead.status === "closed" ? "closed" : bead.status;

const list = (ids: string[]): string => ids.join(", ");

/** How many ids a refusal spells out before it counts the rest — a reason stays one readable line. */
const NAMED_IDS = 5;

const namesSome = (ids: string[]): string =>
  ids.length <= NAMED_IDS
    ? list(ids)
    : `${list(ids.slice(0, NAMED_IDS))} and ${ids.length - NAMED_IDS} more`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const messageOf = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));
