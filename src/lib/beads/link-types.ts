/**
 * The dependency types anton is allowed to write, and the audit that finds edges outside them
 * (anton-igkb).
 *
 * **bd does not validate `--type`.** It accepts any non-empty string up to 50 characters, stores it
 * verbatim and round-trips it through export, and reports no error at any point
 * (`.product/decisions/2026-07-28-bd-workflow-primitives.md` §3, measured on bd 1.1.0 and 1.1.2). Of
 * every type it accepts, only `blocks` and `conditional-blocks` carry blocking semantics — the rest,
 * including `waits-for`, are no-ops indistinguishable from a typo. So a mistyped or refactor-broken
 * type writes an ordering edge that LOOKS right on the board and blocks nothing. bd will never
 * reject it, which makes this seam the only place the mistake can be caught.
 *
 * The hole is specific to `link`/`dep add`. bd's OTHER edge-writing door, `bd create --deps
 * '<type>:<id>'`, validates against an enum and fails loud on a typo (measured on 1.1.2:
 * `unknown dependency type "blocsk"; valid types: …`, and nothing is created) — so it needs no
 * guard here, and the asymmetry is why one door was left open.
 *
 * Kept dependency-free (like ./types) so bd.ts can validate against it without an import cycle, and
 * so `lib/types.ts` can alias `DepType` off it type-only without pulling lib/beads into the browser
 * bundle.
 */

/**
 * What anton means by an edge: `blocks` for ordering, the other three for non-blocking links.
 *
 * `conditional-blocks` is deliberately absent even though it blocks: it is behaviourally IDENTICAL
 * to `blocks` (it releases the moment the upstream closes — no conditional behaviour is observable),
 * so admitting it would split the board's ordering edges across two spellings for nothing gained.
 * One spelling means one thing to read for, on the board and in every query anton writes.
 */
export const LINK_TYPES = ["blocks", "parent-child", "related", "discovered-from"] as const;

export type LinkType = (typeof LINK_TYPES)[number];

export function isLinkType(type: string): type is LinkType {
  return (LINK_TYPES as readonly string[]).includes(type);
}

/**
 * Refuse anything outside {@link LINK_TYPES} before it reaches bd. Throws rather than falling back to
 * `blocks`: a caller that asked for a type anton does not write is wrong about what it is writing,
 * and quietly correcting it would hide exactly the bug this guard exists to surface.
 */
export function assertLinkType(type: string): asserts type is LinkType {
  if (isLinkType(type)) return;
  throw new Error(
    `bd link: refusing dependency type ${JSON.stringify(type)} — bd accepts any string here and ` +
      `would silently write a NON-BLOCKING edge. Allowed: ${LINK_TYPES.join(", ")}.`,
  );
}

/**
 * Types that reach the board without passing through {@link LINK_TYPES}, mapped to the write that
 * puts them there. bd creates these itself, so an audit that reported them as suspicious would
 * report a permanent false positive — they are listed, not hidden, so the distinction stays visible.
 */
const NON_LINK_WRITERS: Record<string, string> = {
  supersedes: "bd supersede (beads.supersede)",
};

/**
 * Types outside {@link LINK_TYPES} that still order work. `conditional-blocks` is excluded from the
 * allowed set because it is a second spelling, NOT because it is inert — it blocks identically to
 * `blocks`. An audit that lumped it in with the no-ops would tell an operator the board has less
 * ordering than it does, which is the opposite of the mistake this audit exists to surface.
 */
const BLOCKING_NON_LINK_TYPES = new Set(["conditional-blocks"]);

/** One board edge whose type anton's own seam would not write. */
export interface StrayEdge {
  from: string;
  to: string;
  type: string;
  /** The bd command that legitimately writes this type; absent when nothing anton runs writes it. */
  writtenBy?: string;
  /** Set when the type orders work despite being outside {@link LINK_TYPES}. */
  blocking?: true;
}

/**
 * Every edge whose type is outside {@link LINK_TYPES} — the one-shot audit behind
 * `scripts/audit-link-types.ts`. Pure over the edge list (`beads.edgesOf`) so the rule is unit-tested
 * without a board.
 *
 * An edge with no `writtenBy` is the finding that matters: nothing anton runs writes that type, so it
 * is either a hand-added edge or a silent no-op left by a call site that predates this guard. The
 * `blocking` flag separates the two shapes that finding takes — a stray that orders nothing from one
 * that orders work under a spelling anton does not read for.
 */
export function auditLinkTypes(
  edges: Array<{ from: string; to: string; type: string }>,
): StrayEdge[] {
  return edges
    .filter((e) => !isLinkType(e.type))
    .map((e) => ({
      ...e,
      ...(NON_LINK_WRITERS[e.type] ? { writtenBy: NON_LINK_WRITERS[e.type] } : {}),
      ...(BLOCKING_NON_LINK_TYPES.has(e.type) ? { blocking: true as const } : {}),
    }));
}

/** The strays nothing anton runs explains — what an operator has to look at. */
export function unexplainedEdges(strays: StrayEdge[]): StrayEdge[] {
  return strays.filter((s) => !s.writtenBy);
}
