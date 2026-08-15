/**
 * ARMED MODE (anton-4ab3): the pass APPLIES what it just filed, for the kinds an operator armed —
 * the shadow walk (shadow.ts) one branch further, where the branch is a board write.
 *
 * It calls {@link applyProposal}, the same function the approve route calls, and reimplements none
 * of it: the fresh-board re-checks, the write locks, the evidence fence and the rollback are that
 * module's, and an armed pass that re-derived any of them would be a second answer to "may this
 * move" that agrees until the day it doesn't. What lives HERE is only what an unattended write needs
 * and an approve does not:
 *
 *   • A WRITE CAP ({@link MAX_APPLIES_PER_PASS}), which is a different budget from the one that
 *     bounds emission. The overflow is not deferred work and no later pass picks it up: the
 *     proposal is already on the board, so the fingerprint suppression that stops it being re-filed
 *     also stops it being re-decided — and this walk only ever visits what its own pass just filed.
 *     It stays open as an ordinary ask, logged by count and by id, waiting for a human approval.
 *     Hitting the cap is the signal that this board wants somebody to look at it.
 *   • AN ACTOR. Every apply here is made with nobody watching, so it is recorded as `policy` and the
 *     proposal's closing note says so (see apply.ts `ApplyActor`).
 *
 * Total over its proposals, like the shadow walk: a refusal is the board declining and leaves the
 * ask open with the reason already noted on it, an error is anton failing to decide, and NEITHER
 * costs the pass the proposals behind it. A patrol that could not apply its second ask must still
 * apply its third — the alternative is one unlucky bead freezing the whole armed path.
 *
 * Shared by both producers on purpose (gardener-proposals.ts, product-master-steps.ts): a
 * per-producer copy would be two answers to "how much may a pass write, and how does it say so".
 */
import { loadAllIssues } from "../beads/issues";
import { applyProposal, ProposalApplyError } from "./apply";
import { autonomyFor, type ProposalAutonomyPolicy } from "./autonomy";
import {
  planOf,
  type GardenerDetectionKind,
  type GardenerMove,
  type GardenerPlan,
  type RetireVerb,
} from "./detections";
import { MAX_APPLIES_PER_PASS, type EmittedProposal } from "./emit";
import { passRecordLine, type ApplyVerdict } from "./record";

/** What the pass did with one armed proposal — `error` is anton failing, never the board refusing. */
export type ArmedOutcome = "applied" | "refused" | "error";

/**
 * One armed proposal's outcome, as data — the same shape the shadow record carries, so the two read
 * alike in one log: the whole ask, and apply's own words for what happened to it.
 */
export interface ArmedRecord {
  /** The proposal bead this pass just filed. */
  proposal: string;
  kind: GardenerDetectionKind;
  move: GardenerMove;
  /** Which retirement a `retire` move ran — the verb that decides what the move COST. */
  retireAs?: RetireVerb;
  subjects: string[];
  /** The move's counterpart: the new parent, the blocker, the replacement. */
  target?: string;
  outcome: ArmedOutcome;
  /** The apply's summary, or its refusal/failure reason VERBATIM. */
  detail: string;
  /** The beads the write actually touched. Empty for a refusal, and for an already-applied board. */
  changed: string[];
}

export interface ArmedResult {
  records: ArmedRecord[];
  /**
   * How much of the write cap this call spent — what a SECOND call in the same pass has to subtract.
   * The product-master pass files two tiers through one filer, and the cap is per pass, not per tier.
   */
  attempted: number;
  /**
   * Armed proposals this call did not apply — held back by the cap, or left untried because the
   * record could no longer be written. Still open, and still ordinary asks.
   */
  deferred: string[];
}

export interface ArmedInput {
  repo: string;
  /** What the pass just filed — applied in the order it was filed. */
  created: EmittedProposal[];
  policy: ProposalAutonomyPolicy;
  /** The producer's log prefix, e.g. `[gardener]`. */
  producer: string;
  /** Where the record lands. The session log, so the jobs page shows it with no new surface. */
  log: (chunk: string) => Promise<void>;
  /** Propagate the board writes — an unattended move nobody else can see is half a move. */
  nudge: () => void;
  signal?: AbortSignal;
  /** What is left of the pass's write cap. Defaults to a full {@link MAX_APPLIES_PER_PASS}. */
  limit?: number;
}

/** Nothing armed, or nothing left to do — a fresh value each time, never a shared array. */
const nothing = (): ArmedResult => ({ records: [], attempted: 0, deferred: [] });

