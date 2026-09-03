/**
 * The auto-repair LOOP GUARD (anton-rys7 / R5.6, R5.8) — what makes auto-repair safe to leave
 * running overnight.
 *
 * A repair is anton acting on its own diagnosis of why a run blocked: a moved path rewritten, an
 * ordering nobody drew an edge for recorded. Three things have to be true before that can run
 * unattended, and none of them is about whether any individual repair is correct:
 *
 *   • THE PROJECT MUST HAVE ARMED IT. A repair is an unattended write to the founder's board, so it
 *     sits behind a per-class trust dial exactly as every other autonomous write does (R5.3) — see
 *     repair-autonomy.ts. Shipped at `shadow`: anton works the repair out and records it, and the
 *     block still goes to a human. Nothing writes to a board nobody armed.
 *
 *   • IT MUST NOT LOOP. A bead that blocks, gets repaired, and blocks the same way again is a
 *     diagnosis that did not hold. Repairing it a second time spends a night's quota re-fixing one
 *     bead. So a repair is FINGERPRINTED per (bead, class) — `repair:<class>:<hash>:<atMs>`, stamped
 *     on the bead itself — and the second identical block escalates instead (R5.6).
 *   • A WRONG DIAGNOSIS MUST COST MORE THAN NO DIAGNOSIS. A run that fails AFTER a repair is two
 *     failures stacked: the original block, and anton's confident wrong answer to it. It counts
 *     DOUBLE toward the consecutive-failure breaker (R5.8), so a repair pass that is making things
 *     worse disarms the picker sooner than an honest run of parks would.
 *
 * The fingerprint is deliberately the SAME idea proposals already run on (detections.ts): one
 * `<producer>:<claim>:<hash>` label, and its presence is the whole suppression. What is different is
 * where it lives and what it suppresses. A proposal's fingerprint sits on the PROPOSAL bead and
 * stops the patrol re-asking; a repair's sits on the REPAIRED bead and stops anton re-answering.
 *
 * That is also why the namespace is `repair:` and not `gardener:`. A `gardener:`-prefixed label on a
 * blocked ticket would make `isProposalBead` true for it — the ticket would drop out of the
 * gardener's own board-shape detection and out of the settled-proposal record, as a bead about the
 * board rather than part of it. The convention is reused; the namespace must not be.
 *
 * Pure values plus one write. Nothing here decides WHETHER a class is repairable in a given
 * situation or performs a repair — the factual repairs are anton-fzas (`ref-stale`) and anton-qg4h
 * (`dep-missing`), and both pass through {@link decideRepair} before they touch anything.
 */
import { createHash } from "node:crypto";
import { beads } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import type { FailureWeight, RunOutcome } from "../autopilot-failure-streak";
import type { ProposalAutonomy } from "./autonomy";
import { FINGERPRINT_HASH_LENGTH } from "./detections";

/**
 * The block classes anton will attempt a repair for — the factual pair (R5.4) and the inventive pair
 * (R5.5). `env` and `other` are deliberately absent: nothing anton can check makes them actionable,
 * so they escalate on their first appearance, not their second.
 *
 * A closed set, and {@link isRepairClass} is an EXACT membership test, because the guard is the last
 * thing standing between an unrecognised class and a confident repair. Anything the result parser
 * cannot name falls through to `escalate` — the same fail-closed rule R5.2a puts on the parser.
 */
export const REPAIR_CLASSES = [
  "ref-stale",
  "dep-missing",
  "acceptance-missing",
  "oversized",
] as const;

export type RepairClass = (typeof REPAIR_CLASSES)[number];

export function isRepairClass(value: string | undefined): value is RepairClass {
  return value !== undefined && (REPAIR_CLASSES as readonly string[]).includes(value);
}

/** The label prefix a repair stamp carries — see the module header for why it is not `gardener`. */
export const REPAIR_NAMESPACE = "repair";

