/**
 * UNLINKED OUTCOME (anton-vie0k): an open run target the digest cannot group under any project
 * outcome, because it carries no readable `outcome:<id>` (see {@link outcomeIdsOf}, which also
 * reads a standalone epic's `## Outcome IDs` body for the run targets that store it there instead
 * of a label). Old work predates the outcome contract (anton-cdeki) and would otherwise sit
 * "unlinked" forever, so the gardener proposes a deterministic guess rather than leaving a human to
 * hand-edit dozens of beads.
 *
 * The guess is read off the board alone, in order — no model, no judgment (ADR-0001): the parent
 * epic's own `outcome:` label, when it carries exactly one; `codebase-health` for work stringer
 * filed itself; otherwise `unknown`, which is itself the honest answer when neither signal is
 * there to read. Turning the claim into a proposal that WRITES the label is anton-15xcn's job —
 * this module only states what is missing and what it would be set to.
 */
import { beads, labelValueOf, labelValuesOf, type Bead } from "../beads/bd";
import { outcomeIdsOf } from "../backlog";
import { goalBody, isAuthoredBody, preambleOf } from "../beads/contract";
import { AREA_SHAPE } from "../epic-patch";
import { isClaimed, isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

/** What scan-triage-produced work always serves (outcomes.ts's built-in) — stringer's own beads
 * carry no product outcome of their own to inherit. */
export const STRINGER_OUTCOME = "codebase-health";

/** The suggestion that asks the operator rather than guessing — neither signal below fired. */
export const UNKNOWN_OUTCOME = "unknown";

/** How much of a bead's own Goal rides along as evidence — a hint, not the whole contract. */
const MAX_GOAL_HINT_CHARS = 240;

/**
 * Every open run target with no outcome to group under, each with a deterministic suggestion.
 *
 * Closed and deferred beads are skipped — `isOpenWork` plus an explicit {@link beads.isDeferred}
 * check, the same pair {@link detectStale} in retire.ts holds a bead to, since `deferred` is a
 * status `isOpenWork` alone does not exclude. A bead's own proposals never reach here at all: the
 * caller indexes the board through {@link indexWorkBoard}, which filters them before any detector
 * sees a snapshot.
 *
 * Also skipped: a target already {@link isInFlight} or {@link isClaimed} — the same busy bar every
 * other move/order/settle detector proposes under. Without it, a run that claims an unlabelled
 * target between this pass's read and approval leaves the proposal unappliable (`subjectBusy`
 * refuses it) for good once that run closes the target — a stale ask a human has to notice and
 * decline by hand rather than one the next pass simply stops re-raising.
 */
export function detectUnlinkedOutcomes(index: BoardIndex, nowMs: number): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const bead of index.all) {
    if (!isOpenWork(bead) || beads.isDeferred(bead)) continue;
    if (!beads.isRunTarget(bead, index.all)) continue;
    if (isInFlight(bead, nowMs) || isClaimed(bead)) continue;
    if (outcomeIdsOf(bead).length > 0) continue;

    const suggestion = suggestOutcome(index, bead);
    const goalHint = goalHintOf(bead);
    detections.push(
      makeDetection({
        kind: "unlinked-outcome",
        move: "attach-outcome",
        subjects: [bead.id],
        detail: suggestion.outcome,
        summary: `${bead.id} carries no outcome:<id> — the digest cannot group it under any project outcome`,
        evidence: [
          `${bead.id} ("${bead.title}") is a ${bead.status} ${bead.issue_type ?? "bead"} and a run target, but no outcome:<id> label (or, for a standalone epic, ## Outcome IDs body) names what it serves`,
          ...suggestion.evidence,
          // Read by the approver when the suggestion is `unknown`: the board gave no signal to
          // read, so the bead's own stated purpose is the only thing left to judge the outcome by.
          ...(goalHint ? [`its own Goal: ${goalHint}`] : []),
        ],
      }),
    );
  }

  return detections;
}

export interface Suggestion {
  outcome: string;
  evidence: string[];
  /**
   * The epic whose own label DETERMINED `outcome` — set only in the inherit rung below. Named so a
   * caller that is about to WRITE the outcome can lock this bead too (apply-steps.ts
   * `lockedBeads`/`premiseBeadsOf`): the guess is read off the parent's label, not the subject's own,
   * so nothing serializes it against a concurrent relabel of the parent unless the caller locks the
   * parent explicitly.
   */
  parent?: string;
}

/**
 * The deterministic guess, in the order the acceptance criteria states it: inherit the parent
 * epic's own outcome when it names exactly one, fall back to the stringer default, and otherwise
 * ask. Each rung only fires when the one above it found nothing to read.
 *
 * Exported so apply-plan.ts/apply-steps.ts can re-run the same guess against a FRESH board before
 * writing the label — the proposal's own `detail` is frozen at detection time, and a parent epic
 * relabelled between filing and approval must change the answer, not just the evidence text.
 */
export function suggestOutcome(index: BoardIndex, bead: Bead): Suggestion {
  const parentId = beads.parentOf(bead);
  const parent = parentId ? index.byId.get(parentId) : undefined;
  if (parent && beads.isEpic(parent)) {
    const epicOutcomes = epicOutcomeLabels(parent);
    if (epicOutcomes.length === 1) {
      return {
        outcome: epicOutcomes[0],
        evidence: [`its parent epic ${parent.id} carries exactly one outcome:${epicOutcomes[0]} label — inherit it`],
        parent: parent.id,
      };
    }
    if (epicOutcomes.length > 1) {
      return {
        outcome: UNKNOWN_OUTCOME,
        evidence: [
          `its parent epic ${parent.id} carries ${epicOutcomes.length} outcome labels (${epicOutcomes.join(", ")}) — no single one to inherit`,
        ],
      };
    }
  }

  if (labelValueOf(bead.labels, "source") === "stringer") {
    return {
      outcome: STRINGER_OUTCOME,
      evidence: [`${bead.id} carries source:stringer — scan-triage-produced work always serves ${STRINGER_OUTCOME}`],
    };
  }

  return {
    outcome: UNKNOWN_OUTCOME,
    evidence: [`neither a parent epic's outcome nor a source:stringer label suggests one — ask the operator which outcome this serves`],
  };
}

/**
 * What the bead itself states it is FOR, excerpted — the one piece of evidence an approver has left
 * to judge an `unknown` suggestion by, since by construction neither board signal above fired for
 * it. Its `## Goal` where the bead states one, else the description's opening prose, mirroring
 * pm/bead-line.ts's own `goalOf` (not imported: that module reads the product-master's own board
 * context, and this one has no reason to depend on it for three lines of text).
 *
 * AUTHORED text only ({@link isAuthoredBody}) — the formula's unfilled `TODO — …` prompt is not a
 * hint, and quoting it as one would send the approver chasing a Goal the bead never actually states.
 */
function goalHintOf(bead: Bead): string | undefined {
  const description = typeof bead.description === "string" ? bead.description : "";
  const authored = [goalBody(bead), preambleOf(description)].find(isAuthoredBody);
  const text = (authored ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_GOAL_HINT_CHARS ? `${text.slice(0, MAX_GOAL_HINT_CHARS)}…` : text;
}

/** The epic's own `outcome:<id>` label values — label-safe syntax only, same bar `outcomeIdsOf`
 * holds a hand-authored label to, so a malformed `outcome:bad!` is read as none rather than one. */
function epicOutcomeLabels(epic: Bead): string[] {
  return labelValuesOf(epic.labels, "outcome").filter((id) => AREA_SHAPE.test(id));
}
