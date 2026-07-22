/**
 * Server-side validation for an epic-detail edit. Scope for this PR is priority only (no title/
 * description/acceptance editing — see the epic-priority ticket), so the only accepted field is
 * `priority`. Mirrors parseTicketPatch's unknown-field-first rejection and reuses its exact priority
 * validator, then maps to a BeadPatch for beads.update.
 */
import { type BeadPatch } from "./beads/bd";
import { parsePriority } from "./ticket-patch";

export type ParsedEpicPatch = { patch: BeadPatch } | { error: string };

// The only field the epic detail is allowed to PATCH today. Anything else is rejected.
const ALLOWED_FIELDS = ["priority"] as const;

export function parseEpicPatch(body: unknown): ParsedEpicPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;

  // Reject any unknown field before validating, so an unknown key always wins over a bad value.
  for (const key of Object.keys(input)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
      return { error: `Unknown field: ${key}` };
    }
  }

  const patch: BeadPatch = {};
  if ("priority" in input) {
    const result = parsePriority(input.priority);
    if ("error" in result) return result;
    patch.priority = result.value as number;
  }

  return { patch };
}
