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
