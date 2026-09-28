/**
 * Pure form helpers for the ticket dialog. Kept dependency-free so the edit→Save contract
 * (draft shape, and the "only changed fields" diff the dialog PATCHes) is trivially testable
 * in the node test env — mirroring board-utils.ts. The API accepts a flat patch of
 * title/status/priority/agent/risk/size (see ticket-patch.ts).
 */
import { ACCEPTANCE_HEADING } from "@/lib/beads/contract";
import { scanMarkdown } from "@/lib/beads/markdown";
import type { TicketDetail } from "@/lib/types";

/**
 * The editable fields of a ticket. Scalar/label fields plus the markdown contract, which is
 * decomposed into four pieces: `goal` (the `## Goal` section), `why` (the `## Why` section — no bd
 * field of its own, so it lives only in the description), `acceptance` (the `## Acceptance
 * Criteria` section, falling back to the bead's acceptance field), and `body` (the rest of the
 * description). Absent labels are held as "" in the draft.
 *
 * Storage rule: the whole contract is canonically the bead DESCRIPTION markdown. On save the
 * description is recomposed as `## Goal` + `## Why` + `## Acceptance Criteria` + body
 * (`composeDescription`) — the contract's own order — and the acceptance text is mirrored into
 * bd's dedicated acceptance field so the two never drift — `parseGoal`/`parseAcceptance` both read
 * the `## <section>` from the description first.
 */
export interface TicketDraft {
  title: string;
  status: string;
  priority: number | undefined;
  agent: string;
  risk: string;
  size: string;
  goal: string;
  why: string;
  acceptance: string;
  body: string;
}

/** The flat patch body the dialog PATCHes — only the fields that actually changed. */
export interface TicketPatchBody {
  title?: string;
  status?: string;
  priority?: number;
  agent?: string;
  risk?: string;
  size?: string;
  description?: string;
  acceptance?: string;
}

export const STATUS_OPTIONS = ["open", "in_progress", "blocked", "closed"] as const;
export const RISK_OPTIONS = ["low", "med", "high"] as const;
export const SIZE_OPTIONS = ["S", "M", "L"] as const;
export const PRIORITY_OPTIONS = [0, 1, 2, 3, 4] as const;

/** Human labels for the raw bead status values. */
export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  closed: "Closed",
  // Set by the snooze toggle (`bd defer`), never picked from the Status select — the state bar owns it.
  deferred: "Snoozed",
};

/**
 * A ticket's resolution — the human-decision axis the state bar surfaces, distinct from its derived
 * lifecycle stage. Kept a pure function here so the segment↔state mapping is unit-tested in the node
 * env alongside the draft/diff helpers. `abandoned` wins over `deferred` (an abandoned bead is closed
 * and can't also be snoozed); a plain closed/`done` bead that was neither is a shipped "done".
 */
export type Resolution = "active" | "snoozed" | "abandoned" | "done";

export function resolutionOf(detail: {
  deferred: boolean;
  abandoned: boolean;
  stage: string;
}): Resolution {
  if (detail.abandoned) return "abandoned";
  if (detail.deferred) return "snoozed";
  if (detail.stage === "done") return "done";
  return "active";
}

/** Human labels for priorities (0 = critical … 4 = backlog), matching bd conventions. */
export const PRIORITY_LABELS: Record<number, string> = {
  0: "P0 · critical",
  1: "P1 · high",
  2: "P2 · medium",
  3: "P3 · low",
  4: "P4 · backlog",
};

/** The agents anton may assign — mirrors the settings-view agent list. */
export const AGENT_OPTIONS = [
  "fastapi",
  "supabase",
  "pydantic",
  "nextjs",
  "alembic",
  "terraform",
  "docker",
  "kubernetes",
] as const;

/**
 * The contract sections that live in their own draft fields — everything else stays in `body`.
 * `Acceptance` is the PREFIX, not the full heading: the `\b` match below also claims the
 * `## Acceptance Criteria` we now write, so a description in either spelling strips to the same
 * body and recomposes under the canonical one. Listed in the contract's own order (Goal → Why →
 * Acceptance), which is also the order {@link composeDescription} writes them back in.
 */
const CONTRACT_SECTIONS = ["Goal", "Why", "Acceptance"] as const;

/** The one section whose heading is intentionally matched by PREFIX — see {@link CONTRACT_SECTIONS}. */
const PREFIX_MATCHED_SECTIONS: ReadonlySet<string> = new Set(["Acceptance"]);

