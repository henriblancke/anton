/**
 * What can be done to each class of escalation — the rules a surface needs before it draws a button,
 * with no database behind them.
 *
 * Its own module because both sides need it and neither can import the other's: the panel is a
 * Client Component, and `escalation-actions.ts` (which enforces these rules on the server) reaches
 * the database through `getDb` — importing it from the browser tree would drag drizzle and
 * better-sqlite3 into the bundle. Type-only re-exports solve that for shapes; a predicate is a
 * value, so it lives here, pure, and both sides import it.
 */
/**
 * Stable key prefix for the one project/cause escalation a LIVE board outage may raise (see
 * `boardUnreachableFinding` in jobs/run-health.ts, the source of truth for this shape). It lives
 * here, not there, because this module is the one both the client panel and the server action can
 * import without dragging bd/db into the browser bundle — see the module note above.
 */
export const BOARD_UNREACHABLE_FINDING_PREFIX = "exhausted-job:board-unreachable:";

/** Whether a finding or escalation key represents a project-wide board outage. */
export function isBoardUnreachableFindingKey(key: string): boolean {
  return key.startsWith(BOARD_UNREACHABLE_FINDING_PREFIX);
}

/**
 * Whether this class of alert can be put down (anton-7gxs).
 *
 * Three exceptions, and all are about what dismissing would HIDE rather than about tidiness:
 *
 *   • `needs-human` — an open gate. Settling the row ends nothing, and suppressing the re-raise
 *     would bury an ask somebody is still blocked on. Its answers are resolve-and-resume ("I did
 *     the thing") or abandon ("I won't").
 *   • `autopilot-disarm` — a frozen project. Nothing re-raises one (it is raised on the latch,
 *     once), so a dismissal would clear the one row saying anton has stopped while every card
 *     stayed stopped. Only a re-arm answers it, and the re-arm settles the row itself.
 *   • `board-outage` — the synthetic group kind `NeedsYouSection` buckets a live board outage under
 *     (an `exhausted-job` finding keyed on {@link BOARD_UNREACHABLE_FINDING_PREFIX}). It hasn't spent
 *     any retries — the runner refunds the affected jobs and leaves them queued — and `outageSince`
 *     deliberately keeps its `since`/`reason` stable for as long as the outage continues, so a
 *     dismissal's signature would keep matching and silence it for the outage's whole remaining
 *     lifetime rather than the one probe that raised it. It settles itself the moment the board
 *     answers again (`classifyExhaustedJob`'s hold), which is the only honest ending.
 *
 * `findingKey` is optional: the group-level check in `NeedsYouSection` already knows a group is an
 * outage bucket from its synthetic `"board-outage"` kind and has no single key to pass, while the
 * server-side per-row check passes the real `kind` ("exhausted-job") and `findingKey` so a direct
 * POST bundling an outage row into a bulk dismiss is refused the same way.
 */
export function isDismissable(kind: string, findingKey?: string): boolean {
  if (kind === "needs-human" || kind === "autopilot-disarm" || kind === "board-outage") {
    return false;
  }
  return !(findingKey !== undefined && isBoardUnreachableFindingKey(findingKey));
}
