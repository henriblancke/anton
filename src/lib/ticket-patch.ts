/**
 * Server-side validation for a ticket-detail edit. The dialog PATCHes a FLAT field patch
 * (title/status/priority/agent/risk/size/domain); this maps it to a BeadPatch and rejects
 * anything unknown or out of range before it reaches bd. Managed labels (agent/risk/size/domain)
 * are folded into `labels` so updateTicket diffs them against the bead's current labels.
 */
import { type BeadPatch, type LabelPrefix } from "./beads/bd";

// Allowed values, mirroring the beads conventions (see AGENTS/ethos cheatsheet).
const STATUSES = ["open", "in_progress", "blocked", "closed"] as const;
const RISKS = ["low", "med", "high"] as const;
const SIZES = ["S", "M", "L"] as const;
const DOMAINS = ["eng", "marketing", "bizdev", "research", "ops"] as const;

export type ParsedPatch = { patch: BeadPatch } | { error: string };

// A field parser validates one raw value and returns the value to store or a rejection reason.
export type FieldResult = { value: string | number } | { error: string };
type FieldParser = (v: unknown) => FieldResult;

const oneOf = (allowed: readonly string[], v: unknown): v is string =>
  typeof v === "string" && allowed.includes(v);

// Reusable parsers, one per shape. Each owns exactly its own validation + error message.
const nonEmptyString =
  (field: string): FieldParser =>
  (v) =>
    typeof v === "string" && v.trim() !== ""
      ? { value: v }
      : { error: `${field} must be a non-empty string` };

const enumValue =
  (field: string, allowed: readonly string[]): FieldParser =>
  (v) =>
    oneOf(allowed, v) ? { value: v } : { error: `Invalid ${field}: ${String(v)}` };

// Exported so the epic patch (priority-only, see epic-patch.ts) reuses the exact same validation +
// error message rather than duplicating the 0-4 range check.
export const parsePriority: FieldParser = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4
    ? { value: v }
    : { error: `Invalid priority: ${String(v)} (expected integer 0-4)` };

// Where a parsed value lands: a BeadPatch field, or a managed label prefix.
type FieldSpec =
  | { parse: FieldParser; target: "patch"; key: keyof BeadPatch }
  | { parse: FieldParser; target: "labels"; key: LabelPrefix };

// The flat fields the ticket dialog is allowed to send. Anything else is rejected.
// `description`/`acceptance` are the contract markdown the dialog composes; both pass straight through.
// `agent` is free-form; `risk`/`size`/`domain` are constrained value sets folded into labels.
const FIELD_SPECS: Record<string, FieldSpec> = {
  title: { parse: nonEmptyString("title"), target: "patch", key: "title" },
  status: { parse: enumValue("status", STATUSES), target: "patch", key: "status" },
  priority: { parse: parsePriority, target: "patch", key: "priority" },
  description: { parse: nonEmptyString("description"), target: "patch", key: "description" },
  acceptance: { parse: nonEmptyString("acceptance"), target: "patch", key: "acceptance" },
  agent: { parse: nonEmptyString("agent"), target: "labels", key: "agent" },
  risk: { parse: enumValue("risk", RISKS), target: "labels", key: "risk" },
  size: { parse: enumValue("size", SIZES), target: "labels", key: "size" },
  domain: { parse: enumValue("domain", DOMAINS), target: "labels", key: "domain" },
};

export function parseTicketPatch(body: unknown): ParsedPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;

  // Reject any unknown field before validating, so an unknown key always wins over a bad value.
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(FIELD_SPECS, key)) return { error: `Unknown field: ${key}` };
  }

  const patch: BeadPatch = {};
  const labels: Partial<Record<LabelPrefix, string>> = {};

  for (const [key, spec] of Object.entries(FIELD_SPECS)) {
    if (!(key in input)) continue;
    const result = spec.parse(input[key]);
    if ("error" in result) return result;
    if (spec.target === "labels") {
      labels[spec.key] = result.value as string;
    } else {
      patch[spec.key] = result.value as never;
    }
  }

  if (Object.keys(labels).length > 0) patch.labels = labels;

  return { patch };
}
