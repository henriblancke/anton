/**
 * Rework: send a ticket back with instructions (anton-4ocm).
 *
 * A self-review scores every run, but until now acting on a bad score meant a hand-typed `bd note` +
 * `bd reopen` in a terminal — so the loop the score was supposed to close stayed open. This module
 * is that action, in one call, with the provenance the board needs to stay honest afterwards:
 *
 *   • REOPEN — the acceptance was never actually met. The same bead runs again, carrying the
 *     founder's instructions as a human note and a `--reason` on the reopen event. Its earlier
 *     rounds keep their scores, because they scored the work that was actually delivered then.
 *   • FOLLOW-UP — the acceptance WAS met and the founder wants another pass. A NEW bead carries the
 *     instructions, linked `discovered-from` the original, so the original's score stays attached to
 *     what it shipped instead of being re-earned by later work.
 *
 * The choice is the caller's and is never inferred: which of the two is right is a judgement about
 * whether the ticket lied about being done, and only a human reading the review can make it.
 *
 * Both paths land the instructions as a HUMAN note, because that is the channel the dispatch prompt
 * already reads (`humanNotesPromptBlock`, lib/jobs/step-registry.ts) — so the implementer that picks
 * the bead up next is shown the steer without a new prompt seam.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { refreshAllIssues } from "./beads/issues";
import { formatHumanNote, parseTicketNotes } from "./beads/notes";
import { nudgeSync } from "./beads/sync-nudge";
import { runIsLiveForTarget } from "./jobs/service";
import type { ReviewFinding } from "./jobs/review-context";
import { resolveOperator } from "./operator";
import { isBoardCard, runTickets } from "./ticket-view";
import {
  MAX_REWORK_INSTRUCTIONS_CHARS,
  MAX_REWORK_SUMMARY_CHARS,
  type Project,
  type ReworkMode,
  type ReworkResult,
} from "./types";

/** The founder's decision, as the route receives it. */
export interface ReworkInput {
  /** The ticket being sent back — the run target itself, or one of the tickets under it. */
  ticketId: string;
  mode: ReworkMode;
  /** One line: the reopen's `--reason`, or the follow-up bead's title. */
  summary: string;
  /** What to actually do — inlined verbatim into the implementer's prompt. */
  instructions: string;
  /** Findings the founder selected from the review report, appended to the instructions. */
  findings?: ReviewFinding[];
}

/** The request itself is malformed (missing/oversized text) — the caller's fault (400). */
export class ReworkInvalidError extends Error {}

/** The bead exists but this rework can't apply to it (422): not a run target, not one of its tickets. */
export class ReworkNotAllowedError extends Error {}

/** A run is executing this target right now, so sending its work back would race it (409). */
export class ReworkConflictError extends Error {}

/** Nothing on the board answers to that id (404). */
export class ReworkNotFoundError extends Error {}

/**
 * Labels a follow-up inherits from the ticket it came from. Routing, not state: `agent:` decides
 * which specialist the run dispatches (and which the agent gate checks), and the rest are the
 * shaping metadata the board filters and sorts on. Everything else is deliberately NOT copied —
 * `approved` is the founder's gate on the new work, `stage:`/`run-lease:`/`review-score:` describe a
 * run the follow-up never had, and `abandoned` would create it already dead.
 */
const INHERITED_LABEL_PREFIXES = ["agent:", "domain:", "risk:", "size:", "area:"];

/**
 * Apply a rework to one ticket of a run target.
 *
 * Idempotent by construction rather than by token: a repeat of the same request finds its own note
 * already on a bead already in the state it wanted (reopen) or its own follow-up already linked
 * (follow-up) and writes nothing, so a double-click leaves one note and one bead. The check and the
 * write are serialized on the ticket's own write lock, which is what makes that hold for two
 * requests in flight at once.
 */
