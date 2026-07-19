/**
 * The human steering channel on a bead's append-only `notes` blob (anton-bfy4).
 *
 * beads stores notes as ONE newline-joined string with no per-entry authorship, and anton's own
 * jobs already append single-line machine notes to it (`anton: run failed after …`). A human note
 * therefore carries its own header line so the blob stays parseable into attributed entries:
 *
 *   [human-note Henri Blancke 2026-07-19T22:49:46.000Z]
 *     first line
 *     second line
 *
 * The body is indented; parsing consumes indented lines only, so an anton note appended afterwards
 * (unindented) can never be swallowed into the human entry above it. Leaf module — no bd/IO
 * imports — so the dispatch prompt builder, the API route, and tests can all share it.
 */

export type TicketNoteSource = "human" | "system";

export interface TicketNote {
  source: TicketNoteSource;
  /** Who wrote it: the operator for a human note, "anton" for a machine note. */
  author: string;
  /** ISO timestamp, present only on human notes (beads records none for the blob itself). */
  at?: string;
  text: string;
}

const HEADER = /^\[human-note (.+) (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]$/;
const INDENT = "  ";

/**
 * Render one human note as its header + indented body. The author is flattened and stripped of
 * `]` so a crafted identity can't forge a header; body lines that would themselves look like a
 * header are defused for the same reason (the blob is append-only and unversioned).
 */
export function formatHumanNote(text: string, author: string, at: Date): string {
  const safeAuthor = author.replace(/[\]\r\n]/g, " ").trim() || "operator";
  const body = text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${INDENT}${line.replace(/^\[human-note /, "(human-note ")}`)
    .join("\n");
  return `[human-note ${safeAuthor} ${at.toISOString()}]\n${body}`;
}

/**
 * Split a bead's `notes` blob into attributed entries, oldest first. Anything that isn't a human
 * entry is a machine note — one per line, which is how anton's jobs write them.
 */
export function parseTicketNotes(notes: unknown): TicketNote[] {
  if (typeof notes !== "string" || !notes.trim()) return [];
  const out: TicketNote[] = [];
  let current: TicketNote | null = null;
  const lines: string[] = [];

  const flush = () => {
    if (!current) return;
    current.text = lines.join("\n").trim();
    if (current.text) out.push(current);
    current = null;
    lines.length = 0;
  };

  for (const line of notes.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      current = { source: "human", author: header[1]!, at: header[2]!, text: "" };
      continue;
    }
    if (current && line.startsWith(INDENT)) {
      lines.push(line.slice(INDENT.length));
      continue;
    }
    flush();
    const text = line.trim();
    if (text) out.push({ source: "system", author: "anton", text });
  }
  flush();
  return out;
}

/**
 * The human notes as a dispatch-prompt block, or undefined when there are none. Machine notes are
 * deliberately left out: they narrate anton's own past failures, while the executor needs the
 * human's steer — mixing them dilutes the instruction.
 */
export function humanNotesPromptBlock(notes: unknown): string | undefined {
  const human = parseTicketNotes(notes).filter((n) => n.source === "human");
  if (human.length === 0) return undefined;
  return [
    `## Human notes on this ticket`,
    `Steering left by the operator, newest last. Treat these as binding refinements of the ` +
      `acceptance criteria above — they were written by a human who is watching this work.`,
    ``,
    ...human.map((n) => `- **${n.author}** (${n.at}): ${n.text.replace(/\n/g, "\n  ")}`),
  ].join("\n");
}
