/**
 * The seam between the session's judgment and a write to the founder's board (anton-d2sx): the bars
 * every claim shares, and the walk that hands each kind to the ones only it must clear.
 *
 * The session emits CLAIMS, not beads. A fingerprint is a sha1 of a canonical key and dedup, capping
 * and provenance are mechanical — asking an LLM to produce them would be asking it to be a hash
 * function, and one wrong digit files a duplicate ask forever. So the session's whole output is
 * judgment, and {@link detectionsFor} turns it into the same {@link GardenerDetection} values the
 * gardener's own detectors produce, after checking every claim against the board it was made about.
 *
 * The per-kind bars live with their kind (`order-guards.ts`, `home-guards.ts`, `start-guards.ts`)
 * over the shape they share (`guard.ts`), and what an accepted claim becomes lives in
 * `claim-detection.ts` — so this module holds only what every claim is asked, whatever it proposes.
 */
import { beads, type Bead } from "../beads/bd";
import { indexBoard, isInFlight, isOpenWork, type BoardIndex } from "../gardener/board-index";
import { isProposalBead, type GardenerDetection } from "../gardener/detections";
import { detectionFor } from "./claim-detection";
import { rehomeRefusal } from "./home-guards";
import { orderRefusal } from "./order-guards";
import { startRefusal } from "./start-guards";
import type { PmClaim, PmClaimKill, PmClaimReprioritize } from "./report";

/** A claim the board refused, with the reason — reported, never silently dropped. */
export interface RejectedClaim {
  claim: PmClaim;
  reason: string;
}

export interface DetectionsResult {
  detections: GardenerDetection[];
  rejected: RejectedClaim[];
}

/**
 * Turn the session's claims into detections, dropping every one the board refuses.
 *
 * This check is not defensive padding — it is the seam between a language model's judgment and a
 * write to the founder's board. A claim naming a bead that does not exist, or one a run is shipping
 * right now, would otherwise become a proposal that can only ever refuse at approve time; and a
 * priority "change" to the value the bead already carries is an ask with no content. Each rejection
 * is returned with its reason so the job can report it rather than swallow it — a pass whose claims
 * were all refused looks exactly like a healthy board unless somebody says otherwise.
 *
 * What it deliberately does NOT re-judge is the product question. Whether a bead is worth killing is
 * the session's call, and second-guessing it here would put the judgment in two places.
 */
export function detectionsFor(claims: PmClaim[], board: Bead[], nowMs: number): DetectionsResult {
  const index = indexBoard(board);
  const detections: GardenerDetection[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of claims) {
    const checked = subjectChecked(claim, index, nowMs);
    const refusal =
      "refusal" in checked ? checked.refusal : kindRefusal(claim, checked.subject, index, nowMs);
    if (refusal) {
      rejected.push({ claim, reason: refusal });
      continue;
    }
    detections.push(detectionFor(claim));
  }
  return { detections, rejected };
}

/**
 * The claim's SUBJECT, or why it cannot carry a proposal at all — the bars every kind shares.
 *
 * Returns the bead rather than a boolean so every bar downstream HOLDS the thing those bars proved
 * exists, instead of looking it up again and asserting the guarantee a caller established.
 */
function subjectChecked(
  claim: PmClaim,
  index: BoardIndex,
  nowMs: number,
): { subject: Bead } | { refusal: string } {
  const subject = index.byId.get(claim.bead);
  if (!subject) return { refusal: `${claim.bead} is not on the board` };
  if (isProposalBead(subject)) return { refusal: `${claim.bead} is itself a proposal, not work` };
  if (!isOpenWork(subject)) return { refusal: `${claim.bead} is already settled` };
  if (isInFlight(subject, nowMs)) {
    return { refusal: `${claim.bead} is mid-run — a proposal would race the run` };
  }
  return { subject };
}

/** Why this claim's own move cannot stand, or undefined. */
function kindRefusal(
  claim: PmClaim,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  switch (claim.kind) {
    case "reprioritize":
      return priorityUnchanged(claim, subject);
    case "order":
      return orderRefusal(claim, subject, index, nowMs);
    case "rehome":
      return rehomeRefusal(claim, subject, index, nowMs);
    case "kill":
      return alreadyDeferred(claim, subject);
    case "start":
      return startRefusal(claim, subject, index, nowMs);
    default:
      return undefined;
  }
}

/** A priority "change" to the value the bead already carries is an ask with no content. */
function priorityUnchanged(claim: PmClaimReprioritize, subject: Bead): string | undefined {
  return subject.priority !== undefined && `P${subject.priority}` === claim.priority
    ? `${claim.bead} is already at ${claim.priority}`
    : undefined;
}

// A deferred bead is still OPEN work, so `subjectChecked` waves it through — but a kill applies as
// `defer`, and `planRetire` settles an already-deferred subject without writing anything. Left
// unchecked the ask reaches the board, costs a founder a decision, and settles as a no-op. The
// gardener's stale detector excludes deferred beads for this exact reason (gardener/retire.ts).
function alreadyDeferred(claim: PmClaimKill, subject: Bead): string | undefined {
  return beads.isDeferred(subject)
    ? `${claim.bead} is already deferred — killing it again would change nothing`
    : undefined;
}