export async function reworkTicket(
  project: Project,
  targetId: string,
  input: ReworkInput,
): Promise<ReworkResult> {
  const summary = input.summary?.trim() ?? "";
  const instructions = input.instructions?.trim() ?? "";
  // A missing id is a malformed request (400), not a rework that can't apply (422) — without this it
  // would fall through to the membership check and be reported as `'' is not part of <target>'s run`.
  const ticketId = input.ticketId?.trim() ?? "";
  if (!ticketId) throw new ReworkInvalidError("A ticket to send back is required");
  if (!summary) throw new ReworkInvalidError("A one-line summary is required");
  if (summary.length > MAX_REWORK_SUMMARY_CHARS) {
    throw new ReworkInvalidError(
      `Summary is too long (${summary.length} > ${MAX_REWORK_SUMMARY_CHARS} characters)`,
    );
  }
  if (!instructions) throw new ReworkInvalidError("Fix instructions are required");
  if (instructions.length > MAX_REWORK_INSTRUCTIONS_CHARS) {
    throw new ReworkInvalidError(
      `Instructions are too long (${instructions.length} > ${MAX_REWORK_INSTRUCTIONS_CHARS} characters)`,
    );
  }
  if (input.mode !== "reopen" && input.mode !== "follow-up") {
    throw new ReworkInvalidError(`Unknown rework mode "${String(input.mode)}"`);
  }

  // Force a fresh read, like approve/claim: a mutating decision about what a run contains must not
  // be made from a warm board snapshot that could still show a ticket the last run closed.
  const all = await refreshAllIssues(project.repoPath);
  const target = all.find((b) => b.id === targetId);
  if (!target) throw new ReworkNotFoundError(`Ticket ${targetId} not found on the board`);
  if (!beads.isRunTarget(target, all)) {
    throw new ReworkNotAllowedError(
      `${targetId} is not a run target — rework is decided against a run's review report, so send ` +
        `back a ticket of the feature (or standalone item) that actually ran`,
    );
  }
  const ticket = runMembers(target, all).find((b) => b.id === ticketId);
  if (!ticket) {
    throw new ReworkNotAllowedError(
      `${ticketId} is not part of ${targetId}'s run — only the work that run reviewed can be ` +
        `sent back from its report`,
    );
  }

  // Race-check against a live run, exactly where approve/claim do (409): rework rewrites the ticket
  // set — and the ticket's own status — that a running execute-epic is walking, so applying it
  // mid-run would either be silently overwritten by that run's own close or make it re-dispatch a
  // ticket it is already implementing. Both machines are checked: the local job (what a cancel would
  // reach) and the cross-machine run-lease on the target (the only evidence another host is on it).
  assertNoLiveRun(project.id, target);

  const result = await withBeadWriteLock(project.repoPath, ticket.id, () =>
    input.mode === "reopen"
      ? applyReopen(project, target, ticket, summary, instructions, input.findings ?? [])
      : applyFollowUp(project, target, ticket, summary, instructions, input.findings ?? []),
  );

  // Fire-and-forget, like every other board write behind a route: the writes already landed locally
  // and the run reads local state, so don't block the response on a slow/unreachable remote.
  if (result.applied) nudgeSync(project, "rework");
  const warning = pipelineWarning(target);
  return { ...result, ...(warning ? { warning } : {}) };
}

/**
 * The beads a run target's review actually covers: its tickets, or the target itself when it is one
 * unit of work. The same pair epic-detail renders and execute-epic dispatches, so the founder can
 * send back exactly what the reviewer was shown — no more.
 */
function runMembers(target: Bead, all: Bead[]): Bead[] {
  const children = runTickets(all, target.id);
  return beads.groupsChildren(target, children) ? children : [target];
}

/**
 * Refuse while a run holds this target — on this machine or, via the lease label, on any other.
 *
 * A boundary, not a lock, for the same reason `abandonTicket`'s is: a run STARTING in the window
 * between this read and the writes below is absorbed one layer down, where execute-epic re-reads the
 * board at every ticket boundary. What this catches is the case a re-read cannot — a founder acting
 * on a review report while the run that produced it is still writing the beads it names.
 */
function assertNoLiveRun(projectId: string, target: Bead): void {
  if (runIsLiveForTarget(projectId, target.id)) {
    throw new ReworkConflictError(
      `${target.id} has a run in flight — sending its work back now would race the run that is ` +
        `writing it; wait for the run to finish or park it first`,
    );
  }
  if (beads.isRunLive(target, Date.now())) {
    throw new ReworkConflictError(
      `${target.id} is being run on another machine (it holds a live run-lease) — wait for that run ` +
        `to settle before sending its work back`,
    );
  }
}

/**
 * Why the reworked bead will sit idle despite being open, when it will. A run target whose PR is
 * already open finishes as complete on its next attempt (execute-epic step 0a short-circuits on a
 * live PR ref), so the bead would wait for a PR nobody told the founder about. Say so rather than
 * promise a pickup that can't happen.
 */
function pipelineWarning(target: Bead): string | undefined {
  const pr = beads.getPrRef(target);
  if (!pr) return undefined;
  return (
    `${target.id} still has an open pull request (${pr}) — its next run finishes as already-complete ` +
    `while that PR is live, so merge or close it before re-running the target`
  );
}

/**
 * Reopen: the note, then the status. Ordered that way deliberately — a note on a bead that failed to
 * reopen is a recoverable half-step (the founder sees their instructions and can reopen by hand),
 * while a reopened bead with no instructions is a ticket re-dispatched against the SAME spec that
 * just failed review, which is how a converge loop grinds.
 */
