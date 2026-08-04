/**
 * RETIREMENT CANDIDATES (anton-02oc): open beads reality has already moved past — superseded by
 * landed work, silent far past their status's threshold, or shipped by a commit nobody closed.
 *
 * Every one of these is grounded in the HYGIENE REPORT rather than re-derived from the board, for
 * the reason the patrol itself gives (src/lib/jobs/gardener.ts): bd owns `stale`, `orphans` and
 * `duplicates`, and a second implementation here would drift from the one `bd ready` and the CLI
 * answer to. What this module adds is the judgment bd deliberately withholds — which of those
 * findings are worth ASKING a human to retire, and with which verb.
 *
 * The bar is higher than the report's, on purpose. A finding is a line someone reads; a proposal is
 * a bead on the board asking for a decision. Anything mid-flight is off limits, and staleness has to
 * be an order of magnitude past "worth mentioning" before it is worth proposing.
 */
import { beads, type Bead } from "../beads/bd";
import type { HygieneFinding } from "../hygiene";
import {
  ageInDays,
  isInFlight,
  isOpenWork,
  stampOf,
  ticketOwnerOf,
  type BoardIndex,
} from "./board-index";
import { makeDetection, type GardenerDetection, type GardenerDetectionKind } from "./detections";

/**
 * How long untouched before retirement is worth PROPOSING, per status — deliberately far past the
 * report windows (30/7 days, see gardener.ts). The report says "this has gone quiet"; a proposal
 * says "let's write it off", and a month of quiet is normal for a backlog nobody has re-prioritised
 * yet. Three months of silence on an open bead, or three weeks on one claimed as in-flight, is a
 * decision that was already made and never recorded.
 */
export const RETIRE_STALE_OPEN_DAYS = 90;
export const RETIRE_STALE_IN_PROGRESS_DAYS = 21;

/**
 * Which claim wins when several fire on one bead — most certain first. A bead that a commit shipped
 * is CLOSED work regardless of how long it has been quiet; proposing both "close it, it shipped" and
 * "defer it, it went cold" would ask an approver to arbitrate between two of anton's own detectors.
 */
const RETIRE_PRECEDENCE: readonly GardenerDetectionKind[] = ["shipped-orphan", "superseded", "stale"];

/**
 * Every retirement candidate the hygiene report supports, one per bead. `findings` is the report
 * tier's output; an empty list yields nothing, which is the honest answer for a patrol that has not
 * run its report verbs.
 */
export function detectRetirementCandidates(
  index: BoardIndex,
  findings: HygieneFinding[],
  nowMs: number,
): GardenerDetection[] {
  const candidates = [
    ...detectSuperseded(index, findings, nowMs),
    ...detectShippedOrphans(index, findings, nowMs),
    ...detectStale(index, findings, nowMs),
  ];
  return mostCertainPerBead(candidates);
}

/**
 * An open bead whose identical twin already CLOSED — `bd duplicates` groups beads by content, so a
 * group straddling closed and open means the work landed once and the rest are paperwork. Superseded
 * rather than closed: the survivor's id is the whole point of the record.
 *
 * A group with no closed member is a plain duplicate and stays a report line — merging live
 * duplicates is a different judgment, and the patrol's own docs put it out of scope.
 */
function detectSuperseded(
  index: BoardIndex,
  findings: HygieneFinding[],
  nowMs: number,
): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const finding of findings) {
    if (finding.kind !== "duplicate") continue;
    const members = (finding.ids ?? [])
      .map((id) => index.byId.get(id))
      .filter((b): b is Bead => b !== undefined);
    const landed = members.filter((b) => b.status === "closed" && !beads.isAbandoned(b));
    if (landed.length === 0) continue;

    // The most recently written closed twin is the one that actually carries the work's history.
    const survivor = [...landed].sort(byRecencyThenId)[0];

    for (const member of members) {
      if (!isOpenWork(member) || runOwned(index, member, nowMs)) continue;
      if (strandsOpenWork(index, member)) continue;
      detections.push(
        makeDetection({
          kind: "superseded",
          move: "retire",
          retireAs: "supersede",
          subjects: [member.id],
          target: survivor.id,
          summary: `${member.id} is superseded by ${survivor.id}, which already landed`,
          evidence: [
            `bd duplicates groups ${member.id} with ${members.map((m) => m.id).join(", ")} — identical content`,
            `${survivor.id} ("${survivor.title}") is closed: that is where the work landed`,
            `${member.id} is still ${member.status}, so the board double-counts work that shipped once`,
          ],
        }),
      );
    }
  }

  return detections;
}

/**
 * Closed in git, open on the board — `bd orphans` matches commit messages to bead ids, so a commit
 * naming this bead already shipped it. The move is a plain close with a reason: the work happened,
 * and any other verb would misrepresent it.
 *
 * A bead already in review is skipped: its run's merge finalization closes it, and a proposal here
 * would race the runner to the same outcome.
 */
