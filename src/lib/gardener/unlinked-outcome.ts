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
import { CODEBASE_HEALTH_OUTCOME_ID } from "../outcomes";
import { isClaimed, isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

/** What scan-triage-produced work always serves — stringer's own beads carry no product outcome of
 * their own to inherit. */
export const STRINGER_OUTCOME = CODEBASE_HEALTH_OUTCOME_ID;

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
 *
 * `validOutcomeIds`, when the caller can afford the read, is every id `readProjectOutcomes` still
 * recognizes (`outcomes.ts` `allOutcomeIds`) — passed through to {@link suggestOutcome} so a parent
 * epic's `outcome:<id>` label naming a typo'd or retired-past-recognition id is never inherited as
 * if it still named something (PR #351 review): without it the suggestion would be proposed,
 * approved, and written, yet `groupFeatureCards` would never recognize it, leaving the card
 * unlinked forever with nothing left to re-ask. It is checked here too, against the SUBJECT's own
 * FIRST `outcome:<id>` label, not only the parent epic's: a target can carry a syntactically valid
 * but nonexistent id of its own (a typo, or one deleted from PRODUCT.md outright), which
 * `groupFeatureCards` would still refuse to group under — the same dead end one layer closer, that
 * this unconditional skip used to let through for good (P2 review, PR #351). The FIRST id
 * specifically, not any of them: `featureCardOf` only ever reads `outcomeIdsOf(bead)[0]`, so
 * recognizing a later, valid label here would suppress this detector while the digest still shows
 * the card unlinked under its dead first label — a proposal that will never fire again to fix it.
 * Undefined (a caller that cannot afford the read) keeps the old unchecked behavior rather than
 * refusing to detect at all.
 */
export function detectUnlinkedOutcomes(
  index: BoardIndex,
  nowMs: number,
  validOutcomeIds?: ReadonlySet<string>,
): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const bead of index.all) {
    if (!isOpenWork(bead) || beads.isDeferred(bead)) continue;
    if (!beads.isRunTarget(bead, index.all)) continue;
    if (isInFlight(bead, nowMs) || isClaimed(bead)) continue;
    const ownOutcomeIds = outcomeIdsOf(bead);
    // The digest only ever groups a card under its FIRST outcome id (feature-cards.ts
    // `featureCardOf`'s `outcomeIdsOf(bead)[0]`) — checking any later id as "recognized" would let
    // a valid secondary label mask a dead first one forever: the digest would still show the card
    // unlinked, but this detector would never re-propose it since SOME id passed.
    const selectedOutcomeId = ownOutcomeIds[0];
    const ownOutcomeRecognized = validOutcomeIds
      ? selectedOutcomeId !== undefined && validOutcomeIds.has(selectedOutcomeId)
      : ownOutcomeIds.length > 0;
    if (ownOutcomeRecognized) continue;

    const suggestion = suggestOutcome(index, bead, validOutcomeIds);
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
          // Only reached when the bead's own label(s) exist but named nothing the project still
          // recognizes — the dead-id case this validation exists to catch, distinct from carrying
          // no label at all (the summary line above already covers that case).
          ...(ownOutcomeIds.length > 0
            ? [
                `${bead.id} carries outcome:${ownOutcomeIds.join(", outcome:")} of its own, but the project's PRODUCT.md no longer defines ${ownOutcomeIds.length === 1 ? "that outcome" : "any of those outcomes"} — treated as unlinked rather than trusted`,
              ]
            : []),
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
   * The parent epic whose own label state DECIDED `outcome` — set whenever one exists, not only
   * when an outcome was actually inherited from it. Named so a caller that is about to WRITE the
   * outcome can lock this bead too (apply-steps.ts `lockedBeads`/`premiseBeadsOf`): even a
   * `codebase-health`/`unknown` fallback was read off the parent's label count (zero vs. one vs.
   * many), so a relabel of the parent between the read and the write can change which rung fires —
   * nothing serializes against that unless the caller locks the parent explicitly.
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
 *
 * `validOutcomeIds`, when passed, is every id the project still recognizes, retired included
 * (`outcomes.ts` `allOutcomeIds`, read off `readProjectOutcomes`) — the epic-inheriting rung checks
 * the parent's single `outcome:<id>` label against it before offering to inherit, so a
 * syntactically valid but nonexistent id (a typo, or one deleted from `## Outcomes` outright, as
 * opposed to merely marked `(retired)`) falls through to `unknown` instead of being inherited as if
 * it still named a real outcome (P2 review, PR #351): `groupFeatureCards` only groups under ids
 * `readProjectOutcomes` returns, so a bad id written here would leave the card unlinked forever
 * with nothing left to re-ask. Omitted entirely, the rung trusts the label as before — callers that
 * cannot afford the read still get the old guess rather than no detection at all.
 */
export function suggestOutcome(
  index: BoardIndex,
  bead: Bead,
  validOutcomeIds?: ReadonlySet<string>,
): Suggestion {
  const parentId = beads.parentOf(bead);
  const parent = parentId ? index.byId.get(parentId) : undefined;
  const parentEpic = parent && beads.isEpic(parent) ? parent : undefined;

  if (parentEpic) {
    const epicOutcomes = epicOutcomeLabels(parentEpic);
    if (epicOutcomes.length === 1 && (!validOutcomeIds || validOutcomeIds.has(epicOutcomes[0]))) {
      return {
        outcome: epicOutcomes[0],
        evidence: [
          `its parent epic ${parentEpic.id} carries exactly one outcome:${epicOutcomes[0]} label — inherit it`,
        ],
        parent: parentEpic.id,
      };
    }
    if (epicOutcomes.length === 1) {
      return {
        outcome: UNKNOWN_OUTCOME,
        evidence: [
          `its parent epic ${parentEpic.id} carries outcome:${epicOutcomes[0]}, but the project's PRODUCT.md no longer defines that outcome — ask the operator rather than inherit a dead id`,
        ],
        parent: parentEpic.id,
      };
    }
    if (epicOutcomes.length > 1) {
      return {
        outcome: UNKNOWN_OUTCOME,
        evidence: [
          `its parent epic ${parentEpic.id} carries ${epicOutcomes.length} outcome labels (${epicOutcomes.join(", ")}) — no single one to inherit`,
        ],
        parent: parentEpic.id,
      };
    }
  }

  if (labelValueOf(bead.labels, "source") === "stringer") {
    return {
      outcome: STRINGER_OUTCOME,
      evidence: [`${bead.id} carries source:stringer — scan-triage-produced work always serves ${STRINGER_OUTCOME}`],
      parent: parentEpic?.id,
    };
  }

  return {
    outcome: UNKNOWN_OUTCOME,
    evidence: [`neither a parent epic's outcome nor a source:stringer label suggests one — ask the operator which outcome this serves`],
    parent: parentEpic?.id,
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
