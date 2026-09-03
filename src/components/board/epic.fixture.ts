import type { Epic } from "@/lib/types";

/**
 * The one `Epic` row every board suite builds its cards from — a ready, unapproved backlog feature.
 * Each suite used to inline the same 17-field literal, so a new required field meant editing all of
 * them and a card test could quietly drift from the shape `toEpic` actually produces.
 *
 * Test-support only (see `.stringer.yaml`): a suite overrides just the fields its case is about.
 */
export function makeEpic(over: Partial<Epic> = {}): Epic {
  const ready = over.ready ?? true;
  return {
    id: "anton-1",
    title: "Resumable crawl checkpoints",
    type: "feature",
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready,
    // Mirrors toEpic's own fallback: a fixture that says only `ready: false` means fully blocked.
    childReadiness: ready ? "ready" : "blocked",
    readyChildren: [],
    blockedChildren: [],
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

/** The same row keyed by id, for suites whose cards are only ever told apart by it. */
export function makeEpicRow(id: string, over: Partial<Epic> = {}): Epic {
  return makeEpic({ id, title: id, ...over });
}
