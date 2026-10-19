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
import { AREA_SHAPE } from "../epic-patch";
import { isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

/** What scan-triage-produced work always serves (outcomes.ts's built-in) — stringer's own beads
 * carry no product outcome of their own to inherit. */
export const STRINGER_OUTCOME = "codebase-health";

/** The suggestion that asks the operator rather than guessing — neither signal below fired. */
export const UNKNOWN_OUTCOME = "unknown";

/**
 * Every open run target with no outcome to group under, each with a deterministic suggestion.
 *
 * Closed and deferred beads are skipped — `isOpenWork` plus an explicit {@link beads.isDeferred}
 * check, the same pair {@link detectStale} in retire.ts holds a bead to, since `deferred` is a
 * status `isOpenWork` alone does not exclude. A bead's own proposals never reach here at all: the
 * caller indexes the board through {@link indexWorkBoard}, which filters them before any detector
 * sees a snapshot.
 */
export function detectUnlinkedOutcomes(index: BoardIndex): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const bead of index.all) {
    if (!isOpenWork(bead) || beads.isDeferred(bead)) continue;
    if (!beads.isRunTarget(bead, index.all)) continue;
    if (outcomeIdsOf(bead).length > 0) continue;

    const suggestion = suggestOutcome(index, bead);
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
        ],
      }),
    );
  }

  return detections;
}

interface Suggestion {
  outcome: string;
  evidence: string[];
}

/**
 * The deterministic guess, in the order the acceptance criteria states it: inherit the parent
 * epic's own outcome when it names exactly one, fall back to the stringer default, and otherwise
 * ask. Each rung only fires when the one above it found nothing to read.
 */
function suggestOutcome(index: BoardIndex, bead: Bead): Suggestion {
  const parentId = beads.parentOf(bead);
  const parent = parentId ? index.byId.get(parentId) : undefined;
  if (parent && beads.isEpic(parent)) {
    const epicOutcomes = epicOutcomeLabels(parent);
    if (epicOutcomes.length === 1) {
      return {
        outcome: epicOutcomes[0],
        evidence: [`its parent epic ${parent.id} carries exactly one outcome:${epicOutcomes[0]} label — inherit it`],
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

/** The epic's own `outcome:<id>` label values — label-safe syntax only, same bar `outcomeIdsOf`
 * holds a hand-authored label to, so a malformed `outcome:bad!` is read as none rather than one. */
function epicOutcomeLabels(epic: Bead): string[] {
  return labelValuesOf(epic.labels, "outcome").filter((id) => AREA_SHAPE.test(id));
}