/** The proposals this policy has ARMED — the manual-move floor already applied by `autonomyFor`. */
function armed(
  created: EmittedProposal[],
  policy: ProposalAutonomyPolicy,
): Array<{ proposal: EmittedProposal; plan: GardenerPlan }> {
  return created.flatMap((proposal) => {
    const plan = planOf(proposal.detection);
    return autonomyFor(plan.kind, plan, policy) === "apply" ? [{ proposal, plan }] : [];
  });
}

/**
 * Apply what this pass filed, for the kinds armed at `apply`. Never throws — an armed proposal that
 * cannot be applied is a line in the log and an ask still standing on the board.
 *
 * The cap counts ATTEMPTS, not successful writes: it bounds how much unattended work one pass does,
 * and a pass that refused ten in a row has still spent ten applies' worth of board reads and locks.
 */
export async function applyArmedProposals(input: ArmedInput): Promise<ArmedResult> {
  const targets = armed(input.created, input.policy);
  if (targets.length === 0 || input.signal?.aborted) return nothing();

  const limit = Math.max(0, input.limit ?? MAX_APPLIES_PER_PASS);
  const held = targets.slice(limit).map(({ proposal }) => proposal.id);
  // Never a silent cap. An operator who armed a kind and finds three beads moved has to be able to
  // tell "that was all of it" from "we stopped at three" — by count AND by id, so the asks the cap
  // held back are answerable without diffing the board against the log.
  if (held.length > 0) {
    // The cap is named as the PASS's, never as this call's remaining budget alone: the
    // product-master pass spends one budget across two tiers, and "applies at most 0" would read as
    // a broken setting rather than as a pass that had already spent its writes. What an earlier
    // tier spent is named ALONGSIDE it, so "held back 4 — one pass applies at most 3" never reads
    // as a cap that should have let a fourth through.
    const spent = MAX_APPLIES_PER_PASS - limit;
    await write(
      input,
      `APPLY held back ${held.length} armed proposal(s) — one pass applies at most ` +
        `${MAX_APPLIES_PER_PASS}` +
        (spent > 0 ? `, and ${spent} of those were already spent earlier in this pass` : "") +
        `; they stay open as ordinary asks (${held.join(", ")})`,
    );
  }

  const records: ArmedRecord[] = [];
  const attempts = targets.slice(0, limit);
  for (const [i, { proposal, plan }] of attempts.entries()) {
    // Between every apply, not once up front: each one is a board write, and a cancel arriving
    // mid-loop has to stop the rest rather than let a cancelled pass finish every armed move.
    if (input.signal?.aborted) break;
    const record = await applyOne(input, proposal.id, plan);
    records.push(record);
    if (await write(input, lineOf(record))) continue;

    // The record IS the accounting: a retry of this job reconstructs what earlier attempts spent
    // from these very lines (jobs/pass-budget.ts), so a write that fails leaves an unattended board
    // write nothing can see. The pass stops applying at that point rather than spending more of a
    // cap it can no longer count — one unaccounted write is the bound, not a whole fresh allowance.
    const untried = attempts.slice(i + 1).map((target) => target.proposal.id);
    held.push(...untried);
    console.error(
      `${input.producer} stopped applying — the record for ${proposal.id} could not be written, so ` +
        `this pass can no longer account for what it spends` +
        (untried.length > 0
          ? `; ${untried.length} armed proposal(s) stay open as ordinary asks (${untried.join(", ")})`
          : ""),
    );
    break;
  }

  if (records.length > 0) {
    // Once, on the way out, whatever the outcomes were: a REFUSAL writes too (apply attaches its
    // reason to the proposal), and the nudge coalesces per repo — so a pass that happened to write
    // nothing costs a no-op push, while one that moved a bead never leaves it on this machine alone.
    input.nudge();
    console.log(`${input.producer} ${summaryOf(records)}`);
  }
  return { records, attempted: records.length, deferred: held };
}

/**
 * Say that proposals a pass FILED will never be settled: emission failed part-way, so neither the
 * shadow nor the armed walk ran over them, and no later pass picks them up — the fingerprint that
 * stops a filed claim being re-filed also stops it being re-decided.
 *
 * The pass writes nothing for them on purpose. Its board writes are already failing, and applying
 * unattended out of a failure path is the last moment to start trusting them; leaving the asks open
 * for a human is the safe direction. What is NOT safe is doing it silently — an operator who armed a
 * kind and finds an untouched bead has to be able to tell "the policy refused it" from "the policy
 * never got to it". Shaped as a pass note (no `(kind)` group), so the jobs-page record carries it
 * instead of calling the pass clean.
 */
