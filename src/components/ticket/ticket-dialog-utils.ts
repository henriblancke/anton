/**
 * Pure form helpers for the ticket dialog. Kept dependency-free so the edit→Save contract
 * (draft shape, and the "only changed fields" diff the dialog PATCHes) is trivially testable
 * in the node test env — mirroring board-utils.ts. The API accepts a flat patch of
 * title/status/priority/agent/risk/size (see ticket-patch.ts).
 */
import type { TicketDetail } from "@/lib/types";

/** The scalar/label fields the dialog can edit. Absent labels are held as "" in the draft. */
export interface TicketDraft {
  title: string;
  status: string;
  priority: number | undefined;
  agent: string;
  risk: string;
  size: string;
}

/** The flat patch body the dialog PATCHes — only the fields that actually changed. */
export interface TicketPatchBody {
  title?: string;
  status?: string;
  priority?: number;
  agent?: string;
  risk?: string;
  size?: string;
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

/** Seed an editable draft from a fetched ticket detail. Absent labels become "". */
export function draftFromDetail(detail: TicketDetail): TicketDraft {
  return {
    title: detail.title,
    status: detail.status,
    priority: detail.priority,
    agent: detail.agent ?? "",
    risk: detail.risk ?? "",
    size: detail.size ?? "",
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

  return patch;
}

/** Whether a draft has any field the dialog would PATCH (drives the Save-disabled state). */
export function hasTicketChanges(original: TicketDraft, draft: TicketDraft): boolean {
  return Object.keys(diffTicketPatch(original, draft)).length > 0;
}
