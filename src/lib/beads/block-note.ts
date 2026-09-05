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
 * The clause is read from the note's TRAILING bracket and nowhere else (PR #227 review). Everything
 * ahead of it is free text the agent wrote — a `blocked` reason, a failure message — and that text
 * can carry the clause's own words: a post-commit failure whose error quotes "nothing committed on
 * main" would otherwise be classified as a zero-diff block and hand the operator the opposite
 * remedy.
 *
 * Unambiguous because `blockNoteEvidence` appends the clause last and git refnames cannot contain
 * `[`, so a note's final bracket opening with `session ` is always anton's own. Inside it the
 * session id and the branch stay free text — only the words this module writes are matched.
 */
const EVIDENCE_CLAUSE = /\[(session [^[\]]*)\]$/;
const COMMITTED = /, committed on \S+ @ ([0-9a-f]{7,40})$/;
const NOTHING_COMMITTED = /, nothing committed on \S+$/;

/** Read one machine note's evidence back: committed work (with its short sha), or none. */
export function blockNoteCommit(note: string): BlockNoteCommit | undefined {
  const clause = EVIDENCE_CLAUSE.exec(note.trimEnd())?.[1];
  if (!clause) return undefined;
  const head = COMMITTED.exec(clause)?.[1];
  if (head) return { committed: true, head };
  return NOTHING_COMMITTED.test(clause) ? { committed: false } : undefined;
}

/**
 * The NEWEST verdict across a ticket's machine notes, oldest first as `parseTicketNotes` returns
 * them. Newest-first scan rather than "the last note", because a later note about something else
 * (a gardener repair, a timeout release) must not erase the block's evidence — and an older run's
 * verdict must not outrank the newest one.
 *
 * Known limit: the notes blob is append-only and unattributed in time, so a verdict cannot be tied
 * to the block that is currently holding the ticket. A ticket blocked with committed evidence,
 * reopened, then blocked again BY HAND (which leaves no machine note) still reads back the older
 * run's sha. That sha is real and still on the branch, and the park only ever asks the operator to
 * review it before closing — so the cost is a stale pointer, not a wrong move. Tightening this
 * needs a lifecycle marker on the blob, not a smarter scan (PR #227 review).
 */
export function latestBlockNoteCommit(notes: string[]): BlockNoteCommit | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    const commit = blockNoteCommit(notes[i]!);
    if (commit) return commit;
  }
  return undefined;
}