async function applyReopen(
  project: Project,
  target: Bead,
  ticket: Bead,
  summary: string,
  instructions: string,
  findings: ReviewFinding[],
): Promise<ReworkResult> {
  const repo = project.repoPath;
  const author = await resolveAuthor();
  const body = reworkNoteBody({ mode: "reopen", targetId: target.id, summary, instructions, findings });

  // Re-read under the lock: the dedupe is decided on the note blob as it is at the instant we write,
  // so a request that lost the race to an identical one sees its work already done. "Already done"
  // is the note AND the state the rework produces — an open bead with the finished run's stage
  // labels gone. On text alone, sending the same instructions back a SECOND time (after a later run
  // re-closed the ticket) would skip the reopen and leave the bead closed while the founder is told
  // it went back.
  const fresh = await beads.show(repo, ticket.id);
  if (hasHumanNote(fresh, body) && fresh.status !== "closed" && !hasStageLabel(fresh)) {
    return { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: false };
  }

  const note = formatHumanNote(body, author, new Date());
  await beads.note(repo, ticket.id, note, author || undefined);
  // A ticket the run never closed (it parked before the close, or the founder is reworking mid-flight)
  // is already open — `bd reopen` has nothing to do there, and the reason lives in the note either way.
  if (fresh.status === "closed") {
    await beads.reopen(repo, ticket.id, `rework: ${summary}`);
  }
  // The stage labels describe the run that just finished with this bead. Left on, `stage:in-review`
  // makes a standalone target resume-SKIPPED (ticket-view's `resumeSkipped`) — the run would walk
  // straight past the ticket it was just told to redo — and `stage:implementing` makes a reopened
  // bead derive as in-progress on every board surface.
  await beads.untag(repo, ticket.id, [LABELS.stage("implementing"), LABELS.stage("in-review")]);
  return { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: true };
}

/**
 * Follow-up: a new, contract-shaped bead carrying the instructions, linked `discovered-from` the
 * original. The original is left exactly as it shipped — that is the whole point of choosing this
 * mode — and gains only a provenance note pointing at what came out of its review.
 *
 * Where the new bead is PARENTED decides whether it re-enters the pipeline at all. Under a board
 * card (a feature or a non-container epic) it becomes another ticket of that target's next run.
 * Under a standalone task/bug it would become a ticket of NO run — `boardCards` only cards epics and
 * features, so nothing would ever dispatch it — so there it is created parentless, which makes it a
 * run target in its own right, claimable and approvable like any other standalone item.
 */
async function applyFollowUp(
  project: Project,
  target: Bead,
  ticket: Bead,
  summary: string,
  instructions: string,
  findings: ReviewFinding[],
): Promise<ReworkResult> {
  const repo = project.repoPath;
  const author = await resolveAuthor();
  const body = reworkNoteBody({
    mode: "follow-up",
    targetId: target.id,
    summary,
    instructions,
    findings,
    originId: ticket.id,
  });

  // Re-read the board UNDER the lock, like the reopen path re-reads the bead: the pre-lock snapshot
  // was taken before a rival request could have created the very follow-up this one would duplicate,
  // and the whole point of the lock is that the loser sees the winner's work.
  const all = await refreshAllIssues(repo);
  const existing = existingFollowUp(all, ticket.id, summary);
  if (existing) {
    return {
      mode: "follow-up",
      ticketId: ticket.id,
      reworkedId: existing.id,
      note: body,
      applied: false,
    };
  }

  const parentId = isBoardCard(target, all) ? target.id : undefined;
  const followUpId = await beads.create(repo, {
    title: summary,
    type: "task",
    description: followUpDescription({ summary, ticket, targetId: target.id, parentId }),
    labels: inheritedLabels(ticket),
    ...(parentId ? { deps: [`parent-child:${parentId}`] } : {}),
  });
  // Provenance, and the reason this bead exists at all: `bd link <new> <origin> --type
  // discovered-from`. Written before the note so a failure leaves an unlinked bead the founder can
  // see and link, rather than an instruction on a bead nothing points at.
  await beads.link(repo, followUpId, ticket.id, "discovered-from");
  await beads.note(repo, followUpId, formatHumanNote(body, author, new Date()), author || undefined);
  // The original keeps its score and its status; all it gains is a pointer to what its review produced.
  await beads.note(
    repo,
    ticket.id,
    formatHumanNote(
      `Follow-up ${followUpId} was opened from this ticket's review — its acceptance stands; the ` +
        `next iteration is tracked there.`,
      author,
      new Date(),
    ),
    author || undefined,
  );
  return { mode: "follow-up", ticketId: ticket.id, reworkedId: followUpId, note: body, applied: true };
}

