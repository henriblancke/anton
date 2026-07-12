/**
 * Server-side validation for a ticket-detail edit. The dialog PATCHes a FLAT field patch
 * (title/status/priority/agent/risk/size/domain); this maps it to a BeadPatch and rejects
 * anything unknown or out of range before it reaches bd. Managed labels (agent/risk/size/domain)
 * are folded into `labels` so updateTicket diffs them against the bead's current labels.
 */
import { LABEL_PREFIXES, type BeadPatch, type LabelPrefix } from "./beads/bd";

// The flat fields the ticket dialog is allowed to send. Anything else is rejected.
const FIELDS = ["title", "status", "priority", "agent", "risk", "size", "domain"] as const;

// Allowed values, mirroring the beads conventions (see AGENTS/ethos cheatsheet).
const STATUSES = ["open", "in_progress", "blocked", "closed"] as const;
const RISKS = ["low", "med", "high"] as const;
const SIZES = ["S", "M", "L"] as const;
const DOMAINS = ["eng", "marketing", "bizdev", "research", "ops"] as const;

export type ParsedPatch = { patch: BeadPatch } | { error: string };

const oneOf = (allowed: readonly string[], v: unknown): v is string =>
  typeof v === "string" && allowed.includes(v);

export function parseTicketPatch(body: unknown): ParsedPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      return { error: `Unknown field: ${key}` };
    }
  }

  const patch: BeadPatch = {};
  const labels: Partial<Record<LabelPrefix, string>> = {};

  if ("title" in input) {
    if (typeof input.title !== "string" || input.title.trim() === "") {
      return { error: "title must be a non-empty string" };
    }
    patch.title = input.title;
  }
  if ("status" in input) {
    if (!oneOf(STATUSES, input.status)) {
      return { error: `Invalid status: ${String(input.status)}` };
    }
    patch.status = input.status;
  }
  if ("priority" in input) {
    const p = input.priority;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 4) {
      return { error: `Invalid priority: ${String(p)} (expected integer 0-4)` };
    }
    patch.priority = p;
  }

  // Managed labels: agent is free-form; risk/size/domain are constrained value sets.
  if ("agent" in input) {
    if (typeof input.agent !== "string" || input.agent.trim() === "") {
      return { error: "agent must be a non-empty string" };
    }
    labels.agent = input.agent;
  }
  if ("risk" in input) {
    if (!oneOf(RISKS, input.risk)) return { error: `Invalid risk: ${String(input.risk)}` };
    labels.risk = input.risk;
  }
  if ("size" in input) {
    if (!oneOf(SIZES, input.size)) return { error: `Invalid size: ${String(input.size)}` };
    labels.size = input.size;
  }
  if ("domain" in input) {
    if (!oneOf(DOMAINS, input.domain)) return { error: `Invalid domain: ${String(input.domain)}` };
    labels.domain = input.domain;
  }

  // Defensive: only the managed prefixes ever land in `labels`.
  if ((Object.keys(labels) as LabelPrefix[]).some((k) => !LABEL_PREFIXES.includes(k))) {
    return { error: "Unsupported label" };
  }
  if (Object.keys(labels).length > 0) patch.labels = labels;

  return { patch };
}
