/**
 * Pure display helpers for the epic board. Kept dependency-free so they're trivially testable
 * (see board-utils.test.ts) and reusable from both the board and card client components.
 */
import type { Stage, Ticket } from "@/lib/types";

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  implementing: "Implementing",
  "in-review": "In Review",
  done: "Done",
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

/** Whether a PR reference looks like a clickable URL rather than a bare bead external-ref. */
export function isExternalUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}
