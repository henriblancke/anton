import type { Epic } from "@/lib/types";

/**
 * A ready, unapproved backlog feature — the shape every epic-card suite starts from, so the card and
 * the decision lock around it are judged against one target.
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
