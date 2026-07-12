/**
 * Pure form helpers for the ticket dialog. Kept dependency-free so the edit→Save contract
 * (draft shape, and the "only changed fields" diff the dialog PATCHes) is trivially testable
 * in the node test env — mirroring board-utils.ts. The API accepts a flat patch of
 * title/status/priority/agent/risk/size (see ticket-patch.ts).
 */
import type { TicketDetail } from "@/lib/types";

/**
 * The editable fields of a ticket. Scalar/label fields plus the markdown contract, which is
 * decomposed into three editable pieces: `goal` (the `## Goal` section), `acceptance` (the
 * `## Acceptance` section, falling back to the bead's acceptance field), and `body` (the rest
 * of the description). Absent labels are held as "" in the draft.
 *
 * Storage rule: the whole contract is canonically the bead DESCRIPTION markdown. On save the
 * description is recomposed as `## Goal` + `## Acceptance` + body (see `composeDescription`),
 * and the acceptance text is mirrored into bd's dedicated acceptance field so the two never
 * drift — `parseGoal`/`parseAcceptance` both read the `## <section>` from the description first.
 */
export interface TicketDraft {
  title: string;
  status: string;
  priority: number | undefined;
  agent: string;
  risk: string;
  size: string;
  goal: string;
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
};

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

/** The contract sections that live in their own draft fields — everything else stays in `body`. */
const CONTRACT_SECTIONS = ["Goal", "Acceptance"] as const;

/**
 * Drop the `## Goal` / `## Acceptance` blocks (heading through the line before the next `##`)
 * from a description, leaving "the rest" that the Description textarea edits. Mirrors the
 * heading semantics of `parseSection` in src/lib/tickets.ts so the split round-trips cleanly.
 */
export function stripContractSections(description: string): string {
  const lines = description.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      const isContract = CONTRACT_SECTIONS.some((name) =>
        new RegExp(`^##\\s*${name}\\b`, "i").test(trimmed),
      );
      skipping = isContract;
      if (skipping) continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Recompose a draft's contract into a single canonical description markdown: `## Goal`, then
 * `## Acceptance`, then the remaining body. Empty pieces are omitted. This is what gets written
 * to `--description`, and `parseGoal`/`parseAcceptance` read it straight back.
 */
export function composeDescription(draft: TicketDraft): string {
  const parts: string[] = [];
  const goal = draft.goal.trim();
  const acceptance = draft.acceptance.trim();
  const body = draft.body.trim();
  if (goal) parts.push(`## Goal\n\n${goal}`);
  if (acceptance) parts.push(`## Acceptance\n\n${acceptance}`);
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

  // Contract: when any of Goal/Acceptance/body changed, rewrite the whole description and
  // mirror acceptance into bd's dedicated field so the two homes can't drift. Empty pieces are
  // no-ops server-side (they never clobber the current value), matching the label behavior above.
  const contractChanged =
    draft.goal !== original.goal ||
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

/** Whether a draft has any field the dialog would PATCH (drives the Save-disabled state). */
export function hasTicketChanges(original: TicketDraft, draft: TicketDraft): boolean {
  return Object.keys(diffTicketPatch(original, draft)).length > 0;
}
