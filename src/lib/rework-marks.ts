/**
 * The two phrases a send-back leaves on the ticket it was sent back FROM — one definition, because
 * the friction counter matches exactly what the rework path renders (anton-464lw).
 *
 * A send-back's only durable per-occurrence record is the note it writes. The stage-label strip that
 * accompanies it (`RUN_STAGE_LABELS`, rework-pipeline.ts) is an ERASURE, and a label that is absent
 * now says nothing about how many times it was taken off; `bd reopen --reason` is an event the bead's
 * own row does not keep. So `countSendBacks` (feature-ledger.ts) counts these notes — and a phrase
 * reworded on one side only would silently zero that counter, which is exactly the drift
 * rework-notes.ts's own header exists to prevent.
 *
 * ORIGIN-SIDE only, and that is what makes the count exact. Every send-back writes one note on the
 * ticket it came from — a reopen its own instructions, a follow-up the pointer at what that ticket's
 * review produced — and one on the bead that RECEIVES the work, which is the same event seen from
 * the other end. A follow-up created under the target sits in the same feature's scope as its origin,
 * so counting one side only is what keeps each send-back worth exactly one.
 *
 * Its own leaf module, with no imports, because both sides have to reach it: rework-notes.ts renders
 * through it, and `feature-ledger.ts` is dependency-free on purpose so a client component can import
 * the fold — importing rework-notes.ts there would drag mdast into every bundle that renders a ledger.
 */

/** Opens the instruction note a REOPEN lands on the ticket it sends back. */
export const REOPEN_NOTE_HEAD = "Rework — acceptance not met. Sent back from ";

/**
 * Closes the pointer a FOLLOW-UP lands on its origin ticket, after the new bead's id.
 *
 * Matched with the id in front of it rather than as a bare phrase, because the note the follow-up
 * BEAD receives opens `Follow-up on <origin> — its acceptance stands` — a prefix on `Follow-up `
 * alone would match that too and count every send-back twice whenever the follow-up runs under the
 * same feature as its origin.
 */
export const FOLLOW_UP_ORIGIN_PHRASE = " was opened from this ticket's review";

/** `Follow-up <id> was opened from this ticket's review`, anchored — see the phrase above. */
const FOLLOW_UP_ORIGIN_NOTE = new RegExp(`^Follow-up \\S+${FOLLOW_UP_ORIGIN_PHRASE}`);

/**
 * Does this note record that the bead carrying it was SENT BACK — reopened with instructions, or
 * pointed at the follow-up its review produced?
 *
 * A proxy, never proof: the blob is free text a founder can write into by hand. That is the same
 * standing every friction signal has (design §D3) and the reason none of them may be presented as a
 * quality score.
 */
export function isSendBackNote(text: string): boolean {
  return text.startsWith(REOPEN_NOTE_HEAD) || FOLLOW_UP_ORIGIN_NOTE.test(text);
}