function detectShippedOrphans(
  index: BoardIndex,
  findings: HygieneFinding[],
  nowMs: number,
): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const finding of findings) {
    if (finding.kind !== "orphan" || !finding.beadId) continue;
    const bead = index.byId.get(finding.beadId);
    if (!bead || !isOpenWork(bead) || runOwned(index, bead, nowMs)) continue;
    if (strandsOpenWork(index, bead)) continue;
    detections.push(
      makeDetection({
        kind: "shipped-orphan",
        move: "retire",
        retireAs: "close",
        subjects: [bead.id],
        summary: `${bead.id} shipped in a commit but is still ${bead.status} on the board`,
        evidence: [
          `bd orphans: ${finding.detail}`,
          `${bead.id} ("${bead.title}") carries no PR ref and no live run — nothing will close it on its own`,
        ],
      }),
    );
  }

  return detections;
}

/**
 * Silence far past the threshold for the bead's status. The two windows differ because the silence
 * means different things: an untouched OPEN bead is a backlog nobody re-picked, while an untouched
 * IN_PROGRESS one is a run that died — it still reads as in-flight to every other reader of the
 * board, including anton's own claim protocol.
 *
 * Both retire as `defer`, not `close`: nothing here says the work is unwanted, only that it is not
 * happening. Deferring parks it out of the ready set with its contract intact, which is the reversible
 * half of the decision; closing an in-progress bead would read as shipped.
 */
function detectStale(
  index: BoardIndex,
  findings: HygieneFinding[],
  nowMs: number,
): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const finding of findings) {
    const threshold =
      finding.kind === "stale-open"
        ? RETIRE_STALE_OPEN_DAYS
        : finding.kind === "stale-in-progress"
          ? RETIRE_STALE_IN_PROGRESS_DAYS
          : undefined;
    if (threshold === undefined || !finding.beadId) continue;

    const bead = index.byId.get(finding.beadId);
    if (!bead || !isOpenWork(bead) || beads.isDeferred(bead) || runOwned(index, bead, nowMs)) {
      continue;
    }

    // No readable stamp ⇒ no measurable age ⇒ no proposal. The report line already carries bd's own
    // verdict for a human; a retirement ask with nothing to point at is worse than silence.
    const age = ageInDays(bead, nowMs);
    if (age === undefined || age < threshold) continue;

    detections.push(
      makeDetection({
        kind: "stale",
        move: "retire",
        retireAs: "defer",
        subjects: [bead.id],
        summary: `${bead.id} has been ${bead.status} and untouched for ${age} days — defer it out of the ready set`,
        evidence: [
          `bd stale: ${finding.detail}`,
          `last written ${stampOf(bead)} — ${age} days ago, past the ${threshold}-day retirement window for ${bead.status}`,
          bead.assignee
            ? `still assigned to ${bead.assignee} with no live run lease — the claim outlived the run`
            : `unclaimed, with no PR ref and no live run`,
        ],
      }),
    );
  }

  return detections;
}

/**
 * Is a run mid-flight over this bead — over the bead ITSELF, or over the run target whose ticket set
 * it rides? The second half is the one a per-bead signal cannot see: a grouped run's lease lives on
 * the target, so a ticket it has selected but not yet reached reads as free work (see
 * {@link ticketOwnerOf}). Proposing to retire one asks a human to abort a live run — apply refuses
 * it under the target's own write lock (apply.ts `planRetire`), and this keeps the ask off the board.
 */
function runOwned(index: BoardIndex, bead: Bead, nowMs: number): boolean {
  if (isInFlight(bead, nowMs)) return true;
  const owner = ticketOwnerOf(index, bead);
  return owner !== undefined && isInFlight(owner, nowMs);
}

/**
 * Would SETTLING this bead (close/supersede) leave open work hanging under it? Those children would
 * sit beneath a card no run can reach — the unreachable state `detectContainerOrphans` flags — so the
 * subtree is retired from the bottom up or not at all. Apply re-checks this against a fresh board
 * (see apply.ts `planRetire`); here it keeps a proposal nobody could approve off the board, and bd's
 * own report line still names the bead for a human.
 *
 * `defer` is deliberately not gated: it parks the subtree with its contract intact and is undone by
 * reopening the parent.
 */
function strandsOpenWork(index: BoardIndex, bead: Bead): boolean {
  return index.openDescendants(bead.id).length > 0;
}

/** One retirement ask per bead, keeping the most certain claim (see {@link RETIRE_PRECEDENCE}). */
function mostCertainPerBead(detections: GardenerDetection[]): GardenerDetection[] {
  const best = new Map<string, GardenerDetection>();
  for (const detection of detections) {
    const [beadId] = detection.subjects;
    const held = best.get(beadId);
    if (!held || rankOf(detection) < rankOf(held)) best.set(beadId, detection);
  }
  return [...best.values()];
}

const rankOf = (d: GardenerDetection): number => {
  const rank = RETIRE_PRECEDENCE.indexOf(d.kind);
  return rank === -1 ? RETIRE_PRECEDENCE.length : rank;
};

/** Newest first; an undated bead sorts last, then by id so the pick is stable across patrols. */
function byRecencyThenId(a: Bead, b: Bead): number {
  const sa = stampOf(a);
  const sb = stampOf(b);
  if (sa !== sb) {
    if (!sa) return 1;
    if (!sb) return -1;
    return sa > sb ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}
