import type { ReviewFinding, ReworkMode, ReworkResult, Ticket } from "@/lib/types";

/**
 * What the founder fills in before sending a ticket back — one draft rather than a state hook per
 * field, because the four are only ever read together, at submit.
 */
export interface ReworkDraft {
  ticketId: string;
  mode: ReworkMode;
  summary: string;
  instructions: string;
}

/** The rework route's body: the draft, trimmed, plus the findings the founder ticked. */
export interface ReworkPayload {
  ticketId: string;
  mode: ReworkMode;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
}

/** Abandoned tickets are out of every run, so sending one back would produce work nothing picks up. */
export function reworkCandidates(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => !t.abandoned);
}

export function initialDraft(candidates: Ticket[]): ReworkDraft {
  return { ticketId: candidates[0]?.id ?? "", mode: "reopen", summary: "", instructions: "" };
}

/**
 * Stable identity for a finding across renders — severity, location and note, which is what makes
 * two distinct. NUL-delimited (as elsewhere in the codebase) because a location may contain spaces:
 * a separator the fields can themselves contain would let two findings collide onto one key, and a
 * shared key means ticking one submits both.
 */
export function findingKey(f: ReviewFinding): string {
  return `${f.severity}\0${f.location}\0${f.note}`;
}

export function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * Both text fields carry the whole point of the send-back — a reason nobody can act on is worse
 * than no rework at all — so neither may be blank.
 */
export function isDraftComplete(draft: ReworkDraft): boolean {
  return !!draft.ticketId && draft.summary.trim().length > 0 && draft.instructions.trim().length > 0;
}

export function reworkPayload(
  draft: ReworkDraft,
  findings: ReviewFinding[],
  selected: ReadonlySet<string>,
): ReworkPayload {
  return {
    ticketId: draft.ticketId,
    mode: draft.mode,
    summary: draft.summary.trim(),
    instructions: draft.instructions.trim(),
    findings: findings.filter((f) => selected.has(findingKey(f))),
  };
}

/**
 * What the founder is told landed. A double-submit reports the bead the FIRST request produced —
 * saying "reopened" twice would claim a write that never happened.
 */
export function reworkOutcomeMessage(result: ReworkResult): string {
  if (!result.applied) return `Already sent back — ${result.reworkedId} carries these instructions`;
  return result.mode === "reopen"
    ? `${result.ticketId} reopened with instructions`
    : `Follow-up ${result.reworkedId} created from ${result.ticketId}`;
}

/**
 * What happened to the target's pull request, and therefore what runs next (anton-leit). This is
 * the half of the outcome the founder cannot infer from the bead: a send-back on a target whose PR
 * is live has no run path back until anton makes one, so what it made is said out loud. Undefined
 * when there was no PR in the way — the ordinary case needs no explanation.
 */
export function reworkPipelineMessage(result: ReworkResult): string | undefined {
  const pipeline = result.pipeline;
  if (!pipeline) return undefined;
  if (pipeline.outcome === "retired") {
    return (
      `${pipeline.pr} is still open, so this target's finished-run marker was cleared — run it again ` +
      `and the next round pushes to the same branch and updates that PR.`
    );
  }
  return (
    `${pipeline.pr} has already merged, so that work can't be reopened` +
    (pipeline.redirected ? " despite the acceptance being unmet" : "") +
    `. ${result.reworkedId} carries the next pass as its own run target — approve it to run.`
  );
}
