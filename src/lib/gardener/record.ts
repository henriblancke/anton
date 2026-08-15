/**
 * THE RECORD (anton-hzce): one pass's account of what it applied, shadowed and refused — written as
 * a log line, and read back from one.
 *
 * An auto-applied proposal is closed the moment it is filed, so it never stands on the board as an
 * open ask at all: it goes straight from "not yet filed" to "closed", and the founder's first
 * evidence that anything happened is a bead that moved. The session log the passes already append to
 * IS the record; this module is what keeps it readable.
 *
 * Both halves live in ONE file on purpose. A formatter in armed.ts and a reader on the jobs page
 * would be two answers to "what does a record line look like", agreeing right up until a verdict is
 * reworded — and the failure mode is silent: the page would show a clean pass over a log full of
 * writes. The verdict vocabulary is declared here for the same reason, and the producers spell their
 * outcomes through it.
 *
 * Nothing here reads a board, a file or a bead. It is a string format and its inverse, so the same
 * shape crosses to the client component that renders it.
 */

/** Which half of the pass wrote the line: a real write, or the description of one. */
export type PassRecordMode = "apply" | "shadow";

/** What a reader counts a line as. `error` is anton failing to decide, never the board refusing. */
export type PassRecordOutcome = "applied" | "shadowed" | "refused" | "error";

/**
 * The verdicts an APPLY line can carry. `REFUSED` is the board declining — the ordinary answer for an
 * ask whose premise moved — while `COULD NOT APPLY` is a write that broke and was rolled back, and a
 * founder acts on those two very differently.
 */
export const APPLY_VERDICTS = {
  APPLIED: "applied",
  REFUSED: "refused",
  "COULD NOT APPLY": "error",
} as const satisfies Record<string, PassRecordOutcome>;

/**
 * The verdicts a SHADOW line can carry. Every verdict but the failure counts as `shadowed`: nothing
 * was written on any of them, and a would-refuse is the shadow working, not a refusal to act on.
 */
export const SHADOW_VERDICTS = {
  "WOULD APPLY": "shadowed",
  "ALREADY SETTLED": "shadowed",
  "WOULD REFUSE": "shadowed",
  "COULD NOT SHADOW": "error",
} as const satisfies Record<string, PassRecordOutcome>;

export type ApplyVerdict = keyof typeof APPLY_VERDICTS;
export type ShadowVerdict = keyof typeof SHADOW_VERDICTS;

const MODE_TOKEN: Record<PassRecordMode, string> = { apply: "APPLY", shadow: "SHADOW" };

/** One proposal's line, as the producers hold it before it becomes text. */
export interface PassRecordLine {
  mode: PassRecordMode;
  /** The proposal bead the pass filed. */
  proposal: string;
  /** A GardenerDetectionKind — a string here, so this module stays free of the detector's types. */
  kind: string;
  move: string;
  /** Which retirement a `retire` move ran — the verb that decides what the move COST. */
  retireAs?: string;
  subjects: string[];
  /** The move's counterpart: the new parent, the blocker, the replacement. */
  target?: string;
  verdict: ApplyVerdict | ShadowVerdict;
  /** The apply's summary, or its refusal/failure reason VERBATIM. */
  detail: string;
}

/** One proposal's line read back off a log, with the producer that wrote it. */
export interface PassRecord extends Omit<PassRecordLine, "move" | "retireAs" | "verdict"> {
  /** The pass that wrote it, off the log prefix — `gardener`, `product-master`. */
  producer: string;
  /** The move as written: `retire/close`, `reparent`. Never re-split, so a reader sees what ran. */
  verb: string;
  verdict: string;
  outcome: PassRecordOutcome;
}

/** A pass's whole record, as read off its session log. */
export interface PassRecordSummary {
  records: PassRecord[];
  /**
   * APPLY/SHADOW lines that are not one proposal's verdict — the write cap holding proposals back, a
   * board that would not read. Kept rather than dropped: a pass that could not shadow at all must not
   * render as a pass that found nothing to say.
   */
  notes: string[];
}

