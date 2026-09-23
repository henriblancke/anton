import { beads, type BeadVersion } from "./bd";

/**
 * The board version that began the bead's current closure cycle.
 *
 * `bd history` is newest first. Writes made while the bead remains closed (labels, notes, or an
 * edge repair) add versions above the close, so the identity is the OLDEST contiguous closed
 * version, not the newest version returned by history.
 */
export function currentClosureVersion(versions: readonly BeadVersion[]): string | undefined {
  let closure: BeadVersion | undefined;
  for (const version of versions) {
    if (version.status !== "closed") break;
    closure = version;
  }
  return closure?.hash;
}

/** Read the durable identity of a bead's current closure, if it has one. */
export async function readCurrentClosureVersion(repo: string, ticketId: string): Promise<string | undefined> {
  return currentClosureVersion(await beads.history(repo, ticketId));
}

/**
 * Whether `versions` (newest first, as {@link beads.history} returns them) shows the bead closed
 * before its CURRENT closed streak — i.e., reopened and reclosed at least once (chatgpt-codex-
 * connector, PR #284 review, "Reject unstamped survivors on closed tickets"). A board-evidence
 * survivor (a pending marker or a cleanup-unsynced obligation) with no stamped closure of its own is
 * ambiguous between closure episodes ONLY when more than one episode exists to confuse it with: a
 * bead closed exactly once has exactly one episode for any such survivor to belong to, so an
 * unstamped survivor there is unambiguous regardless of whether the stamp ever landed. Skips past the
 * current closed streak the same way {@link currentClosureVersion} identifies it, then asks whether
 * an earlier closed version exists anywhere behind it.
 */
export function reopenedBeforeCurrentClosure(versions: readonly BeadVersion[]): boolean {
  let i = 0;
  while (i < versions.length && versions[i].status === "closed") i += 1;
  return versions.slice(i).some((v) => v.status === "closed");
}

/**
 * The closure identity of the bead's last COMPLETED cycle, excluding whichever cycle `versions`'
 * own current status belongs to (chatgpt-codex-connector, PR #284 review, "Preserve the
 * originating cycle when stamping confirmations"). One walk serves two callers reading history at
 * two different moments of the same race:
 *
 * - Read on a currently OPEN bead, this is the closure of its last closed streak, if any — the
 *   identity a confirmation written while open (a standalone target parked at `stage:in-review`)
 *   can stamp itself with as its own originating cycle, since it has no closure of its own yet.
 * - Read on a currently CLOSED bead, this skips the streak {@link currentClosureVersion} already
 *   names and finds the one just behind it — the identity that confirmation's stored origin must
 *   still match for that CURRENT closure to be safe to fence against it.
 *
 * A mismatch between the two reads means a full extra cycle (reopen-then-close) landed on the bead
 * between the confirmation being written and the fence being attempted — exactly the case an
 * external writer's reopen-and-reclose produces, since `ensureBoardBaselinePersisted`'s own
 * reopen-reset only fires when THIS run redispatches the ticket itself.
 */
export function lastCompletedClosureVersion(versions: readonly BeadVersion[]): string | undefined {
  let i = 0;
  while (i < versions.length && versions[i].status === "closed") i += 1;
  while (i < versions.length && versions[i].status !== "closed") i += 1;
  return currentClosureVersion(versions.slice(i));
}