/**
 * Match a `## <name>` heading. Only `Acceptance` matches by prefix (to also claim `## Acceptance
 * Criteria`); `Goal` and `Why` require the exact heading, or a non-contract section sharing the
 * same first word — `## Why now`, `## Why this approach` — would be mistaken for the contract's
 * `## Why` and get silently folded into that draft field instead of staying in `body`.
 */
const sectionHeading = (name: string) =>
  PREFIX_MATCHED_SECTIONS.has(name)
    ? new RegExp(`^##\\s*${name}\\b`, "i")
    : new RegExp(`^##\\s*${name}\\s*$`, "i");

/**
 * Is this line, at this position, a genuine heading at depth 2 or shallower — as opposed to a
 * line that merely LOOKS like one inside a fenced code block, an HTML comment, or other
 * non-rendered markdown? Backed by {@link scanMarkdown}'s AST-aware line scan
 * (src/lib/beads/markdown.ts), the same parser the contract reader uses — a raw `/^##\s+/` test
 * on the trimmed line text can't tell a real heading from a fenced example that merely contains
 * one. Depth 1 and shallower also count as boundaries: a `# Notes` following `## Why` still ends
 * the section, even though only a depth-2 heading can be the section opener itself (see
 * {@link sectionHeading}) — otherwise a shallower heading and everything below it gets absorbed
 * into the open section instead of staying independent body text.
 */
const isSectionHeadingLine = (scanned: ReturnType<typeof scanMarkdown>[number] | undefined): boolean =>
  scanned?.heading !== undefined && scanned.heading.depth <= 2;

/**
 * Drop the `## Goal` / `## Why` / `## Acceptance Criteria` blocks (heading through the line before
 * the next `##`) from a description, leaving "the rest" that the Description textarea edits. A
 * fenced example containing a line that merely reads `## Why` is left alone — it is body text, not
 * a section boundary.
 */
