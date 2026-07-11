/**
 * Pure display helpers for the epic board. Kept dependency-free so they're trivially testable
 * (see board-utils.test.ts) and reusable from both the board and card client components.
 */
import { STAGES, type Epic, type Stage, type Ticket } from "@/lib/types";

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  implementing: "Implementing",
  "in-review": "In-review",
  done: "Done",
};

/** Per-stage accent dot color — theme-aware semantic tokens from the Atelier design system. */
export const STAGE_ACCENT_DOT: Record<Stage, string> = {
  backlog: "bg-stage-backlog",
  implementing: "bg-stage-implementing",
  "in-review": "bg-stage-in-review",
  done: "bg-stage-done",
};

/** Text color per stage, for stage-tinted labels/pills. */
export const STAGE_TEXT: Record<Stage, string> = {
  backlog: "text-stage-backlog",
  implementing: "text-stage-implementing",
  "in-review": "text-stage-in-review",
  done: "text-stage-done",
};

/** Inset left-border color per stage — mirrors the board card's `box-shadow: inset 2px 0`. */
export const STAGE_INSET_SHADOW: Record<Stage, string> = {
  backlog: "shadow-[inset_2px_0_0_var(--stage-backlog)]",
  implementing: "shadow-[inset_2px_0_0_var(--stage-implementing)]",
  "in-review": "shadow-[inset_2px_0_0_var(--stage-in-review)]",
  done: "shadow-[inset_2px_0_0_var(--stage-done)]",
};

/** Left-border color per stage — used by dependency-graph nodes (`border-l-3`). */
export const STAGE_BORDER_LEFT: Record<Stage, string> = {
  backlog: "border-l-stage-backlog",
  implementing: "border-l-stage-implementing",
  "in-review": "border-l-stage-in-review",
  done: "border-l-stage-done",
};

/** Dot color per agent tag — a stable, warm-matched hue so an agent reads at a glance.
 * Falls back to the neutral subtle color for unknown/absent agents. */
export function agentDotClass(agent?: string): string {
  switch (agent) {
    case "fastapi":
      return "bg-agent-fastapi";
    case "supabase":
      return "bg-agent-supabase";
    case "pydantic":
      return "bg-agent-pydantic";
    case "terraform":
      return "bg-agent-terraform";
    case "docker":
      return "bg-agent-docker";
    case "kubernetes":
      return "bg-agent-kubernetes";
    default:
      return "bg-subtle";
  }
}

/** Ticket completion for an epic: how many of its tickets are `done`, and the total. */
export function ticketProgress(epic: { tickets: Ticket[] }): {
  done: number;
  total: number;
  pct: number;
} {
  const total = epic.tickets.length;
  const done = epic.tickets.filter((t) => t.stage === "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

export interface TicketBadge {
  key: string;
  label: string;
}

/** Small badges for a ticket: agent / risk / size, in that order, skipping unset fields. */
export function ticketBadges(ticket: Ticket): TicketBadge[] {
  const badges: TicketBadge[] = [];
  if (ticket.agent) badges.push({ key: "agent", label: ticket.agent });
  if (ticket.risk) badges.push({ key: "risk", label: `risk:${ticket.risk}` });
  if (ticket.size) badges.push({ key: "size", label: `size:${ticket.size}` });
  return badges;
}

/** Badge variant for a ticket badge — only `risk:high` gets the destructive (red) tint, per
 * the design brief; everything else stays a quiet neutral chip. */
export function badgeVariant(badge: TicketBadge): "outline" | "destructive" {
  return badge.key === "risk" && badge.label === "risk:high" ? "destructive" : "outline";
}

/** Tooltip text for a ticket's summary dot on a multi-ticket epic card. */
export function ticketDotTitle(ticket: Ticket): string {
  const parts = [ticket.title];
  if (ticket.agent) parts.push(`agent:${ticket.agent}`);
  if (ticket.risk) parts.push(`risk:${ticket.risk}`);
  return parts.join(" · ");
}

/** Whether a PR reference looks like a clickable URL rather than a bare bead external-ref. */
export function isExternalUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** Moves an epic (by id) to another stage column, immutably. Used for optimistic
 * drag-and-drop updates before the move API call resolves. No-op if the epic isn't found. */
export function moveEpicBetweenColumns(
  columns: Record<Stage, Epic[]>,
  epicId: string,
  toStage: Stage,
): Record<Stage, Epic[]> {
  let moved: Epic | undefined;
  const next = Object.fromEntries(STAGES.map((stage) => [stage, [] as Epic[]])) as Record<
    Stage,
    Epic[]
  >;

  for (const stage of STAGES) {
    for (const epic of columns[stage] ?? []) {
      if (epic.id === epicId) {
        moved = epic;
      } else {
        next[stage].push(epic);
      }
    }
  }

  if (!moved) return columns;
  next[toStage] = [{ ...moved, stage: toStage }, ...next[toStage]];
  return next;
}
