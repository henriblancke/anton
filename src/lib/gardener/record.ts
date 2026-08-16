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

/**
 * What a reader counts a line as. `error` is anton failing to decide, never the board refusing —
 * and `unrecorded` is neither: the attempt is on the record and its RESULT never reached the log,
 * so the board is the only evidence of what landed.
 *
 * `unsettled` is the pair of them: the move LANDED and the proposal that authorised it could not be
 * closed, so the board carries the write and the ask is still standing over it. Counted apart from
 * both — a founder acts on it (approving the open proposal settles it), and folding it into `error`
 * would promise them a board nothing happened to.
 *
 * `stranded` is the same lie from the other side: the write BROKE, and the rollback could not put
 * every bead back (apply-steps.ts `rollbackSteps`). It is an `error` in every other respect and is
 * still counted apart from one, because `error` is the verdict that promises an unchanged board —
 * and this is the one failure that moved it.
 */
export type PassRecordOutcome =
  | "applied"
  | "unsettled"
  | "shadowed"
  | "refused"
  | "error"
  | "stranded"
  | "unrecorded";

/**
 * The verdicts an APPLY line can carry. `REFUSED` is the board declining — the ordinary answer for an
 * ask whose premise moved — while `COULD NOT APPLY` is a write that broke and was rolled back, and a
 * founder acts on those two very differently.
 *
 * `APPLIED BUT NOT SETTLED` is the third of that family and the one neither of the others may absorb:
 * the move is ON the board and its proposal could not be closed (gardener/apply.ts `settleProposal`).
 * Saying `APPLIED` would hide an ask still standing; saying `COULD NOT APPLY` would hide a bead the
 * pass moved unattended.
 *
 * `COULD NOT ROLL BACK` is the fourth, and it exists for the same reason: a write that broke and
 * whose undo could not reach every bead it had already moved (apply.ts `stepFailure`). The beads it
 * left standing ride in `ProposalApplyError.changed`, which the LINE cannot carry — so without a
 * verdict of its own the record would file a moved board under the one verdict that promises an
 * untouched one, and the Jobs page could not tell it from a rollback that finished.
 *
 * `APPLYING` is written BEFORE the board is touched, so the attempt is on the record even if the
 * outcome line never lands (gardener/armed.ts): the record is what a retry reconstructs the pass's
 * write budget from (jobs/pass-budget.ts), and a spend written afterwards is, for the window in
 * between, a board write nothing can see. The outcome line for the same proposal supersedes it — one
 * left standing counts as neither an apply nor a failure, because nobody knows which it was.
 */
export const APPLY_VERDICTS = {
  APPLYING: "unrecorded",
  APPLIED: "applied",
  "APPLIED BUT NOT SETTLED": "unsettled",
  REFUSED: "refused",
  "COULD NOT APPLY": "error",
  "COULD NOT ROLL BACK": "stranded",
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
 *
 * The producer is spelled out rather than matched as "anything in brackets", and both patterns below
 * share the list. A product-master pass streams a claude transcript into the same log, and an
 * `[assistant]` line that happens to be shaped like a record IS shaped like one — the only thing that
 * separates a write anton made from a sentence a model wrote is which pass claims to have made it.
 */
const RECORD_LINE =
  /^\[(gardener|product-master)\]\s+(APPLY|SHADOW)\s+(\S+)\s+\(([^)]+)\)\s+(\S+)\s+([^—]+?)\s+—\s+([A-Z][A-Z ]*?):\s*(.*)$/;

/** Any line one of the passes wrote about applying or shadowing, record or not. */
const PASS_LINE = /^\[(gardener|product-master)\]\s+((?:APPLY|SHADOW)\b.*)$/;

/**
 * Is this a line {@link readPassRecords} would read? The filter a whole-log scan applies so a
 * megabyte of claude transcript is streamed past rather than held in memory (jobs/pass-records.ts).
 */
export function isPassLogLine(line: string): boolean {
  return PASS_LINE.test(line.trimEnd());
}

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
 *
 * An APPLY writes TWICE about one proposal — the `APPLYING` reservation, then its outcome — so the
 * later line SUPERSEDES the earlier in place. That is what makes one proposal one record however the
 * pass fared: the page shows the outcome rather than both halves of it, and the write budget counts
 * the attempt once rather than twice (jobs/pass-budget.ts). Keyed by producer as well as proposal,
 * for the reason the line itself is: two passes are two accounts.
 */
export function readPassRecords(log: string): PassRecordSummary {
  const records: PassRecord[] = [];
  const notes: string[] = [];
  const applies = new Map<string, number>();
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
    const record: PassRecord = {
      producer,
      mode,
      proposal,
      kind,
      verb,
      ...splitTarget(rest),
      verdict,
      outcome: outcomeOf(mode, verdict),
      detail,
    };
    if (mode === "shadow") {
      records.push(record);
      continue;
    }
    const key = `${producer} ${proposal}`;
    const at = applies.get(key);
    if (at !== undefined) records[at] = record;
    else {
      applies.set(key, records.length);
      records.push(record);
    }
  }
  return { records, notes };
}

/**
 * How a READER groups the records — finer than {@link PassRecordOutcome} in exactly one place, and
 * for one reason: an `error` means two different things depending on which half of the pass wrote
 * it. An apply that broke was a real write, rolled back; a shadow that broke never attempted one, so
 * telling a founder their board "could not apply" it — a write that may have been rolled back —
 * describes an event that never happened.
 */
export type PassRecordGroup = Exclude<PassRecordOutcome, "error"> | "apply-failed" | "shadow-failed";

export function passRecordGroup(record: PassRecord): PassRecordGroup {
  if (record.outcome !== "error") return record.outcome;
  return record.mode === "apply" ? "apply-failed" : "shadow-failed";
}

/** How many proposals landed in each group — the counts the record leads with. */
export function passRecordCounts(summary: PassRecordSummary): Record<PassRecordGroup, number> {
  const counts: Record<PassRecordGroup, number> = {
    applied: 0,
    unsettled: 0,
    stranded: 0,
    shadowed: 0,
    refused: 0,
    unrecorded: 0,
    "apply-failed": 0,
    "shadow-failed": 0,
  };
  for (const record of summary.records) counts[passRecordGroup(record)] += 1;
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
