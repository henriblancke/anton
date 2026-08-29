/**
 * The board, projected into the flat candidates the policy editor evaluates in the browser.
 *
 * The split exists so the evaluator ({@link ./match}) can stay client-safe: it must run on every
 * criterion edit, which means it runs in the browser, which means it cannot reach the bd reader.
 * Everything that needs the board — the `blocks` graph above all — is resolved here, once, on the
 * server that already holds the snapshot.
 *
 * OPEN beads only. A closed or in-flight bead is not work a policy could admit, and counting it
 * would inflate the one number the panel exists to make honest.
 */
import { beads } from "../beads/bd";
import { standaloneBlockers } from "../epic-graph";
import type { Bead } from "../beads/types";
import type { PolicyCandidate } from "./match";

/**
 * Pure over a board snapshot a caller already holds — no bd spawn.
 *
 * Blockedness comes from {@link standaloneBlockers}, the same rule the approve route and the runner
 * gate on, so the editor's "has an unmet blocker" can never disagree with what will actually refuse
 * to start. It is asked only about beads a `blocks` edge names: that rule walks the whole board per
 * call, and on a board where a handful of beads carry edges, asking it about all of them is the
 * difference between one pass and hundreds.
 */
export function policyCandidates(board: readonly Bead[]): PolicyCandidate[] {
  const all = board as Bead[];
  const dependents = new Set(
    beads.edgesOf(all).filter((e) => e.type === "blocks").map((e) => e.from),
  );

  return all
    .filter((b) => b.status === "open")
    .map((b) => {
      const blocked = dependents.has(b.id) && standaloneBlockers(all, b.id).length > 0;
      return {
        id: b.id,
        title: b.title,
        ...(b.issue_type ? { type: b.issue_type } : {}),
        ...(typeof b.priority === "number" ? { priority: b.priority } : {}),
        labels: b.labels ?? [],
        ...(blocked ? { blocked: true } : {}),
      };
    });
}