/**
 * `repair:<class>:<hash>` — the identity of ONE repair of one bead for one class.
 *
 * The hash covers the bead as well as the class even though the label lives on that bead. It costs
 * nothing and buys two things: the label is greppable back to the pair it stands for, and it reads
 * as the same kind of fact as every proposal fingerprint on the board rather than as a bespoke flag.
 */
export function repairFingerprint(beadId: string, klass: RepairClass): string {
  const digest = createHash("sha1")
    .update(`${klass}:${beadId}`)
    .digest("hex")
    .slice(0, FINGERPRINT_HASH_LENGTH);
  return `${REPAIR_NAMESPACE}:${klass}:${digest}`;
}

/**
 * The label as it is written: the fingerprint plus WHEN the repair was made.
 *
 * The timestamp is not decoration. The breaker weighs a failed run double only when the repair
 * PRECEDED it ({@link repairedFailureWeight}) — without an instant to order against, the block that
 * triggered the repair would count double too, and a threshold of 3 would trip on one honest park
 * plus one failed repair. Multi-segment by the same precedent `run-lease:<expiry>[:<owner>]` sets.
 */
export function repairLabel(beadId: string, klass: RepairClass, atMs: number): string {
  return `${repairFingerprint(beadId, klass)}:${Math.floor(atMs)}`;
}

/** A repair stamp's exact shape, so no unrelated `repair`-ish label is ever read as one. */
const REPAIR_LABEL = new RegExp(
  `^${REPAIR_NAMESPACE}:([a-z-]+):([0-9a-f]{${FINGERPRINT_HASH_LENGTH}}):(\\d+)$`,
);

/** One repair anton already made on a bead, as the board remembers it. */
export interface RepairAttempt {
  klass: RepairClass;
  /** `repair:<class>:<hash>` — the identity, without the instant. */
  fingerprint: string;
  /** Unix MILLISECONDS the repair was stamped. */
  at: number;
  /**
   * What the repair actually did, recovered from the bead's note. Undefined when the note was
   * edited away or predates the note format — the stamp still counts, because the LABEL is the
   * suppression and the prose is only how the escalation explains itself.
   */
  attempted?: string;
}

/**
 * The note a repair leaves beside its stamp — one machine line on the bead's append-only blob.
 *
 * Two records of one act, and they are not redundant. The LABEL is the suppression: it is what a
 * board read sees, what survives a description rewrite, and what the breaker weighs against. The
 * NOTE is the reasoning: it is what the escalation quotes back when the repair turns out not to
 * have helped, and what a human reads on the bead without opening a session log.
 *
 * The fingerprint leads so the tail can be free prose — flattened and capped, because a machine note
 * is one line by construction (beads/notes.ts) and a multi-line reason would parse back as several
 * notes with no attribution at all.
 */
export function repairNote(fingerprint: string, attempted: string): string {
  return `anton: repaired \`${fingerprint}\` — ${oneLine(attempted)}`;
}

/** How much of a repair's reasoning one note may carry — enough to judge from, bounded. */
const REPAIR_NOTE_CHARS = 400;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REPAIR_NOTE_CHARS ? `${flat.slice(0, REPAIR_NOTE_CHARS).trimEnd()}…` : flat;
}

/**
 * The note anton leaves when it REFUSED a repair — the other half of the record {@link recordRepair}
 * writes for one it made.
 *
 * A block that escalates already parks the run for a human; what they arrive to without this is a
 * bead that says the agent stopped and nothing about what anton checked before handing it over. One
 * line and one cap, shared by every repair class, because the notes blob is line-delimited
 * (beads/notes.ts) and a class-specific formatter is how two refusals start reading differently.
 */
export function refusalNote(
  klass: RepairClass,
  refusal: { why: string; evidence: readonly string[] },
): string {
  return `anton: did not repair this as \`${klass}\` — ${oneLine([refusal.why, ...refusal.evidence].join(" "))}`;
}

