/**
 * EMISSION (anton-9qwq): a detection becomes a PROPOSAL BEAD — the board's own record of a judgment
 * call, rather than a report line that scrolls past. A proposal is an ordinary parentless `task`, so
 * every surface the board already has renders it: it gets a chip, a contract, a detail page, and the
 * approval affordance every other run target has. Nothing here is a new UI concept.
 *
 * Three properties carry this module, and each is a way emission could quietly do harm:
 *
 *   • ONE proposal per claim. The detection's `gardener:<kind>:<hash>` fingerprint rides on the bead
 *     as a label, and a fingerprint already on the board suppresses re-emission — so a patrol that
 *     runs nightly over an unfixed board asks once, not thirty times. (Mirrors the
 *     `stringer:<collector>:<hash>` convention /scan-triage dedups against.)
 *   • DECLINED STAYS DECLINED. Suppression keys on "not settled", not on "open": an abandoned
 *     proposal — anton's won't-do outcome (LABELS.abandoned) — suppresses forever, which is what
 *     makes declining meaningful. A PLAINLY closed proposal (one that was applied, anton-1t3n) does
 *     NOT suppress: the move landed, so the detector has nothing left to find, and if it somehow
 *     does the board really did regress.
 *   • EVIDENCE TRAVELS WITH THE ASK. The detection's evidence lines and `discovered-from` edges to
 *     every bead the move concerns land on the proposal, so an approver can check the reasoning from
 *     the bead itself instead of re-deriving it from the board.
 *
 * Applying an approved proposal is anton-1t3n's job; nothing here mutates a subject bead.
 */
import { beads, type Bead } from "../beads/bd";
import { isOpenWork } from "./board-index";
import { concernedBeads, fingerprintLabelOf, type GardenerDetection } from "./detections";

/** `source:` provenance every proposal carries — the `source:stringer` convention, one namespace over. */
export const GARDENER_SOURCE = "gardener";

/**
 * The labels every proposal carries besides its fingerprint. No `agent:` on purpose: a proposal is a
 * decision, not work an agent implements — the move is applied mechanically through the beads seam.
 */
export const PROPOSAL_LABELS: readonly string[] = [
  "domain:eng",
  "risk:low",
  "size:S",
  `source:${GARDENER_SOURCE}`,
];

/**
 * How many proposals ONE pass may file. A board that has never been tended can yield dozens at once,
 * and a patrol that dumped all of them would bury the product work it sits beside — the queue-quality
 * rule /scan-triage answers with `max_beads_per_scan`. Detections are deterministically ordered, so
 * the overflow is not lost: the next pass emits it, and the caller logs what was held back.
 */
export const MAX_PROPOSALS_PER_PASS = 10;

/**
 * Fingerprints the board says NOT to propose again: every proposal still open, plus every one
 * declined (abandoned). A plainly-closed proposal is absent deliberately — see the module header.
 */
export function suppressedFingerprints(board: Bead[]): Set<string> {
  const out = new Set<string>();
  for (const bead of board) {
    const fingerprint = fingerprintLabelOf(bead);
    if (!fingerprint) continue;
    if (isOpenWork(bead) || beads.isAbandoned(bead)) out.add(fingerprint);
  }
  return out;
}

export interface EmissionPlan {
  /** What this pass files, in detection order, capped at the limit. */
  emit: GardenerDetection[];
  /** Claims the board already carries — open or declined. */
  suppressed: GardenerDetection[];
  /** Fresh claims over the cap. Not dropped: the next pass sees the same detections. */
  deferred: GardenerDetection[];
}

export interface EmissionInput {
  detections: GardenerDetection[];
  /** The full board (`--status all`): a DECLINED proposal is closed, so a live-only read misses it. */
  board: Bead[];
  limit?: number;
}

/**
 * What a pass would file, decided without writing anything. Pure, so the dedup rule — the whole point
 * of the fingerprint — is testable against a fixture board rather than a live one.
 */
export function planEmission(input: EmissionInput): EmissionPlan {
  const limit = input.limit ?? MAX_PROPOSALS_PER_PASS;
  const blocked = suppressedFingerprints(input.board);
  const seen = new Set<string>();
  const fresh: GardenerDetection[] = [];
  const suppressed: GardenerDetection[] = [];

  for (const detection of input.detections) {
    // Two detections with one fingerprint are one claim, however the caller assembled the list.
    if (seen.has(detection.fingerprint)) continue;
    seen.add(detection.fingerprint);
    if (blocked.has(detection.fingerprint)) suppressed.push(detection);
    else fresh.push(detection);
  }

  return { emit: fresh.slice(0, limit), suppressed, deferred: fresh.slice(limit) };
}

/** Exactly the `beads.create` options a proposal is made of — built pure so a test can read them. */
export interface ProposalDraft {
  title: string;
  type: "task";
  labels: string[];
  acceptance: string;
  description: string;
  deps: string[];
}

/**
 * The proposal bead for one detection: the full ticket contract (Goal / Acceptance / Context / Out of
 * scope / Verify), the evidence, the fingerprint, and a `discovered-from` edge to every bead the move
 * concerns — so the proposal is reachable from each bead it would touch, not just the one it acts on.
 *
 * `task` and parentless is what makes it a run target the board renders as a chip; a `chore`, or a
 * child of anything, would be a bead only the tickets list ever shows.
 */