export function stripContractSections(description: string): string {
  const lines = description.split(/\r?\n/);
  const scanned = scanMarkdown(description);
  const kept: string[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isSectionHeadingLine(scanned[i])) {
      const trimmed = line.trim();
      const isContract = CONTRACT_SECTIONS.some((name) => sectionHeading(name).test(trimmed));
      skipping = isContract;
      if (skipping) continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Extract one `## <name>` block's body (heading through the line before the next `##`), or "" when
 * absent. The read half of {@link stripContractSections} for a section with no bd field home of
 * its own — unlike Goal/Acceptance, Why is never mirrored onto {@link TicketDetail}, so it can only
 * be read back out of the description markdown.
 */
function extractSection(description: string, name: string): string {
  const lines = description.split(/\r?\n/);
  const scanned = scanMarkdown(description);
  const heading = sectionHeading(name);
  const body: string[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isSectionHeadingLine(scanned[i])) {
      if (inSection) break;
      inSection = heading.test(line.trim());
      continue;
    }
    if (inSection) body.push(line);
  }
  return body.join("\n").trim();
}

/**
 * Recompose a draft's contract into a single canonical description markdown: `## Goal`, then
 * `## Why`, then `## Acceptance Criteria`, then the remaining body — the contract's own order
 * (skills/bd/SKILL.md). Empty pieces are omitted. This is what gets written to `--description`,
 * and `parseGoal`/`parseAcceptance` read it straight back.
 */
export function composeDescription(draft: TicketDraft): string {
  const parts: string[] = [];
  const goal = draft.goal.trim();
  const why = draft.why.trim();
  const acceptance = draft.acceptance.trim();
  const body = draft.body.trim();
  if (goal) parts.push(`## Goal\n\n${goal}`);
  if (why) parts.push(`## Why\n\n${why}`);
  if (acceptance) parts.push(`## ${ACCEPTANCE_HEADING}\n\n${acceptance}`);
  if (body) parts.push(body);
  return parts.join("\n\n");
}

/** Seed an editable draft from a fetched ticket detail. Absent labels become "". */
export function draftFromDetail(detail: TicketDetail): TicketDraft {
  return {
    title: detail.title,
    status: detail.status,
    priority: detail.priority,
    agent: detail.agent ?? "",
    risk: detail.risk ?? "",
    size: detail.size ?? "",
    goal: detail.goal ?? "",
    why: extractSection(detail.description ?? "", "Why"),
    acceptance: detail.acceptance ?? "",
    body: stripContractSections(detail.description ?? ""),
  };
}

/**
 * Diff a draft against its original, returning only the changed fields. Title is compared and
 * sent trimmed; an empty title is never sent (it's invalid server-side). Labels can be set but
 * not cleared here (the API requires non-empty label values), so a field that became "" is
 * treated as unchanged.
 */
export function diffTicketPatch(original: TicketDraft, draft: TicketDraft): TicketPatchBody {
  const patch: TicketPatchBody = {};

  const title = draft.title.trim();
  if (title !== "" && title !== original.title.trim()) patch.title = title;

  if (draft.status !== original.status) patch.status = draft.status;

  if (draft.priority !== undefined && draft.priority !== original.priority) {
    patch.priority = draft.priority;
  }

  if (draft.agent !== "" && draft.agent !== original.agent) patch.agent = draft.agent;
  if (draft.risk !== "" && draft.risk !== original.risk) patch.risk = draft.risk;
  if (draft.size !== "" && draft.size !== original.size) patch.size = draft.size;

  // Contract: when any of Goal/Why/Acceptance/body changed, rewrite the whole description and
  // mirror acceptance into bd's dedicated field so the two homes can't drift. Empty pieces are
  // no-ops server-side (they never clobber the current value), matching the label behavior above.
  const contractChanged =
    draft.goal !== original.goal ||
    draft.why !== original.why ||
    draft.acceptance !== original.acceptance ||
    draft.body !== original.body;
  if (contractChanged) {
    const description = composeDescription(draft);
    if (description !== "") patch.description = description;
    const acceptance = draft.acceptance.trim();
    if (acceptance !== "") patch.acceptance = acceptance;
  }

  return patch;
}

/**
 * The one-line summary shown on the collapsed "Details" disclosure (anton-q02q) — the label/scalar
 * fields folded away so the contract + notes lead. Snooze renders as its own status; absent labels
 * are omitted. Pure so it's unit-tested alongside the other draft helpers.
 */
export function detailsSummary(draft: TicketDraft, deferred: boolean): string {
  const parts: string[] = [deferred ? STATUS_LABELS.deferred : (STATUS_LABELS[draft.status] ?? draft.status)];
  if (draft.priority !== undefined) parts.push(`P${draft.priority}`);
  if (draft.agent) parts.push(draft.agent);
  if (draft.risk) parts.push(`risk:${draft.risk}`);
  if (draft.size) parts.push(`size:${draft.size}`);
  return parts.join(" · ");
}

/** Whether a draft has any field the dialog would PATCH (drives the Save-disabled state). */
export function hasTicketChanges(original: TicketDraft, draft: TicketDraft): boolean {
  return Object.keys(diffTicketPatch(original, draft)).length > 0;
}

/**
 * Whether saving `draft` would silently drop a `## Why` the ticket already carries. Unlike
 * Goal/Acceptance, the contract gate deliberately never validates Why (skills/bd/SKILL.md) — nothing
 * else stops `composeDescription` from omitting an emptied Why and the PATCH landing a ticket that
 * looks written but has lost its motivation, and can still pass every later approval check. The
 * dialog refuses the save outright rather than silently keeping the old value or dropping the
 * section, so clearing Why is always a deliberate, visible choice.
 */
export function wouldClearWhy(original: TicketDraft, draft: TicketDraft): boolean {
  return original.why.trim() !== "" && draft.why.trim() === "";
}

/**
 * Only a parentless task/bug is a run target of its own (mirrors `beads.isRunTarget`, which the
 * approve/claim routes gate on): a child ticket runs via its epic's PR, and a parentless
 * `learning`/`chore`/etc. is never runnable, so its controls would only ever 422.
 */
export function isStandaloneRunTarget(detail: Pick<TicketDetail, "epicId" | "type">): boolean {
  return !detail.epicId && (detail.type === "task" || detail.type === "bug");
}

/**
 * Whether the Approve & run / Force run affordance is offered at all — narrower than the claim
 * control. A `done` (closed) standalone target has already finished its run and produced its PR, so
 * re-approving it would only enqueue duplicate/no-op PR work. A snoozed target hides it too: the
 * whole point of the snooze is "don't pick this up yet", so offering the one control that would
 * start it immediately contradicts the state it's in.
 */
export function canRunTicket(
  detail: Pick<TicketDetail, "epicId" | "type" | "stage" | "deferred">,
): boolean {
  return isStandaloneRunTarget(detail) && detail.stage !== "done" && !detail.deferred;
}

/**
 * What the approve POST reports back. A gardener proposal is applied, not run: it names the board
 * move it made rather than a run that never started (anton-1t3n). Otherwise re-approving an
 * already-approved target is a Force run, not a first approval.
 */
export function runToastMessage(
  title: string,
  wasApproved: boolean,
  applied: string | undefined,
): string {
  if (applied) return `Applied — ${applied}`;
  return wasApproved ? `Re-running "${title}"` : `Approved & running "${title}"`;
}
