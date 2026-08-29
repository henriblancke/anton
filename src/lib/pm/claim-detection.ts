/**
 * What an ACCEPTED claim becomes (anton-d2sx): the same {@link GardenerDetection} shape the
 * gardener's own detectors produce, so emission and apply need learn nothing about the pm pass.
 *
 * The only part of the pm claim path that is not a refusal, so it sits apart from `refusals.ts` and
 * its guards: this module maps a claim the board already accepted, and never judges one.
 */
import { makeDetection, type GardenerDetection } from "../gardener/detections";
import { CLAIM_KINDS, type PmClaim } from "./report";

/** The detection one accepted claim becomes — the shape both emission and apply already speak. */
export function detectionFor(claim: PmClaim): GardenerDetection {
  switch (claim.kind) {
    case "reprioritize":
      return makeDetection({
        kind: CLAIM_KINDS.reprioritize,
        move: "reprioritize",
        subjects: [claim.bead],
        detail: claim.priority,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "order":
      return makeDetection({
        kind: CLAIM_KINDS.order,
        move: "link",
        subjects: [claim.bead],
        target: claim.blockedBy,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "rehome":
      return makeDetection({
        kind: CLAIM_KINDS.rehome,
        move: "reparent",
        subjects: [claim.bead],
        // Always a target, never the gardener's targetless "which feature?" ask: the session that
        // makes a home claim has already named the home, and one without it never parses.
        target: claim.home,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "split":
      return makeDetection({
        kind: CLAIM_KINDS.split,
        move: "split",
        subjects: [claim.bead],
        summary: claim.summary,
        // The sketch rides with the evidence because it IS part of the claim: a split proposal
        // without a decomposition asks a founder to do the thinking the pass was run to do.
        evidence: [
          ...claim.evidence,
          ...claim.pieces.map((piece, i) => `proposed ticket ${i + 1}: ${piece}`),
        ],
      });
    case "kill":
      return makeDetection({
        kind: CLAIM_KINDS.kill,
        move: "retire",
        retireAs: "defer",
        subjects: [claim.bead],
        summary: claim.summary,
        evidence: claim.evidence,
      });
  }
}