export function proposalDraft(detection: GardenerDetection): ProposalDraft {
  return {
    title: `Gardener: ${moveClause(detection)}`,
    type: "task",
    labels: [detection.fingerprint, ...PROPOSAL_LABELS],
    acceptance: acceptanceOf(detection),
    description: descriptionOf(detection),
    deps: concernedBeads(detection).map((id) => `discovered-from:${id}`),
  };
}

export interface EmittedProposal {
  id: string;
  fingerprint: string;
  detection: GardenerDetection;
}

export interface EmissionResult {
  created: EmittedProposal[];
  /** Claims the board already carried — the count that proves a re-run asked nothing twice. */
  suppressed: number;
  /** Fresh claims held back by the cap, for the caller to log. Never silently dropped. */
  deferred: number;
}

/**
 * File this pass's proposals. Sequential on purpose: each create is a bd write against the same Dolt
 * working set, and a failure part-way leaves the proposals already filed standing — they carry their
 * fingerprints, so the retry that re-reads the board files only what is still missing.
 */
export async function emitProposals(repo: string, input: EmissionInput): Promise<EmissionResult> {
  const plan = planEmission(input);
  const created: EmittedProposal[] = [];

  for (const detection of plan.emit) {
    const id = await beads.create(repo, proposalDraft(detection));
    created.push({ id, fingerprint: detection.fingerprint, detection });
  }

  return { created, suppressed: plan.suppressed.length, deferred: plan.deferred.length };
}

// ── the proposal's prose (pure) ──

/** The move as one imperative clause — what the title, the rubric and the Verify section share. */
function moveClause(detection: GardenerDetection): string {
  const subjects = subjectPhrase(detection);
  switch (detection.move) {
    case "reparent":
      return detection.target
        ? `re-parent ${subjects} under ${detection.target}`
        : `re-parent ${subjects} onto a board card`;
    case "link":
      return `record that ${detection.target ?? "its blocker"} blocks ${subjects}`;
    case "retire":
      if (detection.retireAs === "supersede") {
        return `supersede ${subjects} with ${detection.target ?? "the bead that replaced it"}`;
      }
      return detection.retireAs === "defer" ? `defer ${subjects}` : `close ${subjects}`;
  }
}

/** Ids up to a pair; past that a count, so a cluster's title stays a title. */
function subjectPhrase(detection: GardenerDetection): string {
  return detection.subjects.length <= 2
    ? detection.subjects.join(" and ")
    : `${detection.subjects.length} beads`;
}

/**
 * The state the board is in once the move is applied — the proposal's definition of done. Written as
 * an assertion an approver can check with one `bd show`, not as an instruction to an agent.
 */
function appliedState(detection: GardenerDetection): string {
  const subjects = detection.subjects.join(", ");
  const is = detection.subjects.length === 1 ? "is" : "are";
  switch (detection.move) {
    case "reparent":
      return detection.target
        ? `${subjects} ${is} parented to ${detection.target}`
        : `${subjects} ${is} parented to a board card — a feature, or an epic with no feature children`;
    case "link":
      return `a blocks edge records ${detection.target} → ${subjects}, so ${subjects} leaves the ready set until ${detection.target} lands`;
    case "retire":
      if (detection.retireAs === "supersede") {
        return `${subjects} ${is} closed as superseded by ${detection.target}`;
      }
      return detection.retireAs === "defer"
        ? `${subjects} ${is} deferred — out of the ready set, contract intact`
        : `${subjects} ${is} closed with a reason naming the work that shipped it`;
  }
}

function acceptanceOf(detection: GardenerDetection): string {
  return [
    `- [ ] ${appliedState(detection)}`,
    "- [ ] no other bead is re-parented, linked or retired — the move above is the whole change",
    "- [ ] this proposal is closed with a note naming what changed",
  ].join("\n");
}

function descriptionOf(detection: GardenerDetection): string {
  return [
    "## Goal",
    detection.summary,
    "",
    "## Evidence",
    ...detection.evidence.map((line) => `- ${line}`),
    "",
    "## Context",
    `Filed by the gardener patrol from a \`${detection.kind}\` board-shape detection (anton-e42l).`,
    "This bead is a DECISION, not implementation work: approving it applies the move through the",
    "beads seam, declining it records the reason.",
    "",
    `- move: \`${detection.move}\`${detection.retireAs ? ` (\`${detection.retireAs}\`)` : ""}`,
    `- subjects: ${detection.subjects.join(", ")}`,
    ...(detection.target ? [`- target: ${detection.target}`] : []),
    `- fingerprint: \`${detection.fingerprint}\` — while this bead is open, or once it is declined,`,
    "  the patrol makes this claim no second time",
    "",
    "## Out of scope",
    "- any board change beyond the move above",
    "- the subjects' own contracts, priorities and labels",
    "- the other proposals this pass filed — each is approved or declined on its own",
    "",
    "## Verify",
    `- after applying, the board shows that ${appliedState(detection)}`,
    `- the next patrol files nothing new for \`${detection.fingerprint}\``,
  ].join("\n");
}
