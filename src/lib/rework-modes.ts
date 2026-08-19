/**
 * The two things a send-back can DO, and nothing else: reopen the ticket that lied about being done,
 * or open a follow-up beside the one that shipped. Which of the two is right is the founder's
 * judgement ({@link ReworkRequest}) as the target's pull request may have redirected it
 * ({@link planRework}); this module only applies the answer.
 *
 * Both paths land the instructions as a HUMAN note, because that is the channel the dispatch prompt
 * already reads (`humanNotesPromptBlock`, lib/jobs/step-registry.ts) — so the implementer that picks
 * the bead up next is shown the steer without a new prompt seam.
 */
import { beads, type Bead } from "./beads/bd";
import { refreshAllIssues } from "./beads/issues";
import { formatHumanNote } from "./beads/notes";
import { resolveOperator } from "./operator";
import type { ReworkRequest } from "./rework-contract";
import {
  followUpDescription,
  hasAnyHumanNote,
  hasHumanNote,
  originNoteBody,
  reworkNoteBody,
} from "./rework-notes";
import { RUN_STAGE_LABELS } from "./rework-pipeline";
import { isBoardCard } from "./ticket-view";
import type { Project, ReworkPipeline, ReworkResult } from "./types";

/**
 * Labels a follow-up inherits from the ticket it came from. Routing, not state: `agent:` decides
 * which specialist the run dispatches (and which the agent gate checks), and the rest are the
 * shaping metadata the board filters and sorts on. Everything else is deliberately NOT copied —
 * `approved` is the founder's gate on the new work, `stage:`/`run-lease:`/`review-score:` describe a
 * run the follow-up never had, and `abandoned` would create it already dead.
 */
const INHERITED_LABEL_PREFIXES = ["agent:", "domain:", "risk:", "size:", "area:"];

/**
 * An applied rework, plus the one thing the pipeline reset needs to know: does the bead now carrying
 * the instructions run under THIS target? Only then does retiring the target's finished-run marker
 * ({@link retireFinishedRun}) actually put the work back in front of a runner.
 */
export interface AppliedRework {
  result: ReworkResult;
  runsUnderTarget: boolean;
  /**
   * A board write this request made that its own mode didn't ask for — reconciling a follow-up an
   * earlier attempt left in a shape the target's PR has since invalidated ({@link resumeFollowUp}).
   * Reported separately because it lands on a request that is otherwise a no-op, and a write that
   * isn't synced is a write another machine never sees.
   */
  reconciled?: boolean;
}

/**
 * Reopen: the note, then the status. Ordered that way deliberately — a note on a bead that failed to
 * reopen is a recoverable half-step (the founder sees their instructions and can reopen by hand),
 * while a reopened bead with no instructions is a ticket re-dispatched against the SAME spec that
 * just failed review, which is how a converge loop grinds.
 */
export async function applyReopen(
  project: Project,
  target: Bead,
  ticket: Bead,
  request: ReworkRequest,
): Promise<AppliedRework> {
  const repo = project.repoPath;
  const author = await resolveAuthor();
  const body = reworkNoteBody({
    mode: "reopen",
    targetId: target.id,
    summary: request.summary,
    instructions: request.instructions,
    findings: request.findings,
  });

  // Re-read under the lock: the dedupe is decided on the note blob as it is at the instant we write,
  // so a request that lost the race to an identical one sees its work already done.
  const fresh = await beads.show(repo, ticket.id);
  // A reopen always runs under the target: the ticket was checked to be one of its run members.
  if (reopenAlreadyApplied(fresh, body)) {
    return {
      result: { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: false },
      runsUnderTarget: true,
    };
  }

  await beads.note(repo, ticket.id, formatHumanNote(body, author, new Date()), author || undefined);
  // A ticket the run never closed (it parked before the close, or the founder is reworking mid-flight)
  // is already open — `bd reopen` has nothing to do there, and the reason lives in the note either way.
  if (fresh.status === "closed") {
    await beads.reopen(repo, ticket.id, `rework: ${request.summary}`);
  }
  // The stage labels describe the run that just finished with this bead — see RUN_STAGE_LABELS for
  // what each one costs the ticket it is left on.
  await beads.untag(repo, ticket.id, RUN_STAGE_LABELS);
  return {
    result: { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: true },
    runsUnderTarget: true,
  };
}

