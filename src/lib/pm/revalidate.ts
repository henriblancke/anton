/**
 * POST-APPROVAL RE-VALIDATION (anton-xg5y): approved work cannot rot in the queue.
 *
 * The approve gate (anton-6u6y) judges a run target at the moment a founder approves it. Nothing
 * re-judges it afterwards — and a target can sit approved for days waiting for a worker, while its
 * Acceptance is edited away, a feature lands under the legacy epic it hangs off, or somebody draws a
 * `blocks` edge in front of it. The approval outlives the facts it was given for, and the queue
 * quietly holds work anton would now refuse to start.
 *
 * So the pass re-asks the gate's own four questions ({@link makeApprovalGate}) of every
 * approved-but-unclaimed bead, on the product-master cadence. What it finds becomes an ordinary
 * `pm:` proposal: evidence naming each violation, fingerprinted, approved or declined like every
 * other. It NEVER unapproves anything itself — withdrawing a founder's decision without asking is the
 * one move this feature must not make, and the whole design is that the ask goes back to them.
 *
 * DETERMINISTIC, and that is the point of it living beside the LLM pass rather than inside it. There
 * is no judgment here: a missing Acceptance section is a fact, and a fact is anton's to check. It
 * runs as a pre-pass before the session (jobs/product-master.ts) so approval rot surfaces even when
 * the session breaks, and it re-uses the board snapshot that pass already read — no `bd` of its own,
 * per bead or otherwise.
 */
import { makeApprovalGate, type ApprovalGap } from "../approval-gate";
import { beads, type Bead } from "../beads/bd";
import { isClaimed, isInFlight, isOpenWork } from "../gardener/board-index";
import { isProposalBead, makeDetection, type GardenerDetection } from "../gardener/detections";

/**
 * Is this bead approved work that no run has started — the set an approval is still a PROMISE about?
 *
 * "Unclaimed" is a RUN claim, not an assignee: the approve route auto-assigns the target to whoever
 * approved it, so a reservation is the normal state of approved work and requiring `--unassigned`
 * here would find nothing. What must be excluded is work a run owns — mid-flight, or claimed in the
 * window before its lease publishes ({@link isClaimed}). Two reasons, and both are hard: the run is
 * already reading the spec, so the gaps are its problem to hit and report; and withdrawing the
 * `approved` label under a live run kills it outright (execute-epic re-checks approval after its
 * claim settles).
 *
 * Deliberately NOT narrowed to run targets, though the gate's other three questions are only ever
 * interesting for one. Ceasing to be a run target — a legacy epic gaining a feature child, a task
 * re-parented under an epic — is itself the severest rot there is, and a filter here would be exactly
 * what hid it: the bead keeps its `approved` label, the claimable set skips it, and no worker ever
 * comes. The gate answers that as its own `runnable` gap.
 */
const isQueuedApproval = (bead: Bead, nowMs: number): boolean =>
  beads.isApproved(bead) &&
  isOpenWork(bead) &&
  !isProposalBead(bead) &&
  !isClaimed(bead) &&
  !isInFlight(bead, nowMs);

/**
 * Every approved bead that no longer clears the gate it was approved through, as proposals.
 *
 * Pure over the board snapshot — one gate build for the whole pass, then one question per approved
 * bead. A board whose approvals all still hold yields NOTHING, which is the expected outcome and
 * never a failure to look.
 *
 * The fingerprint is keyed to the BEAD, not to the violations, so a target that degrades a second way
 * while the first ask is still open does not file a second proposal: one bead, one "this approval no
 * longer holds" question. The evidence is re-derived at approve time anyway (gardener/apply.ts), so
 * an approver acts on the gaps as they are then, not as they were the night it was filed.
 */
export function revalidateApprovals(board: Bead[], nowMs: number): GardenerDetection[] {
  const gate = makeApprovalGate(board);
  const detections: GardenerDetection[] = [];

  for (const bead of board) {
    if (!isQueuedApproval(bead, nowMs)) continue;
    const gaps = gate.gapsFor(bead);
    if (gaps.length === 0) continue;
    detections.push(
      makeDetection({
        kind: "degraded-approval",
        move: "unapprove",
        subjects: [bead.id],
        summary:
          `${bead.id} is approved but no longer meets the gate it was approved through ` +
          `(${gaps.map((gap) => gap.rule).join(", ")}) — fix it, or withdraw the approval`,
        evidence: [
          standingLine(bead, gaps),
          ...gaps.map(evidenceLine),
          `approving this proposal removes the \`approved\` label and notes why on ${bead.id}; repairing the gaps instead settles it with the approval intact`,
        ],
      }),
    );
  }
  return detections;
}

/**
 * Where the approval leaves this bead standing right now — the line that makes the ask urgent. A
 * degraded SPEC is work a worker can still pick up as it stands; an unrunnable target is the opposite
 * failure, and saying "a worker can pick it up" about it would misstate the harm entirely.
 */
function standingLine(bead: Bead, gaps: ApprovalGap[]): string {
  return gaps.some((gap) => gap.rule === "runnable")
    ? `${bead.id} carries \`approved\` but nothing can dispatch it, so it sits in the queue waiting for a worker that will never come`
    : `${bead.id} carries \`approved\` and no run holds it, so a worker can pick it up as it now stands`;
}

/** One gap as evidence: the gate's own message, prefixed with the promise it breaks. */
function evidenceLine(gap: ApprovalGap): string {
  switch (gap.rule) {
    case "runnable":
      // The one gap that is not about the SPEC: nothing will ever dispatch this bead, so the approval
      // promises a run that cannot happen.
      return `nothing can run it any more: ${gap.message}`;
    case "contract":
      return `the bead contract no longer holds: ${gap.message}`;
    case "structure":
      return `the tier structure no longer holds: ${gap.message}`;
    case "blocked":
      // Almost always an edge drawn SINCE — a fresh approval of a blocked target is refused outright
      // — but a take-over bypasses that gate, so the line states the fact rather than its history.
      return `an ordering edge the approve gate would refuse: ${gap.message}`;
  }
}
