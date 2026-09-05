/**
 * The evidence clause anton appends to every block note it writes on a ticket, and the reader that
 * takes it back apart (PR #227 review).
 *
 * Both ends live here because they must agree: the ticket runner records whether the blocked work
 * LANDED (`committed on <branch> @ <sha>`) or not (`nothing committed on <branch>`), and the board's
 * park gate reads that back to pick the remedy it recommends. The two states are owed opposite
 * moves — a zero-diff block is reopened and re-run, while a committed one is reviewed and closed —
 * so a reader guessing at the format would hand the operator the wrong one.
 *
 * Leaf module: no bd, no IO, no imports.
 */

/** What a block note says about the work behind it, or undefined when the note carries no evidence. */
export type BlockNoteCommit = { committed: false } | { committed: true; head: string };

/** The evidence clause: which session, and the branch + short sha when work was committed. */
export function blockNoteEvidence(args: {
  sessionId: string;
  branch: string;
  /** The committed tip, full sha; absent when this ticket committed nothing. */
  head?: string;
}): string {
  const { sessionId, branch, head } = args;
  return head
    ? `session ${sessionId}, committed on ${branch} @ ${head.slice(0, 7)}`
    : `session ${sessionId}, nothing committed on ${branch}`;
}

/**
 * Tolerant of everything ahead of it — the session id and the branch name are free text, and the
 * note itself is whitespace-flattened before it reaches the blob — so only the two shapes this
 * module writes are matched, anchored on the clause's own words.
 */
const COMMITTED = /\bcommitted on \S+ @ ([0-9a-f]{7,40})\b/;
const NOTHING_COMMITTED = /\bnothing committed on \S+/;

/** Read one machine note's evidence back: committed work (with its short sha), or none. */
export function blockNoteCommit(note: string): BlockNoteCommit | undefined {
  // Order matters: "nothing committed on …" contains "committed on", so the negative is asked first.
  if (NOTHING_COMMITTED.test(note)) return { committed: false };
  const head = COMMITTED.exec(note)?.[1];
  return head ? { committed: true, head } : undefined;
}

/**
 * The NEWEST verdict across a ticket's machine notes, oldest first as `parseTicketNotes` returns
 * them. Newest-first scan rather than "the last note", because a later note about something else
 * (a gardener repair, a timeout release) must not erase the block's evidence — and an older run's
 * verdict must not outrank the newest one.
 */
export function latestBlockNoteCommit(notes: string[]): BlockNoteCommit | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    const commit = blockNoteCommit(notes[i]!);
    if (commit) return commit;
  }
  return undefined;
}
