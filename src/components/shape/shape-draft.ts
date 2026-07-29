/**
 * Pure form helpers for the Add-work draft panel — kept out of the client component so the submit
 * gate is unit-testable in the node env, mirroring ticket-dialog-utils.ts.
 *
 * The fields ARE the epic contract (anton-8mnr): an outcome, the Success Criteria its features add
 * up to, and one `area:`. The panel refuses to submit until all four are there, because the bead is
 * rendered from the project's bead formula and must land conformant rather than arrive for the
 * board to flag as unshaped. `AREA_SHAPE` is the epic dialog's own check, so both write paths accept
 * exactly the same label vocabulary.
 */
import { AREA_SHAPE } from "@/lib/epic-patch";

export interface ShapeDraftFields {
  title: string;
  goal: string;
  successCriteria: string;
  area: string;
}

/**
 * The still-empty pieces, named the way the panel labels them. Drives both the disabled Send button
 * and the line under it, so "why can't I submit" never needs a guess.
 */
export function draftGaps(draft: ShapeDraftFields): string[] {
  const gaps: string[] = [];
  if (!draft.title.trim()) gaps.push("a title");
  if (!draft.goal.trim()) gaps.push("an outcome");
  if (!draft.successCriteria.trim()) gaps.push("success criteria");
  if (!draft.area.trim()) gaps.push("an area");
  return gaps;
}

/** Is the typed area a label bd can round-trip? Empty is "not yet typed", not "wrong". */
export function isAreaValid(area: string): boolean {
  const trimmed = area.trim();
  return trimmed === "" || AREA_SHAPE.test(trimmed);
}

/** Whether "Send to backlog" may fire: every field present, and the area label-safe. */
export function canSubmitDraft(draft: ShapeDraftFields): boolean {
  return draftGaps(draft).length === 0 && isAreaValid(draft.area);
}

/**
 * The line under the Send button. A disabled button must always say why — a malformed area leaves
 * no GAP, so without this branch the panel would read "ready to land" while refusing to submit.
 */
export function submitHint(gaps: string[], areaValid: boolean): string {
  if (!areaValid) return "Area must be a single label-safe word";
  if (gaps.length > 0) return `Needs ${gaps.join(", ")}`;
  return "Lands as an open bead · unapproved";
}