/** Collapse whitespace so one record is always one line — the parser's whole premise. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * One proposal's record line, without the producer prefix or the newline — the callers add those,
 * because the same prefix labels every other line their pass writes.
 */
export function passRecordLine(line: PassRecordLine): string {
  const verb = line.retireAs ? `${line.move}/${line.retireAs}` : line.move;
  const counterpart = line.target ? ` → ${line.target}` : "";
  return (
    `${MODE_TOKEN[line.mode]} ${line.proposal} (${line.kind}) ${verb} ` +
    `${line.subjects.join(", ")}${counterpart} — ${line.verdict}: ${oneLine(line.detail)}`
  );
}

/**
 * `[producer] MODE proposal (kind) verb subjects → target — VERDICT: detail`.
 *
 * The subjects run up to the FIRST em dash, which is what keeps a detail containing one ("it is no
 * longer on the board — nothing was applied") from being mistaken for the verdict separator. The
 * `(kind)` group is what tells a record from the pass's other APPLY/SHADOW lines: "APPLY held back
 * 3 armed proposal(s)" has no parenthesised kind in that position and falls through to a note.
 */
const RECORD_LINE =
  /^\[([^\]]+)\]\s+(APPLY|SHADOW)\s+(\S+)\s+\(([^)]+)\)\s+(\S+)\s+([^—]+?)\s+—\s+([A-Z][A-Z ]*?):\s*(.*)$/;

/** Any line one of the passes wrote about applying or shadowing, record or not. */
const PASS_LINE = /^\[([^\]]+)\]\s+((?:APPLY|SHADOW)\b.*)$/;

function outcomeOf(mode: PassRecordMode, verdict: string): PassRecordOutcome {
  const verdicts: Record<string, PassRecordOutcome> =
    mode === "apply" ? APPLY_VERDICTS : SHADOW_VERDICTS;
  // An unrecognised verdict reads as `error` rather than as a write: this reader is one anton behind
  // the log it is reading whenever a pass on another machine ran a newer build, and guessing that an
  // unknown word meant "applied" is the one wrong answer.
  return verdicts[verdict] ?? "error";
}

/** `t-6 → t-5` back into its subjects and the bead the move points at. */
function splitTarget(raw: string): { subjects: string[]; target?: string } {
  const [left, target] = raw.split(" → ");
  return { subjects: left.split(",").map((s) => s.trim()).filter(Boolean), target };
}

/**
 * A pass's record, read off its session log.
 *
 * Total over the log: anything that is not one of this pass's APPLY/SHADOW lines — the claude
 * transcript a product-master pass logs above its record, a half-written final line — is skipped
 * rather than guessed at.
 */
export function readPassRecords(log: string): PassRecordSummary {
  const records: PassRecord[] = [];
  const notes: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.trimEnd();
    const match = RECORD_LINE.exec(line);
    if (!match) {
      const note = PASS_LINE.exec(line);
      if (note) notes.push(note[2].trim());
      continue;
    }
    const [, producer, token, proposal, kind, verb, rest, verdict, detail] = match;
    const mode: PassRecordMode = token === "APPLY" ? "apply" : "shadow";
    records.push({
      producer,
      mode,
      proposal,
      kind,
      verb,
      ...splitTarget(rest),
      verdict,
      outcome: outcomeOf(mode, verdict),
      detail,
    });
  }
  return { records, notes };
}

/** How many proposals landed in each outcome — the counts the record leads with. */
export function passRecordCounts(summary: PassRecordSummary): Record<PassRecordOutcome, number> {
  const counts: Record<PassRecordOutcome, number> = {
    applied: 0,
    shadowed: 0,
    refused: 0,
    error: 0,
  };
  for (const record of summary.records) counts[record.outcome] += 1;
  return counts;
}

/**
 * A pass that had nothing to say — which is a RESULT, not a missing one. Notes count against it: a
 * pass whose board would not read said something, and calling that clean would be the record's one
 * unforgivable lie.
 */
export function isCleanPass(summary: PassRecordSummary): boolean {
  return summary.records.length === 0 && summary.notes.length === 0;
}
