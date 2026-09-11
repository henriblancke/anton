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
 * Whether this class of alert can be put down (anton-7gxs).
 *
 * Two exceptions, and both are about what dismissing would HIDE rather than about tidiness:
 *
 *   • `needs-human` — an open gate. Settling the row ends nothing, and suppressing the re-raise
 *     would bury an ask somebody is still blocked on. Its answers are resolve-and-resume ("I did
 *     the thing") or abandon ("I won't").
 *   • `autopilot-disarm` — a frozen project. Nothing re-raises one (it is raised on the latch,
 *     once), so a dismissal would clear the one row saying anton has stopped while every card
 *     stayed stopped. Only a re-arm answers it, and the re-arm settles the row itself.
 */
export function isDismissable(kind: string): boolean {
  return kind !== "needs-human" && kind !== "autopilot-disarm";
}
