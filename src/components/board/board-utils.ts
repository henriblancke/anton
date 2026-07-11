/**
 * Pure display helpers for the epic board. Kept dependency-free so they're trivially testable
 * (see board-utils.test.ts) and reusable from both the board and card client components.
 */
import { STAGES, type Epic, type Stage, type Ticket } from "@/lib/types";

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  implementing: "Implementing",
  "in-review": "In Review",
  done: "Done",
};

/** Quiet per-stage accent dot color. Theme-aware Tailwind palette classes, not raw hex. */
export const STAGE_ACCENT_DOT: Record<Stage, string> = {
  backlog: "bg-muted-foreground/50",
  implementing: "bg-blue-500 dark:bg-blue-400",
  "in-review": "bg-amber-500 dark:bg-amber-400",
  done: "bg-emerald-500 dark:bg-emerald-400",
};

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
