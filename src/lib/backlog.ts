import { beads } from "./beads/bd";
import type { Project } from "./types";

/**
 * A shaping draft the founder accepts in the Add-work UI. Minimal by design: the interactive
 * `/shape` conversation forms the thinking, and the founder commits a title + goal. It lands as an
 * open (unapproved) epic — the board renders it in `backlog`.
 */
export interface ShapeDraft {
  title: string;
  goal?: string;
}

/**
 * Render a draft into the bead `description` markdown. We emit a `## Goal` section so the board's
 * `parseGoal` picks it up on the epic card; an empty goal yields a title-only epic (still a valid
 * open backlog bead — the founder can flesh it out later or in a follow-up shaping pass).
 */
export function buildEpicDescription(draft: ShapeDraft): string | undefined {
  const goal = draft.goal?.trim();
  if (!goal) return undefined;
  return `## Goal\n${goal}`;
}

/**
 * Create the open, unapproved epic bead from an accepted draft and return its id. No `approved`
 * label + open status → the board derives `backlog`. Bead writes go through `bd` (DESIGN.md §3).
 */
export async function createDraftEpic(project: Project, draft: ShapeDraft): Promise<string> {
  return beads.create(project.repoPath, {
    title: draft.title.trim(),
    type: "epic",
    description: buildEpicDescription(draft),
  });
}
