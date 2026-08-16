/**
 * What is LEFT of a pass's unattended write cap, given the attempts of the same job that ran before
 * it (anton-4ab3 / anton-zy7f).
 *
 * The cap ({@link MAX_APPLIES_PER_PASS}) bounds what one PASS may do to the board with nobody
 * watching — and a pass is a job, not an attempt. A pass that applied three proposals and then died
 * in the judgment tier is retried by the runner under the same job id; handing that retry a fresh
 * cap would let one scheduled pass apply three more, and an operator who armed a kind would find six
 * beads moved by a cap that says three.
 *
 * Reconstructed rather than persisted, for the reason the record itself is (gardener/record.ts): the
 * log IS the account of what a pass did, so a second store would be a second answer to "how much has
 * this job written" — agreeing until the day one of them is not updated. Every attempted apply is one
 * APPLY record — reserved before the board is touched and superseded by its outcome afterwards, which
 * the reader collapses back into one — and that is what the cap counts.
 *
 * Fails CLOSED, and on the same evidence either way. An attempt whose log will not read spent an
 * unknown amount, so this attempt applies nothing — the safe direction for a write nobody is
 * watching, and it says so rather than quietly arming. A MISSING log is that same answer, not a
 * quiet attempt: a pass opens its log with its session row (jobs/pass-preamble.ts), so a row with no
 * log behind it is a log store that broke, which is exactly when an apply's record goes unwritten.
 * An attempt that genuinely had nothing to say opened no row at all and is not read here.
 *
 * That unreadable log may be THIS attempt's own — a pass that opens its session up front
 * (product-master) is already in the read by the time this runs — and the answer does not change: a
 * log store broken now is one this attempt could not have accounted its own writes against either.
 * Only the note has to stay honest about whose log it is, and it names neither.
 *
 * A partial log — created, then failing mid-append — cannot cost this an apply it should have
 * counted, because the producer buys each write with its record BEFORE making it and stops the
 * moment one will not write (gardener/armed.ts): a line that never landed is an apply that never
 * happened. The residue runs the other way, and safely — a reserved line whose apply then died
 * mid-flight is counted as spent, which is what a cap on ATTEMPTS means.
 */
import { MAX_APPLIES_PER_PASS } from "../gardener/emit";
import { isPassLogLine, readPassRecords } from "../gardener/record";
import { jobSessionLogPaths, readSessionLogLines } from "../sessions";
import type { AntonDb } from "./queue";

export interface ApplyBudgetInput {
  db: AntonDb;
  /** The queue job this pass is an attempt of — the unit the cap belongs to. */
  jobId: string;
  /** The producer's log prefix, e.g. `[gardener]`. */
  producer: string;
  /** Where the note lands, when there is one: the pass's session log, as every record line does. */
  log: (chunk: string) => Promise<void>;
}

/**
 * How much of the cap this pass may still spend. Call it ONCE, before the pass applies anything:
 * every earlier attempt's log is complete by then, and this attempt's own — present already for a
 * pass that opens its session up front — is still empty, so it counts as the zero it is.
 */
export async function remainingApplyBudget(input: ApplyBudgetInput): Promise<number> {
  const paths = await jobSessionLogPaths(input.db, input.jobId);
  if (paths.length === 0) return MAX_APPLIES_PER_PASS;

  const spends = await Promise.all(paths.map(attemptSpend));
  if (spends.some((spend) => spend === undefined)) {
    await note(
      input,
      `a session log of this job could not be read — this attempt's own included, since a pass ` +
        `opens its log with its session row — so what has been applied unattended under it is ` +
        `unknown; this attempt applies nothing and every armed proposal it files stays open as an ` +
        `ordinary ask`,
    );
    return 0;
  }

  const spent = spends.reduce((total: number, spend) => total + (spend ?? 0), 0);
  if (spent === 0) return MAX_APPLIES_PER_PASS;
  const remaining = Math.max(0, MAX_APPLIES_PER_PASS - spent);
  // Never a silent cap, exactly as the per-pass hold-back is not one: an operator looking at a
  // retry that applied one proposal has to be able to tell "that was all it found" from "its
  // earlier attempt had already spent the rest".
  //
  // Spelled as ATTEMPTS, because that is what was counted: a refusal and a write that broke cost
  // the cap the same as a bead that moved, so a note claiming this many proposals were APPLIED
  // would send an operator hunting board moves a refused attempt never made. What actually landed
  // is a per-proposal question, and the record answers it verdict by verdict.
  await note(
    input,
    `earlier attempt(s) of this job already spent ${spent} of the unattended write budget on ` +
      `apply attempts — the cap counts attempts, so some may have been refused or have failed ` +
      `rather than moved the board; this job's record carries each one's verdict — one pass ` +
      `applies at most ${MAX_APPLIES_PER_PASS}, so this attempt may apply ${remaining}`,
  );
  return remaining;
}

/** One attempt's spend, or `undefined` when its log cannot say — a missing log included. */
async function attemptSpend(logPath: string): Promise<number | undefined> {
  const { lines, unreadable } = await readSessionLogLines(logPath, isPassLogLine);
  if (unreadable) return undefined;
  const { records } = readPassRecords(lines.join("\n"));
  return records.filter((record) => record.mode === "apply").length;
}

/** Shaped as a pass note (an `APPLY` line with no `(kind)` group), so the jobs page carries it. */
async function note(input: ApplyBudgetInput, line: string): Promise<void> {
  await input.log(`${input.producer} APPLY budget: ${line}\n`).catch((e) => {
    console.warn(`${input.producer} could not record the write budget: ${line}`, e);
  });
}
