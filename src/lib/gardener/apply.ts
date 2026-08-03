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
 *     Stale plans refuse loudly; a board that already reads as applied SETTLES the proposal instead
 *     of writing again, so a retry after a half-finished approve converges rather than double-moves.
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
import { boardCards } from "../ticket-view";
import { isOpenWork } from "./board-index";
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
 */
export function planApply(plan: GardenerPlan, board: Bead[]): ApplyDecision {
  const byId = new Map(board.map((b) => [b.id, b]));
  switch (plan.move) {
    case "reparent":
      return planReparent(plan, board, byId);
    case "link":
      return planLink(plan, board, byId);
    case "retire":
      return planRetire(plan, byId);
  }
}

function planReparent(
  plan: GardenerPlan,
  board: Bead[],
  byId: Map<string, Bead>,
): ApplyDecision {
  // A container-orphan detection with no single obvious home deliberately files WITHOUT a target —
  // it asks the approver to pick one. Approving it as-is would have to invent that answer.
  if (!plan.target) {
    return {
      status: "refuse",
      reason: `this proposal names no new parent — it asks for a home to be chosen, so re-parent ${plan.subjects.join(", ")} by hand and decline it`,
    };
  }
  const target = byId.get(plan.target);
  if (!target) return { status: "refuse", reason: missing(plan.target) };
  if (!isOpenWork(target)) {
    return {
      status: "refuse",
      reason: `${plan.target} is ${settledWord(target)} — re-parenting work under it would hang it off a card nothing will run`,
    };
  }
  // The same bar the detector proposes against: a home must be a BOARD CARD, or the move recreates
  // the very state (work riding no card) the proposal exists to fix.
  if (!boardCards(board).ids.has(plan.target)) {
    return {
      status: "refuse",
      reason: `${plan.target} is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    };
  }

  const steps: ApplyStep[] = [];
  for (const id of plan.subjects) {
    const subject = byId.get(id);
    if (!subject) return { status: "refuse", reason: missing(id) };
    const currentParent = beads.parentOf(subject);
    if (currentParent === plan.target) continue; // already where the proposal wants it
    if (!isOpenWork(subject)) {
      return {
        status: "refuse",
        reason: `${id} is ${settledWord(subject)} — the board moved on since this was proposed`,
      };
    }
    // A parent that sits UNDER one of the subjects would make the subtree its own ancestor.
    if (isAncestor(byId, id, plan.target)) {
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

function planLink(plan: GardenerPlan, board: Bead[], byId: Map<string, Bead>): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a link proposal names exactly one blocked bead" };
  }
  if (!plan.target) return { status: "refuse", reason: "this proposal names no blocker to record" };

  const blocked = byId.get(id);
  const blocker = byId.get(plan.target);
  if (!blocked) return { status: "refuse", reason: missing(id) };
  if (!blocker) return { status: "refuse", reason: missing(plan.target) };

  // The edge already exists (in either direction): the ordering is recorded, which is all the
  // proposal asked for. A reversed edge is someone's explicit decision — never overwrite it.
  if (hasBlocksEdge(board, id, plan.target)) {
    return { status: "settled", summary: `a blocks edge already records ${plan.target} → ${id}` };
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

  return {
    status: "apply",
    steps: [{ verb: "link", id, blocker: plan.target }],
    summary: `recorded that ${plan.target} blocks ${id}`,
  };
}

function planRetire(plan: GardenerPlan, byId: Map<string, Bead>): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a retirement proposal names exactly one bead" };
  }
  const subject = byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  // Already settled by whatever means: the outcome the proposal wanted is the board's state, so
  // there is nothing to write and no reason to keep asking. An ABANDONED bead counts even in the
  // "open + abandoned" state a crashed abandon can leave — retiring it with `close` would turn a
  // recorded won't-do into work that reads as shipped, which is the one lie retirement must not tell.
  if (subject.status === "closed" || beads.isAbandoned(subject)) {
    return { status: "settled", summary: `${id} is already ${settledWord(subject)}` };
  }

  switch (plan.retireAs) {
    case "close":
      return {
        status: "apply",
        steps: [{ verb: "close", id, reason: closeReason(plan) }],
        summary: `closed ${id} as shipped`,
      };
    case "defer":
      if (beads.isDeferred(subject)) {
        return { status: "settled", summary: `${id} is already deferred` };
      }
      return {
        status: "apply",
        steps: [{ verb: "defer", id }],
        summary: `deferred ${id} out of the ready set`,
      };
    case "supersede": {
      if (!plan.target) {
        return { status: "refuse", reason: "this proposal names no bead that superseded it" };
      }
      const survivor = byId.get(plan.target);
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

  const decision = planApply(plan, board);
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
        await runStep(repo, step);
        changed.push(step);
      }
    } catch (e) {
      const rollback = await rollbackSteps(repo, changed);
      throw await attachFailure(
        repo,
        proposal.id,
        new ProposalApplyError(
          "failed",
          `applying ${proposal.id} failed: ${messageOf(e)}${rollback}`,
        ),
      );
    }
  }

  // The move landed (or was already true). Record what changed on the proposal itself and settle it
  // — a plain close, not an abandon: the ask was answered, and only a DECLINE suppresses the
  // fingerprint (see the module header).
  const summary = decision.summary;
  await beads.note(repo, proposal.id, `${NOTE_PREFIX}: applied — ${summary}.`);
  await beads.close(repo, proposal.id, `applied: ${summary}`);

  return { proposalId: proposal.id, plan, summary, changed: changed.map((s) => s.id) };
}

// ── declining (the other half of the loop) ──

/**
 * The fingerprints the board records as DECLINED: every abandoned proposal's. This is the whole
 * "decline store" — a human's "no" lives on the bead they said it about, which is why a decline
 * survives a re-clone, reaches every machine through the same Dolt sync as the work, and needs no
 * table of its own. {@link import("./emit").suppressedFingerprints} is what reads it back on the
 * next patrol; this is the same fact stated for a reader who wants only the declines.
 */
export function declinedFingerprints(board: Bead[]): Set<string> {
  const out = new Set<string>();
  for (const bead of board) {
    if (!beads.isAbandoned(bead)) continue;
    const fingerprint = fingerprintLabelOf(bead);
    if (fingerprint) out.add(fingerprint);
  }
  return out;
}

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
      await beads.reparent(repo, step.id, step.undoParent);
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

const settledWord = (bead: Bead): string =>
  beads.isAbandoned(bead) ? "abandoned" : bead.status === "closed" ? "closed" : bead.status;

const list = (ids: string[]): string => ids.join(", ");

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const messageOf = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));

/** Is `ancestorId` this bead or anywhere on its parent chain? Cycle-guarded (see board-index). */
function isAncestor(byId: Map<string, Bead>, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    const bead = byId.get(current);
    current = bead ? beads.parentOf(bead) : undefined;
  }
  return false;
}

/** A `blocks` edge between these two in EITHER direction — a reversed edge is a decision, not a gap. */
function hasBlocksEdge(board: Bead[], a: string, b: string): boolean {
  return beads
    .edgesOf(board)
    .some(
      (e) =>
        e.type === "blocks" && ((e.from === a && e.to === b) || (e.from === b && e.to === a)),
    );
}
