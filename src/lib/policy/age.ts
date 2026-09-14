/**
 * The age criterion, in one place: how old a bead is, and whether a policy's bounds admit that age.
 *
 * Age is the only policy input that is a function of WALL-CLOCK TIME rather than of the board, which
 * is why it is asked from three sides that must never disagree — the editor's per-bead explanation
 * ({@link ./match}), the startable projection the pass evaluates ({@link ./candidates}), and the
 * recorded plan's freshness fence (`board-picker-plan.ts`), which cannot hash a value that changes
 * every second and has to re-judge it instead. Written out three times, the rounding of "a day" is
 * three chances to disagree about which side of a bound a card sits on — so it lives here.
 *
 * Zero imports on purpose: {@link ./match} runs in the browser and states that it imports nothing
 * but its types, so anything it shares has to be at least as portable.
 */

/** The two bounds a policy may state about age. Structural so every caller can pass its own shape. */
export interface AgeBounds {
  minAgeDays?: number;
  maxAgeDays?: number;
}

/**
 * Which age bound refuses a candidate — carrying the two numbers the refusal is about, so a caller
 * explaining it never has to re-read the bound it was just told about.
 *
 * `unknown` is the fail-closed case: the policy asserts a bound and the bead cannot answer it.
 */
export type AgeBreach =
  | { bound: "unknown" }
  | { bound: "min" | "max"; ageDays: number; limit: number };

/**
 * Whole days since `createdAt`, or `undefined` when it carries no usable creation date — a real
 * state an asserted bound fails closed on, never a zero.
 */
export function ageInDays(createdAt: string | undefined, now: Date): number | undefined {
  if (!createdAt) return undefined;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return undefined;
  // Floored, so "at least 1 day old" means a full day has passed rather than a rounding of hours.
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

/**
 * The bound this age falls outside of, or `undefined` when none does.
 *
 * An unasserted policy places no constraint at all, so an undated bead never reaches `unknown`: a
 * board of undated beads is not excluded by a rule nobody wrote.
 */
export function ageBoundBreached(
  ageDays: number | undefined,
  bounds: AgeBounds,
): AgeBreach | undefined {
  const { minAgeDays, maxAgeDays } = bounds;
  if (typeof minAgeDays !== "number" && typeof maxAgeDays !== "number") return undefined;
  if (typeof ageDays !== "number") return { bound: "unknown" };
  if (typeof minAgeDays === "number" && ageDays < minAgeDays) {
    return { bound: "min", ageDays, limit: minAgeDays };
  }
  if (typeof maxAgeDays === "number" && ageDays > maxAgeDays) {
    return { bound: "max", ageDays, limit: maxAgeDays };
  }
  return undefined;
}