/**
 * The note anton leaves when a class is armed at `shadow` — the repair it WITHHELD, in the same
 * words the armed one would have recorded.
 *
 * Deliberately NOT {@link repairNote}: that one carries the fingerprint, and the fingerprint is the
 * loop guard's suppression. A shadow writes no stamp (nothing happened to the bead, so nothing may
 * stop a later armed repair from happening), which means it must not write a note that reads like
 * one either — a bead whose blob claimed a repair the labels never recorded is the one way this
 * record could lie.
 */
export function shadowNote(klass: RepairClass, attempted: string): string {
  return (
    `anton: did not repair this as \`${klass}\` — it is armed at \`shadow\`, which works the repair ` +
    `out and writes nothing. What \`apply\` would have recorded: "${oneLine(attempted)}"`
  );
}

const REPAIR_NOTE = new RegExp(
  `^anton: repaired \`(${REPAIR_NAMESPACE}:[a-z-]+:[0-9a-f]{${FINGERPRINT_HASH_LENGTH}})\` — (.+)$`,
);

/** What a repair wrote, by fingerprint — the prose half of the record. */
function attemptedByFingerprint(notes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const note of parseTicketNotes(notes)) {
    if (note.source !== "system") continue;
    const m = REPAIR_NOTE.exec(note.text);
    // Last write wins: the blob is append-only, so a re-stamp appends rather than replaces.
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** What the guard reads a bead as — structural, so this module stays free of the bd seam. */
export interface RepairedBead {
  id: string;
  labels?: string[];
  /** The append-only notes blob, when the read carried it (`bd show`). */
  notes?: unknown;
}

/**
 * Every repair recorded on this bead, oldest first.
 *
 * Reads LABELS, not notes: the label is the record that survives everything a person or a later
 * anton might do to the bead's prose, and the guard has to be right on a bead whose blob was
 * rewritten. The note is folded in where it is still there, for the escalation to quote.
 */
export function repairAttemptsOf(bead: RepairedBead): RepairAttempt[] {
  const attempted = attemptedByFingerprint(bead.notes);
  const out: RepairAttempt[] = [];
  for (const label of bead.labels ?? []) {
    const m = REPAIR_LABEL.exec(label);
    if (!m) continue;
    const klass = m[1]!;
    if (!isRepairClass(klass)) continue;
    const fingerprint = `${REPAIR_NAMESPACE}:${klass}:${m[2]!}`;
    const prose = attempted.get(fingerprint);
    out.push({
      klass,
      fingerprint,
      at: Number(m[3]!),
      ...(prose ? { attempted: prose } : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The repair anton already made on this bead for this class, or undefined. The NEWEST wins: a bead
 * carrying two stamps of one class is a board that was hand-edited or written twice, and the later
 * attempt is the one whose failure is being judged.
 */
export function priorRepair(bead: RepairedBead, klass: RepairClass): RepairAttempt | undefined {
  return repairAttemptsOf(bead)
    .filter((a) => a.klass === klass)
    .at(-1);
}

export type RepairDecision =
  /** Armed: compute the fix and WRITE it. */
  | { action: "repair"; klass: RepairClass; fingerprint: string }
  /** Armed at `shadow`: compute the fix, record what it would have been, write nothing. */
  | { action: "shadow"; klass: RepairClass; fingerprint: string }
  | {
      action: "escalate";
      /** One line: why this block is not being repaired. The escalation's `reason`. */
      why: string;
      /** The case, one fact per line — what was attempted, and why it did not help. */
      evidence: string[];
      /** The repair that already ran, when the escalation is a second identical block. */
      prior?: RepairAttempt;
    };

/**
 * May anton repair this block, and how far may it go? The one gate every repair passes through.
 *
 * THREE checks, in this order, and escalating is the default at every one of them. An unrecognised
 * class is escalated because the guard cannot know what a repair for it would even mean (R5.2a). A
 * SECOND block of a class anton already repaired is escalated because the repair is the thing that
 * has been disproved — the bead did not get better, and the next-cheapest correct action is a human
 * reading it (R5.6). And a class this project has not ARMED is escalated because a repair is an
 * unattended write to the founder's board (R5.3): the loop guard bounds how OFTEN anton writes, and
 * only the autonomy level decides WHETHER it may.
 *
 * The autonomy check sits beside the loop guard rather than at the write, so every repair passes
 * both or neither — including `shadow`, which is not exempt from the guard: re-describing a repair
 * that has already been disproved is the same wrong answer with the writes taken out.
 */
export function decideRepair(
  bead: RepairedBead,
  klass: string | undefined,
  block: { reason?: string },
  /** How far this project lets anton go with this class — see gardener/repair-autonomy.ts. */
  autonomy: ProposalAutonomy,
): RepairDecision {
  if (!isRepairClass(klass)) {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as ${klass ? `\`${klass}\`` : "an unclassified block"}, which anton does ` +
        `not repair — it needs a human.`,
      evidence: [blockLine(block)],
    };
  }
  const prior = priorRepair(bead, klass);
  if (!prior) {
    if (autonomy === "propose") {
      return {
        action: "escalate",
        why:
          `${bead.id} blocked as \`${klass}\`, and anton is not armed to repair that on this ` +
          `project — it needs a human.`,
        evidence: [
          blockLine(block),
          `\`${klass}\` repair is set to \`propose\` here, so anton wrote nothing to the board; ` +
            `arm it at \`shadow\` to see what it would do, or at \`apply\` to let it run`,
        ],
      };
    }
    const fingerprint = repairFingerprint(bead.id, klass);
    return { action: autonomy === "apply" ? "repair" : "shadow", klass, fingerprint };
  }
  return {
    action: "escalate",
    why:
      `${bead.id} blocked as \`${klass}\` again after anton already repaired it for that class — ` +
      `the repair did not hold, so repairing it a second time would only spend another run.`,
    evidence: [
      `anton repaired ${bead.id} for \`${klass}\` at ${new Date(prior.at).toISOString()}: ` +
        (prior.attempted ?? "(what it did was not recorded on the bead)"),
      blockLine(block),
      `\`${prior.fingerprint}\` is stamped on ${bead.id}, so no further \`${klass}\` repair will run ` +
        `on it — this needs a human.`,
    ],
    prior,
  };
}

/** The block's own words, or the honest absence of them. */
function blockLine(block: { reason?: string }): string {
  const reason = block.reason?.trim();
  return reason
    ? `it blocked again with: ${oneLine(reason)}`
    : `it blocked again, with no reason given`;
}

/**
 * Stamp the repair on the bead — the label first, then the note.
 *
 * The ORDER is the safety property. The label is the suppression: if the process dies between the
 * two writes, the bead is left carrying a repair anton will not repeat, and the escalation that
 * follows a second block says the reasoning was not recorded rather than offering a second repair.
 * Writing the prose first would leave the opposite gap — a bead with a story and no guard.
 *
 * Which is exactly why the note is BEST-EFFORT once the stamp lands (PR #223 review). A stamped
 * repair has happened: rejecting here over the prose would hand the caller a failed outcome it then
 * rolls back — `dep-missing` removes the edge it just drew, `ref-stale` leaves the corrected bead
 * blocked — while the suppression label stays durable and refuses every later attempt as a repair
 * already made. The same half-written bead the crash leaves, but reached deliberately. The failure
 * is logged and the label returned; the escalation that follows a second block already knows how to
 * say the reasoning was not recorded.
 */
export async function recordRepair(
  repoPath: string,
  bead: RepairedBead,
  klass: RepairClass,
  attempted: string,
  atMs: number,
): Promise<string> {
  const label = repairLabel(bead.id, klass, atMs);
  await beads.tag(repoPath, bead.id, [label]);
  try {
    await beads.note(repoPath, bead.id, repairNote(repairFingerprint(bead.id, klass), attempted));
  } catch (e) {
    console.error(`[repair] ${bead.id} stamped \`${label}\` but its note could not be written`, e);
  }
  return label;
}

/**
 * What a failed run weighs when a repair preceded it (R5.8). Two, and the second one is anton's.
 *
 * Double rather than some tuned number because that is exactly what the run IS: the block anton was
 * asked to fix, plus the confident wrong answer it gave. A pass that is repairing badly therefore
 * reaches the breaker's threshold in half the runs an honest streak of parks would take, which is
 * the whole point — a wrong diagnosis has to cost more than no diagnosis.
 */
export const FAILED_REPAIR_WEIGHT = 2;

/**
 * The breaker's weighing hook, built from the board the pass already read.
 *
 * A failed run counts double when the work it carried — the run target or the ticket it stopped
 * inside — carries a repair stamped BEFORE the run's ATTEMPT began. All three of those matter:
 *
 *   • Before, so the block that PROVOKED the repair is not counted as its failure. It was an honest
 *     park; the repair had not happened yet.
 *   • The ticket as well as the target, because a repair acts on the bead that blocked, and inside a
 *     grouped run that is a child, not the epic the run row names.
 *   • The ATTEMPT rather than the row, because a `dep-missing` repair parks the run behind the edge
 *     it drew and the blocker-completion resume reuses that same row (PR #223 review). Ordered
 *     against the row's original start, the resumed attempt's failure would fall BEFORE the repair
 *     that provoked the park and weigh 1 — defeating the rule for the whole prerequisite path. The
 *     run's `startedAt` is therefore the attempt's start, rewritten on resume (jobs/runs.ts).
 *
 * The stamp is read per BEAD, not per (bead, class): any repair that preceded the attempt makes the
 * failure count double, even one for a different class. Deliberate, and the conservative reading of
 * R5.8 — a repair that left the bead failing for some other reason did not unblock it either, and
 * pricing that by class would need the run row to record which class the failure was, which it does
 * not. The EARLIEST stamp per bead is the one compared, since the question is only whether any
 * repair preceded the attempt.
 *
 * A run with no recorded start is weighed plainly. Nothing can be ordered against it, and the fence
 * goes to the cheaper error: one more failure before the breaker fires, rather than a double weight
 * on a run that may well have predated the repair.
 *
 * The two instants are not the same PRECISION — the run's start is stored whole-second, the repair
 * stamp keeps milliseconds — so a repair inside the run's own start second cannot be ordered against
 * it at all, and it is weighed by the same fence: the repair must be strictly earlier than the
 * EARLIEST instant the attempt could have started (PR #223 review). Rounding the repair down and
 * accepting a tie instead put the ambiguous second on the expensive side, where the block that
 * provoked the repair could count as its failure.
 */
export function repairedFailureWeight(board: readonly RepairedBead[]): FailureWeight {
  const repairedAt = new Map<string, number>();
  for (const bead of board) {
    for (const attempt of repairAttemptsOf(bead)) {
      const earliest = repairedAt.get(bead.id);
      if (earliest === undefined || attempt.at < earliest) repairedAt.set(bead.id, attempt.at);
    }
  }
  if (repairedAt.size === 0) return () => 1;
  return (run: RunOutcome): number => {
    const startedAt = run.startedAt;
    if (startedAt === undefined) return 1;
    const followsRepair = [run.epicBeadId, run.ticketBeadId].some((id) => {
      const at = id === undefined ? undefined : repairedAt.get(id);
      // `startedAt` is whole-second, so the attempt began somewhere in [startedAt, startedAt + 1).
      // Only a repair stamped before that window is ordered before the attempt beyond doubt.
      return at !== undefined && at < startedAt * 1000;
    });
    return followsRepair ? FAILED_REPAIR_WEIGHT : 1;
  };
}