/**
 * Has this exact reopen already landed? "Already done" is the note AND the state the rework produces
 * — an open bead with the finished run's stage labels gone. On text alone, sending the same
 * instructions back a SECOND time (after a later run re-closed the ticket) would skip the reopen and
 * leave the bead closed while the founder is told it went back.
 */
function reopenAlreadyApplied(fresh: Bead, body: string): boolean {
  return hasHumanNote(fresh, body) && fresh.status !== "closed" && !hasStageLabel(fresh);
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
 * run target in its own right, claimable and approvable like any other standalone item. That same
 * choice is what `runsUnderTarget` reports, because a parentless follow-up gives the target's own
 * run nothing to carry and so must not retire its open PR ({@link resolvePipeline}).
 *
 * A SHIPPED target (its PR merged, {@link resolvePipeline}) is parented nowhere for a second reason:
 * its next run has nothing left to execute, so a child of it would never be dispatched either.
 */
export async function applyFollowUp(
  project: Project,
  target: Bead,
  ticket: Bead,
  request: ReworkRequest,
  pipeline?: ReworkPipeline,
): Promise<AppliedRework> {
  const repo = project.repoPath;
  const context: FollowUpContext = {
    repo,
    target,
    ticket,
    request,
    pipeline,
    author: await resolveAuthor(),
    shippedPr: pipeline?.outcome === "shipped" ? pipeline.pr : undefined,
    body: reworkNoteBody({
      mode: "follow-up",
      targetId: target.id,
      summary: request.summary,
      instructions: request.instructions,
      findings: request.findings,
      originId: ticket.id,
      redirected: pipeline?.redirected ?? false,
    }),
  };

  // Re-read the board UNDER the lock, like the reopen path re-reads the bead: the pre-lock snapshot
  // was taken before a rival request could have created the very follow-up this one would duplicate,
  // and the whole point of the lock is that the loser sees the winner's work.
  const all = await refreshAllIssues(repo);
  const match = await existingFollowUp(repo, all, ticket.id, request.summary, context.body);
  return match ? resumeFollowUp(context, match) : createFollowUp(context, all);
}

/** Everything both follow-up paths need: who is writing, what the note says, and what the PR decided. */
interface FollowUpContext {
  repo: string;
  target: Bead;
  ticket: Bead;
  request: ReworkRequest;
  author: string;
  /** The instruction note this request would land — also the blob the dedupe matched on. */
  body: string;
  /** The target's PR, where it has MERGED — the one state that forces the follow-up to stand alone. */
  shippedPr?: string;
  pipeline?: ReworkPipeline;
}

/**
 * A follow-up this request must not duplicate is already on the board. Two things can still be owed
 * on it — a parentage the target's merge has invalidated, and an unfinished creation — and both are
 * settled here rather than reported as "already sent back".
 */
async function resumeFollowUp(
  context: FollowUpContext,
  match: FollowUpMatch,
): Promise<AppliedRework> {
  const { target, ticket, body } = context;
  const existing = match.bead;
  const stranded = context.shippedPr !== undefined && beads.parentOf(existing) === target.id;
  if (stranded) await detachStrandedFollowUp(context, existing);
  if (match.partial) await finishHalfCreatedFollowUp(context, existing);
  return {
    result: {
      mode: "follow-up",
      ticketId: ticket.id,
      reworkedId: existing.id,
      note: body,
      // A resumed creation DID write: the founder's instructions were nowhere on the board a
      // moment ago, and reporting "already sent back" would hide that this pass is what landed
      // them.
      applied: match.partial,
    },
    // Read off the bead the winner actually created — as reconciled above — so the repeat that
    // finishes a half-applied send-back retires on exactly the condition that holds now.
    runsUnderTarget: context.shippedPr === undefined && beads.parentOf(existing) === target.id,
    reconciled: stranded,
  };
}

/**
 * A follow-up created UNDER the target before its PR merged is stranded there: the merged target has
 * no run left to dispatch it, and a child task is not a run target of its own, so nothing would ever
 * pick it up. That is exactly the shape the instructed retry lands in — the 409 says "send it back
 * again", and this pass reads the PR as merged. So the parentage is reconciled to what this request
 * would have created had it gone first (parentless, {@link resolvePipeline}), rather than the
 * founder being told a stranded child "carries the next pass as its own run target". The bead keeps
 * its Context section, which a founder may have edited; the note is the record of the move.
 */
async function detachStrandedFollowUp(context: FollowUpContext, existing: Bead): Promise<void> {
  await beads.reparent(context.repo, existing.id, "");
  await beads.note(
    context.repo,
    existing.id,
    `anton: rework — ${context.target.id}'s pull request (${context.shippedPr}) merged after this ` +
      `follow-up was created under it, so it was detached and is its own run target now — approve ` +
      `it to run. Its Context section still names the parent it was created under.`,
  );
}

/**
 * A bead an earlier attempt created and linked but never got a note onto ({@link existingFollowUp})
 * is this request's own work, half done — so finish it rather than opening a second follow-up beside
 * it. Both remaining writes are made, in the order the create path makes them: the attempt died on
 * the first, so neither can already be on the board.
 */
async function finishHalfCreatedFollowUp(
  context: FollowUpContext,
  existing: Bead,
): Promise<void> {
  const { repo, author, body } = context;
  await beads.note(repo, existing.id, formatHumanNote(body, author, new Date()), author || undefined);
  await noteOrigin(context, existing.id);
}

/** Create the follow-up: the bead, the provenance edge, the instructions, then the origin's pointer. */
async function createFollowUp(context: FollowUpContext, all: Bead[]): Promise<AppliedRework> {
  const { repo, target, ticket, request, author, body, pipeline } = context;
  const parentId =
    context.shippedPr === undefined && isBoardCard(target, all) ? target.id : undefined;
  const followUpId = await beads.create(repo, {
    title: request.summary,
    type: "task",
    description: followUpDescription({
      summary: request.summary,
      ticket,
      targetId: target.id,
      parentId,
      pipeline,
    }),
    labels: inheritedLabels(ticket),
    ...(parentId ? { deps: [`parent-child:${parentId}`] } : {}),
  });
  // Provenance, and the reason this bead exists at all: `bd link <new> <origin> --type
  // discovered-from`. Written before the note so a failure leaves an unlinked bead the founder can
  // see and link, rather than an instruction on a bead nothing points at.
  await beads.link(repo, followUpId, ticket.id, "discovered-from");
  await beads.note(repo, followUpId, formatHumanNote(body, author, new Date()), author || undefined);
  await noteOrigin(context, followUpId);
  return {
    result: { mode: "follow-up", ticketId: ticket.id, reworkedId: followUpId, note: body, applied: true },
    runsUnderTarget: parentId === target.id,
  };
}

/**
 * Point the ORIGINAL ticket at what its review produced. Written exactly once per follow-up: the
 * create path writes it last, and the path that RESUMES a half-created follow-up
 * ({@link existingFollowUp}) reaches it only where the attempt it is finishing died before this
 * write.
 */
async function noteOrigin(context: FollowUpContext, followUpId: string): Promise<void> {
  const { repo, ticket, author, pipeline } = context;
  const body = originNoteBody(followUpId, pipeline);
  await beads.note(repo, ticket.id, formatHumanNote(body, author, new Date()), author || undefined);
}

/**
 * The follow-up this request must not duplicate, and whether it still needs finishing.
 *
 * Two shapes qualify, and they are found in that order:
 *
 *   • DONE — an unsettled bead linked `discovered-from` the ticket, with the same title AND carrying
 *     this request's exact instruction note. All three, because each is wrong alone. The edge alone
 *     makes every LATER rework of the same ticket a no-op — a founder is entitled to send the same
 *     ticket back twice for two different reasons. Title and edge still match a bead carrying
 *     DIFFERENT instructions: two send-backs summarised the same way, or an ordinary follow-up and a
 *     reopen that a merged PR redirected here, which say opposite things about whether the
 *     original's acceptance stood ({@link reworkNoteBody}). Reusing one for the other reports a note
 *     that is nowhere on the bead and hands the next implementer the earlier request's instructions.
 *   • PARTIAL — the same title and edge on a bead carrying NO human note at all. `bd create` and
 *     `bd link` landed and the `bd note` after them did not, so an attempt died mid-sequence; the
 *     bead speaks for no request yet. Matching on the note ALONE would reject it and create a second
 *     follow-up beside it, and duplicate discovered-from work can be approved twice. Carrying no
 *     human note is what distinguishes it from another request's bead, which carries its own.
 *
 * The note blob decides either way, exactly as the reopen path's dedupe does — which needs a full
 * `bd show` per candidate, since `bd list` does not carry notes reliably. An exact match anywhere in
 * the candidates wins over a partial one, so a founder's second send-back is never mistaken for the
 * unfinished remains of their first.
 */
export interface FollowUpMatch {
  /**
   * The `bd show` re-read, never the board snapshot the candidate came from. {@link resumeFollowUp}
   * decides parentage off this bead — whether the follow-up is stranded under a merged target, and
   * whether the target's PR gate may be retired — and a concurrent reparent (the gardener's, say)
   * makes the snapshot say "still under the target" about a bead that has already moved.
   */
  bead: Bead;
  /** The creation sequence stopped before its note — this request finishes it ({@link resumeFollowUp}). */
  partial: boolean;
}

export async function existingFollowUp(
  repo: string,
  all: Bead[],
  ticketId: string,
  summary: string,
  body: string,
): Promise<FollowUpMatch | undefined> {
  let partial: Bead | undefined;
  for (const candidate of followUpCandidates(all, ticketId, summary)) {
    const fresh = await beads.show(repo, candidate.id);
    if (hasHumanNote(fresh, body)) return { bead: fresh, partial: false };
    partial ??= unfinishedCreation(fresh);
  }
  return partial ? { bead: partial, partial: true } : undefined;
}

/**
 * The beads that could be this request's follow-up: unsettled, titled the same, and linked
 * `discovered-from` the ticket. Cheap enough to run off the board snapshot — what each candidate
 * actually CARRIES is decided by a `bd show` on it.
 */
function followUpCandidates(all: Bead[], ticketId: string, summary: string): Bead[] {
  const title = summary.trim().toLowerCase();
  return all.filter(
    (b) =>
      b.status !== "closed" &&
      (b.title ?? "").trim().toLowerCase() === title &&
      isDiscoveredFrom(b, ticketId),
  );
}

/** Is this bead linked `discovered-from` the ticket — the edge every follow-up is created with? */
function isDiscoveredFrom(bead: Bead, ticketId: string): boolean {
  return (bead.dependencies ?? []).some(
    (d) => d?.type === "discovered-from" && d.issue_id === bead.id && d.depends_on_id === ticketId,
  );
}

/** A candidate carrying no human note speaks for no request yet — an attempt that died mid-creation. */
function unfinishedCreation(bead: Bead): Bead | undefined {
  return hasAnyHumanNote(bead) ? undefined : bead;
}

/** The routing/shaping labels a follow-up carries over — see {@link INHERITED_LABEL_PREFIXES}. */
export function inheritedLabels(ticket: Bead): string[] {
  return (ticket.labels ?? []).filter((l) => INHERITED_LABEL_PREFIXES.some((p) => l.startsWith(p)));
}

/** Stage labels a reopen strips — one still on the bead means this rework's untag hasn't run yet. */
function hasStageLabel(bead: Bead): boolean {
  return (bead.labels ?? []).some((l) => RUN_STAGE_LABELS.includes(l));
}

/**
 * Who the note is attributed to. An unresolvable identity is not a reason to refuse — like a plain
 * note, a rework takes nothing from anyone — so `formatHumanNote`'s generic author stands in.
 */
async function resolveAuthor(): Promise<string> {
  return (await resolveOperator()) ?? "";
}
