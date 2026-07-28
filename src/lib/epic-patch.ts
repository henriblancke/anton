/**
 * Server-side validation for an epic edit — the epic dialog's PATCH body. An epic is READ, not
 * executed, so it carries a much smaller contract than a ticket: the outcome's name, where it sits
 * in the queue, and the product surface it advances. Those three are exactly what the roadmap
 * shows, and exactly what this accepts.
 *
 * Shares parseFieldSpecs with the ticket patch, so both surfaces enforce identical rules: unknown
 * fields are rejected before any value is validated, and an omitted field is untouched.
 */
import { type BeadPatch } from "./beads/bd";
import {
  nonEmptyString,
  parseFieldSpecs,
  parsePriority,
  type FieldParser,
  type FieldSpec,
} from "./ticket-patch";

export type ParsedEpicPatch = { patch: BeadPatch } | { error: string };

/**
 * The `area:` VOCABULARY is deliberately open — anton never validates which surfaces exist
 * (.product/decisions/2026-07-26-engine-designator-prefix.md). This checks only that the value is a
 * well-formed label: whitespace or a colon would produce a label bd cannot round-trip through
 * `area:<value>`, and `labelValueOf` would read back something the writer never typed.
 */
const AREA_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const areaSlug: FieldParser = (v) =>
  typeof v === "string" && AREA_SHAPE.test(v)
    ? { value: v }
    : {
        error: `Invalid area: ${String(v)} (expected a label-safe value — letters, digits, . _ -)`,
      };

/**
 * The flat fields the epic dialog may send. Notably absent: `status` (an epic's stage is derived
 * from its features, never set directly) and `description`/`acceptance` (the epic's outcome and
 * success criteria are shaped, not edited in a table row).
 */
const FIELD_SPECS: Record<string, FieldSpec> = {
  title: { parse: nonEmptyString("title"), target: "patch", key: "title" },
  priority: { parse: parsePriority, target: "patch", key: "priority" },
  area: { parse: areaSlug, target: "labels", key: "area" },
};

export function parseEpicPatch(body: unknown): ParsedEpicPatch {
  return parseFieldSpecs(body, FIELD_SPECS);
}
