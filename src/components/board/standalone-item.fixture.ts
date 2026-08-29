import type { StandaloneItem } from "@/lib/types";

/**
 * A ready, unapproved backlog task — the shape every standalone-chip suite starts from, so the chip
 * shell and its extracted parts are all judged against one item.
 */
export function makeStandaloneItem(over: Partial<StandaloneItem> = {}): StandaloneItem {
  return {
    id: "t-1",
    title: "Loose task",
    type: "task",
    status: "open",
    stage: "backlog",
    approved: false,
    assignee: null,
    createdAt: "",
    createdBy: null,
    blockedBy: [],
    ready: true,
    unread: false,
    deferred: false,
    abandoned: false,
    ...over,
  };
}