export async function reportUnsettledProposals(input: {
  created: EmittedProposal[];
  producer: string;
  log: (chunk: string) => Promise<void>;
}): Promise<void> {
  if (input.created.length === 0) return;
  const ids = input.created.map((p) => p.id);
  const line =
    `APPLY skipped for ${ids.length} filed proposal(s) — this pass failed part-way through ` +
    `filing, so neither the shadow nor the armed walk reached them; they stay open as ordinary ` +
    `asks and no later pass re-decides them (${ids.join(", ")})`;
  console.warn(`${input.producer} ${line}`);
  await write(input, line);
}

/**
 * One proposal, applied against a board read FRESH for it — as the approve route reads one per
 * approval, and for a reason a shared snapshot could not answer: an earlier apply in this same loop
 * may have moved a bead this one rests on.
 *
 * Total. A {@link ProposalApplyError} is the board's answer or a rolled-back write, and anything
 * else is a bd that broke; both leave the proposal open with the reason on it, and neither stops the
 * loop.
 */
async function applyOne(
  input: ArmedInput,
  proposalId: string,
  plan: GardenerPlan,
): Promise<ArmedRecord> {
  const base = {
    proposal: proposalId,
    kind: plan.kind,
    move: plan.move,
    ...(plan.retireAs ? { retireAs: plan.retireAs } : {}),
    subjects: plan.subjects,
    ...(plan.target ? { target: plan.target } : {}),
    changed: [] as string[],
  };
  try {
    const board = await loadAllIssues(input.repo);
    const proposal = board.find((b) => b.id === proposalId);
    if (!proposal) {
      // Filed minutes ago and already gone: another machine's patrol withdrew it as a duplicate, or
      // a human declined it. Either way the ask has been answered by someone else and is not ours.
      return { ...base, outcome: "error", detail: "it is no longer on the board — nothing was applied" };
    }
    const applied = await applyProposal(input.repo, proposal, board, "policy");
    return { ...base, outcome: "applied", detail: applied.summary, changed: applied.changed };
  } catch (e) {
    // `refused`/`unusable` are the board declining — the ordinary outcome for an ask whose premise
    // moved. `failed` is a write that broke and was rolled back, which is anton's failure, not a
    // verdict, and reads as one in the log.
    const refused = e instanceof ProposalApplyError && e.failure !== "failed";
    return { ...base, outcome: refused ? "refused" : "error", detail: messageOf(e) };
  }
}

/** Typed through record.ts's vocabulary, so a reworded verdict is a type error, not a silent one. */
const VERDICT: Record<ArmedOutcome, ApplyVerdict> = {
  applied: "APPLIED",
  refused: "REFUSED",
  error: "COULD NOT APPLY",
};

/** One line per proposal, shaped like the shadow's so a mixed pass reads as one list. */
function lineOf(record: ArmedRecord): string {
  return passRecordLine({ mode: "apply", ...record, verdict: VERDICT[record.outcome] });
}

/**
 * The console line an operator greps the morning after a 03:00 pass.
 *
 * "applied 0" is left OUT rather than written as a zero: a pass whose asks the board all refused is
 * the armed path working, and leading with "applied 0 proposal(s) unattended" reads at a glance like
 * a setting that failed to take. There is always at least one clause — the caller only summarises a
 * pass that attempted something.
 */
function summaryOf(records: ArmedRecord[]): string {
  const of = (outcome: ArmedOutcome) => records.filter((r) => r.outcome === outcome);
  const applied = of("applied");
  const clauses = [
    applied.length > 0
      ? `applied ${applied.length} proposal(s) unattended ` +
        `(${applied.map((r) => r.proposal).join(", ")})`
      : undefined,
    of("refused").length > 0 ? `${of("refused").length} refused` : undefined,
    of("error").length > 0 ? `${of("error").length} could not be applied` : undefined,
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.join(", ");
}

/**
 * Best-effort, like the shadow's: a session log that will not take a write must not fail the pass —
 * but it is never silent either, or a broken log store reads as a pass that applied nothing.
 *
 * Reports whether the line landed, because for an apply that answer is not cosmetic: it is whether
 * the spend was recorded at all (see the loop above).
 */
async function write(
  input: Pick<ArmedInput, "producer" | "log">,
  line: string,
): Promise<boolean> {
  return input.log(`${input.producer} ${line}\n`).then(
    () => true,
    (e) => {
      console.warn(`${input.producer} could not record an apply — ${messageOf(e)}: ${line}`);
      return false;
    },
  );
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
