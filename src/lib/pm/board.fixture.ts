/**
 * The bead builder and the clock the pm suites judge against (anton-mspj), shared by the guard,
 * detection and bead-line suites rather than inlined in each.
 *
 * One builder because the guards are asserted against the SAME board shapes from different angles —
 * a bar only means anything next to the ones around it — and a per-suite copy lets two suites drift
 * into asserting different boards under one name.
 *
 * Test-support: no suite of its own by design (`.stringer.yaml` excludes `*.fixture.ts`).
 */
import type { Bead } from "../beads/bd";

/** A fixed clock, so an age, a lease and a run claim all date deterministically. */
export const NOW = Date.parse("2026-08-04T12:00:00Z");

/** One bead, defaulted to the plainest thing a board holds: an open P2 task titled after its id. */
export function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", priority: 2, ...o };
}
