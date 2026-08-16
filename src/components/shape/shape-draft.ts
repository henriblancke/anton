/**
 * Pure form helpers for the Add-work draft panel — kept out of the client component so the submit
 * gate is unit-testable in the node env, mirroring ticket-dialog-utils.ts.
 *
 * The fields ARE the contract of what lands: a `feature` — one worktree, one PR, the tier anton
 * actually runs (anton-h1ds) — plus the epic it hangs off. The panel refuses to submit until every
 * section is there AND an epic is chosen, because a bead rendered from the project's formula must
 * land conformant rather than arrive for the board to flag, and a parentless feature runs fine while
 * appearing on no roadmap. `AREA_SHAPE` is the epic dialog's own check, so both write paths accept
 * exactly the same label vocabulary.
 */
import { AREA_SHAPE } from "@/lib/epic-patch";

/** The five contract sections a run and its self-review read, plus the feature's title. */
export interface FeatureDraftFields {
  title: string;
  goal: string;
  acceptance: string;
  context: string;
  outOfScope: string;
  verify: string;
}

/** The epic contract — only filled when the founder creates the epic instead of picking one. */
export interface EpicDraftFields {
  title: string;
  goal: string;
  successCriteria: string;
  area: string;
}

/** The picker value that means "create the epic here" rather than naming one on the board. */
export const NEW_EPIC = "__new__";

export interface ShapeDraftFields {
  feature: FeatureDraftFields;
  /** "" until the founder picks an epic; {@link NEW_EPIC} when they choose to create one. */
  epicId: string;
  epic: EpicDraftFields;
}

/** Is the panel creating the epic, rather than attaching to one already on the board? */
export function isNewEpic(draft: ShapeDraftFields): boolean {
  return draft.epicId === NEW_EPIC;
}

/**
 * The still-empty pieces, named the way the panel labels them. Drives both the disabled Send button
 * and the line under it, so "why can't I submit" never needs a guess. The epic comes FIRST: it is
 * the choice everything else hangs off, and the one this path used to skip entirely.
 */
export function draftGaps(draft: ShapeDraftFields): string[] {
  const gaps: string[] = [];
  if (!draft.epicId.trim()) gaps.push("an epic");
  else if (isNewEpic(draft)) {
    if (!draft.epic.title.trim()) gaps.push("an epic title");
    if (!draft.epic.goal.trim()) gaps.push("an epic outcome");
    if (!draft.epic.successCriteria.trim()) gaps.push("epic success criteria");
    if (!draft.epic.area.trim()) gaps.push("an area");
  }
  if (!draft.feature.title.trim()) gaps.push("a title");
  if (!draft.feature.goal.trim()) gaps.push("a goal");
  if (!draft.feature.acceptance.trim()) gaps.push("acceptance criteria");
  if (!draft.feature.context.trim()) gaps.push("context");
  if (!draft.feature.outOfScope.trim()) gaps.push("out of scope");
  if (!draft.feature.verify.trim()) gaps.push("verify");
  return gaps;
}

/** Is the typed area a label bd can round-trip? Empty is "not yet typed", not "wrong". */
export function isAreaValid(area: string): boolean {
  const trimmed = area.trim();
  return trimmed === "" || AREA_SHAPE.test(trimmed);
}

/**
 * Whether the draft's area is usable. An area typed for a new epic and then abandoned for an
 * existing one must not keep Send disabled — the value is never sent in that branch.
 */
export function draftAreaValid(draft: ShapeDraftFields): boolean {
  return !isNewEpic(draft) || isAreaValid(draft.epic.area);
}

/** Whether "Send to backlog" may fire: every field present, and the area label-safe. */
export function canSubmitDraft(draft: ShapeDraftFields): boolean {
  return draftGaps(draft).length === 0 && draftAreaValid(draft);
}

/** How many gaps the hint names before it summarises the rest — a footer line, not a checklist. */
const HINT_GAPS = 3;

/**
 * The line under the Send button. A disabled button must always say why — a malformed area leaves
 * no GAP, so without this branch the panel would read "ready to land" while refusing to submit.
 * A fresh draft is missing everything, so the list is clipped rather than wrapped over four lines.
 */
export function submitHint(gaps: string[], areaValid: boolean): string {
  if (!areaValid) return "Area must be a single label-safe word";
  if (gaps.length > HINT_GAPS) {
    return `Needs ${gaps.slice(0, HINT_GAPS).join(", ")} + ${gaps.length - HINT_GAPS} more`;
  }
  if (gaps.length > 0) return `Needs ${gaps.join(", ")}`;
  return "Lands as an open feature · unapproved";
}

/** The POST body: the feature's sections, trimmed, and the epic it attaches to. */
export function draftBody(draft: ShapeDraftFields) {
  return {
    feature: {
      title: draft.feature.title.trim(),
      goal: draft.feature.goal.trim(),
      acceptance: draft.feature.acceptance.trim(),
      context: draft.feature.context.trim(),
      outOfScope: draft.feature.outOfScope.trim(),
      verify: draft.feature.verify.trim(),
    },
    epic: isNewEpic(draft)
      ? ({
          kind: "new",
          epic: {
            title: draft.epic.title.trim(),
            goal: draft.epic.goal.trim(),
            successCriteria: draft.epic.successCriteria.trim(),
            area: draft.epic.area.trim(),
          },
        } as const)
      : ({ kind: "existing", id: draft.epicId.trim() } as const),
  };
}
