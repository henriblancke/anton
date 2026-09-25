/**
 * Which beads a feature's ledger covers (anton-x72fk) — the `bead_id IN (...)` list, resolved from
 * the board snapshot the caller already holds.
 *
 * `claude_invocations.bead_id` is stamped with the TICKET an invocation ran for, so "what did this
 * feature cost" is a question about a SET of ids: the feature plus the working-layer beads that ride
 * on it. Nothing in the ledger rows says which feature a ticket belonged to — that fact lives only on
 * the board — so the walk has to come from the snapshot, and it comes from the one the caller passed.
 *
 * ## The snapshot is passed in, never fetched
 *
 * Same discipline as `review-trajectory`: the surfaces that want a ledger (the epic detail page, a
 * later CLI) have already loaded `bd list --status all` for everything else they render, and a scope
 * read that fetched its own board would add a bd spawn per feature to a page that already holds the
 * answer. So this module takes `Bead[]` and makes no bd call — which is also what makes it testable
 * against a literal fixture tree.
 *
 * ## The scope MOVES when the board does (design §D1)
 *
 * Parentage is read at ledger time, not frozen, so re-parenting a ticket moves its spend to its new
 * feature retroactively. Accepted deliberately: the board is the source of truth for structure, and a
 * frozen copy that disagreed with it would be the worse failure — a ledger nobody could reconcile
 * against the tree they are looking at. A bead purged from the board simply leaves its rows out of
 * every scope; they are orphaned, not reattributed.
 *
 * ## Why this is not in `feature-ledger.ts`
 *
 * The fold there is dependency-free on purpose (no db, no node builtins) so a client component can
 * import it. Parentage comes from `ticket-view`/`beads`, which reach node:fs through the bd wrapper,
 * and importing that into the fold would drag the whole bd module graph into every client bundle
 * that renders a ledger. Scope resolution is a server-side board read; it lives with its dependencies
 * instead of pulling them into the pure half.
 */
import { beads, type Bead } from "./beads/bd";
import { boardCards, runTickets } from "./ticket-view";

/** The ids one feature's ledger folds over, and the board fact behind them. */
export interface LedgerScope {
  /** The feature (or other run target) the ledger was asked about. */
  beadId: string;
  /**
   * Its working-layer descendants, in board order. Empty for a standalone target, which is its own
   * single ticket.
   */
  childIds: string[];
  /** `beadId` followed by {@link childIds} — the `bead_id IN (...)` list, in that order. */
  ids: string[];
  /**
   * The target's own bead, when this board carries one. Absent for an id the snapshot does not hold
   * (purged, or from another project's board), which a caller reports as not-on-this-board rather
   * than as a feature that spent nothing.
   */
  target?: Bead;
}

/**
 * The scope of `beadId` on `board`: itself plus every working-layer bead whose nearest run target is
 * it.
 *
 * Depth is the reason this delegates to {@link runTickets} rather than walking direct children: bd
 * nesting is arbitrary-depth, and under `feature → task → subtask` the subtask ships in the same
 * worktree and the same PR, so its invocations are part of what that feature cost. A direct-children
 * scope would under-report exactly the features that decomposed their work furthest.
 *
 * Descent stops at a nested run target for the same reason the run does: a feature nested under
 * another owns its own worktree, its own PR and its own ledger, so rolling its spend into the parent
 * would double-count it across two ledgers that each claim to be a total.
 *
 * The root is always in {@link LedgerScope.ids}, on the board or not — run-phase steps (`describe`,
 * self-review, PR-fix) stamp the run TARGET's id rather than a ticket's, so dropping it would lose
 * whole phases of the very spend the ledger exists to split.
 */
export function ledgerScope(board: Bead[], beadId: string): LedgerScope {
  const target = board.find((b) => b.id === beadId);
  const childIds = runTickets(board, beadId).map((b) => b.id);
  return {
    beadId,
    childIds,
    ids: [beadId, ...childIds],
    ...(target ? { target } : {}),
  };
}

/**
 * Whether `board` reads `beadId` as a run target at all — the beads that HAVE a ledger, because they
 * are what anton opens one PR for.
 *
 * Offered beside {@link ledgerScope} rather than folded into it: a scope is still resolvable for a
 * bead that is not a target (a lone ticket's own spend is a real figure), and a caller rendering a
 * per-FEATURE surface wants to refuse the ask instead of showing a one-bead total labelled as a
 * feature's cost.
 */
export function hasLedgerScope(board: Bead[], beadId: string): boolean {
  const target = board.find((b) => b.id === beadId);
  return target !== undefined && beads.isRunTarget(target, board);
}

/**
 * The run target `beadId` belongs to RIGHT NOW, per the same card-walk {@link ledgerScope} uses —
 * `beadId` itself when it already is one, otherwise `boardCards(board).cardOf` on it.
 *
 * A friction source (`escalations.ts`) freezes the target it resolved to at RAISE time in a column,
 * and a ticket reparented afterward leaves that column stale while the ticket's OWN id (never
 * reassigned) still resolves correctly through the board's current structure. Matching a scope
 * against the frozen column double-counts across the old and new feature; matching it against this
 * function's answer does not, because it always re-derives the walk from the board the caller is
 * holding right now (PR #322 review).
 *
 * `beadId` unchanged when the board holds no bead by that id (purged) or no card sits above it
 * (pipeline plumbing, a task parented directly on a container epic) — neither is a real run target,
 * so the id simply matches no scope's `beadId`, the same "orphaned, not reattributed" behavior
 * {@link ledgerScope} already gives a purged id.
 */
export function currentRunTargetOf(board: Bead[], beadId: string): string {
  const bead = board.find((b) => b.id === beadId);
  if (!bead) return beadId;
  if (beads.isRunTarget(bead, board)) return beadId;
  return boardCards(board).cardOf(bead) ?? beadId;
}
