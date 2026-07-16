/**
 * Pure orientation helper for the epic-detail dependency graph. Kept free of React/XYFlow so it's
 * node-testable (see dependency-graph-model.test.ts), mirroring project-graph-model.ts.
 *
 * beads stores every edge dependent→blocker (`from` = issue_id = the dependent/blocked side).
 * For `blocks` that means the raw direction is the reverse of how the "blocks" label reads, so
 * flip it to blocker→blocked — the arrow then reads "X blocks Y" and agrees with the board's
 * "blocked by" chip. Other edge types (part of / related / discovered from) already read correctly
 * in the stored direction and are left as-is.
 */
import type { DepEdge } from "@/lib/types";

export function orientEdge(edge: DepEdge): { source: string; target: string } {
  return edge.type === "blocks"
    ? { source: edge.to, target: edge.from }
    : { source: edge.from, target: edge.to };
}