/**
 * A follow-up this request would only duplicate: a bead already linked `discovered-from` the ticket,
 * with the same title, that hasn't been settled. Title AND edge, because the edge alone would make
 * every LATER rework of the same ticket a no-op — a founder is entitled to send the same ticket back
 * twice for two different reasons.
 */
function existingFollowUp(all: Bead[], ticketId: string, summary: string): Bead | undefined {
  const title = summary.trim().toLowerCase();
  return all.find(
    (b) =>
      b.status !== "closed" &&
      (b.title ?? "").trim().toLowerCase() === title &&
      (b.dependencies ?? []).some(
        (d) => d?.type === "discovered-from" && d.issue_id === b.id && d.depends_on_id === ticketId,
      ),
  );
}

/** The routing/shaping labels a follow-up carries over — see {@link INHERITED_LABEL_PREFIXES}. */
function inheritedLabels(ticket: Bead): string[] {
  return (ticket.labels ?? []).filter((l) => INHERITED_LABEL_PREFIXES.some((p) => l.startsWith(p)));
}

/** Stage labels a reopen strips — one still on the bead means this rework's untag hasn't run yet. */
function hasStageLabel(bead: Bead): boolean {
  const stages: string[] = [LABELS.stage("implementing"), LABELS.stage("in-review")];
  return (bead.labels ?? []).some((l) => stages.includes(l));
}

/** Is this exact instruction already on the bead as a human note? Half of the double-submit guard. */
function hasHumanNote(bead: Bead, body: string): boolean {
  const wanted = normalize(body);
  return parseTicketNotes(bead.notes).some(
    (n) => n.source === "human" && normalize(n.text) === wanted,
  );
}

/** Whitespace-insensitive comparison, so a note round-tripped through the blob still matches itself. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The instruction note both modes write. One rendering, so a founder reading the bead later sees the
 * same thing the implementer was handed: what was decided, what to do, and the reviewer's own words
 * for the problems it is meant to fix.
 */
export function reworkNoteBody(args: {
  mode: ReworkMode;
  targetId: string;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
  /** For a follow-up: the ticket this bead was discovered from. */
  originId?: string;
}): string {
  const head =
    args.mode === "reopen"
      ? `Rework — acceptance not met. Sent back from ${args.targetId}'s self-review: ${args.summary}`
      : `Follow-up on ${args.originId} — its acceptance stands; ${args.targetId}'s self-review ` +
        `prompted another pass: ${args.summary}`;
  return [
    head,
    ``,
    args.instructions,
    ...(args.findings.length > 0
      ? [
          ``,
          `Findings to fix (from the self-review):`,
          ...args.findings.map((f) => `- [${f.severity}] ${f.location} — ${f.note}`),
        ]
      : []),
  ].join("\n");
}

/**
 * The follow-up bead's contract. Every section the bead contract judges is written, because an
 * unshaped bead is refused by the approve route and poison-parks the runner — a rework that produced
 * one would hand the founder a follow-up they cannot run.
 *
 * The instructions themselves are NOT repeated here: they are the human note on the same bead, which
 * the dispatch prompt inlines, and duplicating them would leave two copies to drift apart the first
 * time the founder edits one.
 */
function followUpDescription(args: {
  summary: string;
  ticket: Bead;
  targetId: string;
  parentId?: string;
}): string {
  const { summary, ticket, targetId, parentId } = args;
  return [
    `## Goal`,
    summary,
    ``,
    `## Acceptance`,
    `- [ ] ${summary}`,
    `- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply`,
    ``,
    `## Context`,
    `Discovered from ${ticket.id} — ${ticket.title}. That ticket's acceptance was met and it keeps ` +
      `its review score; this bead carries the next iteration ${targetId}'s self-review prompted. ` +
      `The founder's instructions and the findings they selected are the human note on this bead.`,
    parentId
      ? `It runs as a ticket of ${parentId}, in that target's next run.`
      : `It is its own run target — approve it to run.`,
    ``,
    `## Out of scope`,
    `Anything beyond the instructions in the note. ${ticket.id} already shipped its own acceptance; ` +
      `re-litigating it belongs on that ticket, not here.`,
    ``,
    `## Verify`,
    `The project's own checks stay green, and the run's self-review scores this bead against the ` +
      `acceptance above.`,
  ].join("\n");
}

/**
 * Who the note is attributed to. An unresolvable identity is not a reason to refuse — like a plain
 * note, a rework takes nothing from anyone — so `formatHumanNote`'s generic author stands in.
 */
async function resolveAuthor(): Promise<string> {
  return (await resolveOperator()) ?? "";
}
