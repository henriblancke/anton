/**
 * The record a SATISFIED step leaves on its bead (anton-8h4b), and the reader that takes it back
 * apart.
 *
 * A satisfied step settled without a commit of its own: an earlier commit of the same run already met
 * its acceptance (anton-6l0q), and the branch bore that out (anton-nuft). On the board a close that
 * follows looks exactly like any other, so the bead itself has to say how it was settled — otherwise
 * a reader later cannot tell it from a step that produced its own commit, and the `bd close` alone
 * would read as a delivery the branch never carries under this ticket's name.
 *
 * The note speaks only of the settlement, never of a close (PR #253 review): it is written BEFORE
 * `bd close` runs, that close is best-effort and can fail, and a standalone target is never closed
 * here at all — it stays open in review until its PR merges. Whether the bead is closed is the
 * board's to say; this note says what the work was settled against.
 *
 * It rides the existing machine-note channel (see beads/notes.ts): one unindented `anton:` line, so
 * `parseTicketNotes` reads it back as a system note and a human note appended after it stays
 * attributed. The evidence sits in a trailing bracket exactly as a block note's does (block-note.ts),
 * but with its own words — `satisfied on <branch> by <sha>` — so the park gate's reader, which
 * matches only `committed on` / `nothing committed on`, never mistakes it for a block verdict.
 *
 * Leaf module: no bd, no IO.
 */
import { parseTicketNotes } from "./notes";

/** The commit a satisfied step was settled against — what the PR body and the bead both cite. */
export interface SatisfiedBy {
  /** Full sha once resolved against the repository; otherwise the sha as the agent named it. */
  commit: string;
  /**
   * The commit's subject line, when the repository could answer for it. anton's own commits are
   * subjected `<ticket-id>: <title>`, so this is usually the attribution a reader wants — which
   * ticket's work covered this one.
   */
  subject?: string;
  /** The agent's own account of how that commit covers the step, when it gave one. */
  note?: string;
}

/** A satisfied record read back off a bead's notes. */
export interface SatisfiedRecord {
  sessionId: string;
  branch: string;
  /** The sha as the note recorded it — full when the run could resolve it. */
  commit: string;
}

/** How much of the agent's account one note carries — a board summary, not a transcript. */
const NOTE_DETAIL_CHARS = 400;

/** Flatten to one line and cap; the blob is line-delimited, so this is a hard invariant. */
function oneLine(text: string, cap = Infinity): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap).trimEnd()}…` : flat;
}

/** The short form a person reads; the bracket keeps the full sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The one-line machine note a satisfied settlement writes on its bead. */
export function formatSatisfiedNote(args: {
  by: SatisfiedBy;
  sessionId: string;
  branch: string;
}): string {
  const { by, sessionId, branch } = args;
  const subject = by.subject ? ` "${oneLine(by.subject)}"` : "";
  const account = by.note ? ` Agent's account: ${oneLine(by.note, NOTE_DETAIL_CHARS)}` : "";
  return oneLine(
    `anton: satisfied by ${shortSha(by.commit)}${subject} — an earlier commit of this run already ` +
      `met this ticket's acceptance, so it was settled on that work and produced no commit of its ` +
      `own.${account} [session ${sessionId}, satisfied on ${branch} by ${by.commit}]`,
  );
}

/**
 * Read from the TRAILING bracket only, as block-note.ts does: everything ahead of it is prose the
 * agent wrote, and that prose can carry these very words. Git refnames cannot contain `[`, so a
 * final bracket opening with `session ` is always anton's own.
 */
const SATISFIED_CLAUSE = /\[session ([^[\]]*?), satisfied on (\S+) by ([0-9a-f]{7,40})\]$/;

/** One machine note's satisfied record, or undefined when it is not one. */
export function parseSatisfiedNote(note: string): SatisfiedRecord | undefined {
  const m = SATISFIED_CLAUSE.exec(note.trimEnd());
  return m ? { sessionId: m[1]!, branch: m[2]!, commit: m[3]! } : undefined;
}

/**
 * The NEWEST satisfied record across a bead's notes blob, or undefined when the bead was never
 * settled that way. Machine notes only: a human quoting the clause in a steer is not a settlement.
 */
export function latestSatisfiedRecord(notes: unknown): SatisfiedRecord | undefined {
  const machine = parseTicketNotes(notes).filter((n) => n.source === "system");
  for (let i = machine.length - 1; i >= 0; i--) {
    const record = parseSatisfiedNote(machine[i]!.text);
    if (record) return record;
  }
  return undefined;
}
