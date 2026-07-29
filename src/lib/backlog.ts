import { beads, labelValueOf, type Bead } from "./beads/bd";
import { beadSkeleton, type BeadSkeleton } from "./beads/formula";
import { allIssues } from "./beads/issues";
import type { Project } from "./types";

/**
 * A shaping draft the founder accepts in the Add-work UI. The fields are exactly the epic's contract
 * (skills/bd/SKILL.md): an epic is READ, not executed, so it carries an outcome, the Success Criteria
 * its features add up to, and the one `area:` label the roadmap groups by — nothing else.
 *
 * They are all required rather than optional because this is the whole point of anton-8mnr: the
 * Add-work path produces a bead the contract validator passes BY CONSTRUCTION. An optional field here
 * would just re-open the gap the board then has to flag.
 */
export interface ShapeDraft {
  title: string;
  /** The outcome, in one line a stakeholder would recognise — the epic's `## Goal`. */
  goal: string;
  /** How we know the outcome is reached — mirrored into bd's own Success Criteria field. */
  successCriteria: string;
  /** The product surface this outcome advances, without the `area:` prefix. */
  area: string;
}

/**
 * The `area:` values already in use on the board, sorted — what the Add-work form suggests. Offering
 * the existing surfaces is what keeps the vocabulary from fragmenting into `report`/`reports`/
 * `reporting`; anton never validates WHICH surfaces exist, so reuse has to come from the UI.
 */
export function knownAreas(all: Bead[]): string[] {
  const areas = new Set<string>();
  for (const bead of all) {
    const area = labelValueOf(bead.labels, "area");
    if (area) areas.add(area);
  }
  return [...areas].sort();
}

/** The board's `area:` vocabulary, off the warm issue snapshot the board already reads. */
export async function getKnownAreas(project: Project): Promise<string[]> {
  return knownAreas(await allIssues(project.repoPath));
}

/**
 * Render a draft through the project's bead formula (`.beads/formulas/anton-bead.formula.json`,
 * anton's bundled copy as fallback). The shape is structural — the sections come from the formula,
 * not from this function remembering which headings an epic carries.
 */
export function buildEpicSkeleton(project: Project, draft: ShapeDraft): Promise<BeadSkeleton> {
  return beadSkeleton(project.repoPath, "epic", {
    title: draft.title,
    outcome: draft.goal,
    success_criteria: draft.successCriteria,
  });
}

/**
 * Create the open, unapproved epic bead from an accepted draft and return its id. No `approved`
 * label + open status → the board derives `backlog`. Bead writes go through `bd` (DESIGN.md §3).
 */
export async function createDraftEpic(project: Project, draft: ShapeDraft): Promise<string> {
  const skeleton = await buildEpicSkeleton(project, draft);
  return beads.create(project.repoPath, {
    title: draft.title.trim(),
    type: skeleton.type,
    description: skeleton.description,
    // The description is the canonical home of the contract; the mirror is what `bd lint` and the
    // board card read (parseAcceptance falls through to this field for an epic).
    acceptance: skeleton.acceptance,
    labels: [`area:${draft.area.trim()}`],
  });
}
