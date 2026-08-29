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
 *
 * `now` is a PARAMETER because age is the one candidate field that is not a property of the board:
 * reading the clock inside the predicate would make it impure and its tests time-dependent, so the
 * clock is read once, here, and each bead carries the age it had when the board was projected.
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
export function policyCandidates(board: readonly Bead[], now: Date = new Date()): PolicyCandidate[] {
  const all = board as Bead[];
  const dependents = new Set(
    beads.edgesOf(all).filter((e) => e.type === "blocks").map((e) => e.from),
  );
  const byId = new Map(all.map((b) => [b.id, b]));

  return all
    .filter((b) => b.status === "open")
    .map((b) => {
      const blocked = dependents.has(b.id) && standaloneBlockers(all, b.id).length > 0;
      const depth = parentDepth(b, byId);
      const ageDays = ageInDays(b, now);
      return {
        id: b.id,
        title: b.title,
        ...(b.issue_type ? { type: b.issue_type } : {}),
        ...(typeof b.priority === "number" ? { priority: b.priority } : {}),
        ...(typeof depth === "number" ? { depth } : {}),
        ...(typeof ageDays === "number" ? { ageDays } : {}),
        labels: b.labels ?? [],
        ...(blocked ? { blocked: true } : {}),
      };
    });
}

/**
 * Parent hops above a bead — 0 for top-level work. `undefined` where the chain cannot be resolved: a
 * parent this snapshot does not carry, or a cycle a malformed board could hold. The predicate fails
 * closed on that rather than being handed a depth nobody computed, which is why this reports the gap
 * instead of defaulting it to 0.
 */
function parentDepth(bead: Bead, byId: ReadonlyMap<string, Bead>): number | undefined {
  const seen = new Set<string>([bead.id]);
  let current = bead;
  let depth = 0;
  let parent = beads.parentOf(current);
  while (parent) {
    const next = byId.get(parent);
    if (!next || seen.has(parent)) return undefined;
    seen.add(parent);
    current = next;
    depth += 1;
    parent = beads.parentOf(current);
  }
  return depth;
}

/** Whole days since the bead was filed, or `undefined` when it carries no usable creation date. */
function ageInDays(bead: Bead, now: Date): number | undefined {
  if (!bead.created_at) return undefined;
  const created = Date.parse(bead.created_at);
  if (Number.isNaN(created)) return undefined;
  // Floored, so "at least 1 day old" means a full day has passed rather than a rounding of hours.
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}
