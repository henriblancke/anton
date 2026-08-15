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
 *   • A PULL BEFORE EVERY APPLY, and a stop when it fails. The pass pulled once before it read
 *     (jobs/pass-preamble.ts), but that pull is old by the time this loop runs — a product-master
 *     pass spends its whole judgment session in between — and a board read only ever re-reads THIS
 *     checkout's working set. A subject another machine moved in that window reads as untouched
 *     here, so apply's evidence checks would authorize an unattended write against a board that has
 *     already moved on, and the nudge would publish it.
 *   • AN AWAITED PUBLISH. Every other anton write nudges propagation and returns — a human made it
 *     and can see it fail. Here the pass is the only witness, and two machines can each clear their
 *     pre-apply pull before either pushes, so the loser's push can fail on a divergence it cannot
 *     merge. The nudge still runs (it counts the backlog and enqueues the durable retry that parks
 *     for a human); what is added is an answer, so the record never reports APPLIED for a move the
 *     shared board never received.
 *   • A SPEND WRITTEN BEFORE THE WRITE IT PAYS FOR. The cap is reconstructed from these very record
 *     lines by the next attempt of the same job (jobs/pass-budget.ts), so each apply reserves its
 *     line first and records the outcome after: an attempt that cannot be written is never made, and
 *     the cap can never be spent twice by a job that dies between the board write and its record.
 *
 * Total over its proposals, like the shadow walk: a refusal is the board declining and leaves the
 * ask open with the reason already noted on it, an error is anton failing to decide, and NEITHER
 * costs the pass the proposals behind it. A patrol that could not apply its second ask must still
 * apply its third — the alternative is one unlucky bead freezing the whole armed path. A CANCEL is
 * the one thing that is not an outcome: it is the pass being stopped, so it is re-thrown rather than
 * returned, and re-checked after every await that precedes a write.
 *
 * Shared by both producers on purpose (gardener-proposals.ts, product-master-steps.ts): a
 * per-producer copy would be two answers to "how much may a pass write, and how does it say so".
 */
import { beads } from "../beads/bd";
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
 * Apply what this pass filed, for the kinds armed at `apply`. Throws for exactly one reason — the
 * pass was CANCELLED (see the checks below) — and for no other: an armed proposal that cannot be
 * applied is a line in the log and an ask still standing on the board.
 *
 * The cap counts ATTEMPTS, not successful writes: it bounds how much unattended work one pass does,
 * and a pass that refused ten in a row has still spent ten applies' worth of board reads and locks.
 */
export async function applyArmedProposals(input: ArmedInput): Promise<ArmedResult> {
  // A cancel PROPAGATES, here and at every check below — it is never a normal return. The runner
  // reads a handler that resolves as a pass that finished (jobs/runner.ts), and no later pass
  // revisits these proposals: they are already on the board, so the fingerprint suppression that
  // stops them being re-filed also stops them being re-decided. A cancelled walk that resolved
  // would publish that as a clean pass over asks nothing will ever settle. Emission stops the same
  // way, for the same reason (emit.ts `PartialEmissionError`).
  input.signal?.throwIfAborted();
  const targets = armed(input.created, input.policy);
  if (targets.length === 0) return nothing();

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
  /**
   * Stop applying, saying WHY and naming what is left standing — the cap's other silent failure.
   * The console always gets it; the line is RETURNED so a caller whose log is still healthy can put
   * it on the record too (the one below cannot — writing the record is what failed).
   */
  const stop = (why: string, untried: Array<{ proposal: EmittedProposal }>): string => {
    const ids = untried.map((target) => target.proposal.id);
    held.push(...ids);
    const line =
      `APPLY stopped — ${why}` +
      (ids.length > 0
        ? `; ${ids.length} armed proposal(s) stay open as ordinary asks (${ids.join(", ")})`
        : "");
    console.error(`${input.producer} ${line}`);
    return line;
  };

  /**
   * Publish what the walk DID write, whichever way it ended, and say so when it did not land. A
   * cancelled walk owes this as much as a finished one: the applies behind the cancel are real board
   * writes, and one no other machine can see is half a write.
   *
   * AWAITED, unlike every other propagation anton nudges (beads/sync-nudge.ts). Those follow a write
   * a human just made and is watching; these were made with nobody there, and this record is the
   * only place they are ever seen. Two machines can each finish their pre-apply pull before either
   * publishes — the bead locks serialize within ONE process — so the loser's push can fail on a
   * conflict it cannot merge, and a walk that only fired the nudge would report APPLIED for a move
   * the shared board never received. The nudge still runs first: it is what counts the write into
   * the unpushed backlog and enqueues the durable retry that parks for a human on exhaustion. This
   * only adds the answer an unattended pass cannot get from a fire-and-forget call.
   */
  const publish = async (): Promise<void> => {
    if (records.length === 0) return;
    // Once, on the way out, whatever the outcomes were: a REFUSAL writes too (apply attaches its
    // reason to the proposal), and the nudge coalesces per repo — so a pass that happened to write
    // nothing costs a no-op push, while one that moved a bead never leaves it on this machine alone.
    input.nudge();
    console.log(`${input.producer} ${summaryOf(records)}`);
    const unpublished = await pushFailure(input.repo);
    if (!unpublished) return;
    // The record's own correction, in the one place a founder reads the pass: what is written above
    // as APPLIED happened HERE and has not reached the shared board. Shaped as a pass note (no
    // `(kind)` group), so it lands beside the counts rather than as a seventh proposal (record.ts).
    const applied = records.filter((r) => r.outcome === "applied").map((r) => r.proposal);
    await write(
      input,
      `APPLY could not publish this pass's board writes — ` +
        (applied.length > 0
          ? `the ${applied.length} move(s) recorded above (${applied.join(", ")}) are on this ` +
            `machine only`
          : `what this pass wrote is on this machine only`) +
        ` until the sync retry lands them, and another machine's board does not yet show them ` +
        `— ${unpublished}`,
    );
  };

  /** Cancelled mid-walk: name what stays open, publish what landed, and propagate the abort. */
  const cancelled = async (
    signal: AbortSignal,
    untried: Array<{ proposal: EmittedProposal }>,
  ): Promise<never> => {
    await write(input, stop("the pass was cancelled", untried));
    await publish();
    throw signal.reason;
  };

  for (const [i, { proposal, plan }] of attempts.entries()) {
    // Between every apply, not once up front: each one is a board write, and a cancel arriving
    // mid-loop has to stop the rest rather than let a cancelled pass finish every armed move.
    if (input.signal?.aborted) return cancelled(input.signal, attempts.slice(i));

    // The shared board, refreshed for THIS apply — for the same reason the board read below is a
    // fresh one per proposal, one step further out: the read that follows only re-reads this
    // checkout, so a subject another machine moved since the pass's own pull reads as untouched and
    // apply's premise checks pass on evidence that is no longer true.
    //
    // Fails CLOSED, unlike the pass-level pull (jobs/pass-preamble.ts): that one costs a pass its
    // freshness on reads nobody writes from, while this is the last thing between a stale premise
    // and an unattended board write. The asks behind it stay open rather than being tried against
    // the same stale board — the remote is unreachable for all of them, not just this one.
    const stale = await pullFailure(input.repo);
    if (stale) {
      await write(
        input,
        stop(
          `the shared board could not be pulled before ${proposal.id}, so anton cannot tell ` +
            `whether another machine has already moved what this would write — ${stale}`,
          attempts.slice(i),
        ),
      );
      break;
    }
    // The pull is the loop's longest await, and a cancel arriving inside it would otherwise not be
    // seen until this proposal had already been applied — an unattended write out of a pass an
    // operator (or the no-progress timeout) has stopped. Checked BEFORE the reservation, so a
    // cancel here costs the cap nothing.
    if (input.signal?.aborted) return cancelled(input.signal, attempts.slice(i));

    // The spend is recorded BEFORE the board is touched, never after. The record IS the accounting —
    // a retry of this job reconstructs what earlier attempts spent from these very lines
    // (jobs/pass-budget.ts) — so an apply whose line is written afterwards is, for the window in
    // between, an unattended board write nothing can see, and a retry landing in that window gets a
    // cap it has already spent. Reserving first turns the one failure that cost the cap its meaning
    // into a pass that simply never applied: no line, no write.
    const base = baseOf(proposal.id, plan);
    if (!(await write(input, reservationOf(base)))) {
      stop(
        `the attempt at ${proposal.id} could not be recorded, so this pass did not make it — it ` +
          `can no longer account for what it spends`,
        attempts.slice(i),
      );
      break;
    }
    // The last check this loop can make; the board read INSIDE applyOne gets the one on its far
    // side. The attempt is bought and stays bought — the cap is spent on a reservation, not on a
    // write — but it is given its outcome rather than left standing as an `APPLYING` line nobody
    // can resolve: here anton KNOWS nothing was written, and a reservation with no outcome tells a
    // founder to go and look.
    if (input.signal?.aborted) {
      const unmade = unmadeOf(base);
      records.push(unmade);
      await write(input, lineOf(unmade));
      return cancelled(input.signal, attempts.slice(i + 1));
    }

    const { record, stopped } = await applyOne(input, base);
    records.push(record);
    const recorded = await write(input, lineOf(record));
    // A cancel that landed inside applyOne's board read. Nothing was written — its outcome line says
    // so — and the rest of the walk is the pass being STOPPED, never a walk that finished. Ahead of
    // the recording check below: a cancel is not an outcome, and a log that also failed does not
    // turn one into a pass that ran to the end.
    if (stopped && input.signal) return cancelled(input.signal, attempts.slice(i + 1));
    // The outcome supersedes the reservation (record.ts). Losing it costs the record what the write
    // DID, never the fact that it happened — but a log that has started refusing writes is no longer
    // one this pass can account against, so it stops here rather than reserving into it again.
    if (recorded) continue;
    stop(
      `the outcome of ${proposal.id} could not be recorded — the attempt itself is on the record, ` +
        `but what it did to the board is not`,
      attempts.slice(i + 1),
    );
    break;
  }

  await publish();
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

/** The whole ask, as both lines about it carry it — the reservation and the outcome that follows. */
type ArmedAsk = Omit<ArmedRecord, "outcome" | "detail">;

function baseOf(proposalId: string, plan: GardenerPlan): ArmedAsk {
  return {
    proposal: proposalId,
    kind: plan.kind,
    move: plan.move,
    ...(plan.retireAs ? { retireAs: plan.retireAs } : {}),
    subjects: plan.subjects,
    ...(plan.target ? { target: plan.target } : {}),
    changed: [],
  };
}

/**
 * The line that BUYS the write, put down before it. Worded for the case where it is the last word on
 * this proposal — the outcome line supersedes it everywhere else (record.ts) — so it says what a
 * founder finding it standing alone has to do: the ask was attempted, and the board is the only
 * place that now says how it went.
 */
function reservationOf(ask: ArmedAsk): string {
  return passRecordLine({
    mode: "apply",
    ...ask,
    verdict: "APPLYING",
    detail:
      "attempted unattended — if no outcome line follows, this pass could not record how it went; " +
      "the subject on the board is the only evidence",
  });
}

/**
 * The outcome a reservation gets when a cancel arrives before the board is touched — the one case
 * where anton can say for certain that nothing was written. Recorded as an `error` because from the
 * board's side it is an ask this pass attempted and did not settle.
 */
const unmadeOf = (base: ArmedAsk): ArmedRecord => ({
  ...base,
  outcome: "error",
  detail: "the pass was cancelled before the board was touched — nothing was applied",
});

/**
 * Refresh the shared board, or say why this apply may not proceed.
 *
 * `beads.pull` RESOLVES for a workspace with no Dolt remote — a board with nowhere to be stale
 * against is fresh by definition — and rejects on every failure that can leave this checkout behind
 * one: auth, an unreachable remote, a real divergence (beads/bd.ts `runDoltSync`). So a rejection
 * here means exactly "anton cannot establish that it is looking at the current board".
 */
async function pullFailure(repo: string): Promise<string | undefined> {
  try {
    await beads.pull(repo);
    return undefined;
  } catch (e) {
    return messageOf(e);
  }
}

/**
 * Publish this pass's writes, or say why they are still only on this machine.
 *
 * `beads.push` is the one sync entry point that ANSWERS: it rejects on a real push failure (a
 * divergence the pull could not merge, auth, an unreachable remote) and resolves for a workspace
 * with no Dolt remote, because nowhere to publish to is not a failure to publish (beads/bd.ts). It
 * is the durable job's pass on purpose — the write-nudge fired just before it already counted this
 * work into the unpushed backlog, and a second counting pass would report one stranded write as
 * two. Both route through the per-repo coalescer, so the two can never overlap (beads GH#2466).
 *
 * Failing here does NOT fail the pass: the board writes happened, the record above is what says so,
 * and the durable sync-push job the nudge enqueued keeps retrying and parks for a human on
 * exhaustion. What this buys is that the record never claims a move the shared board cannot see.
 */
async function pushFailure(repo: string): Promise<string | undefined> {
  try {
    await beads.push(repo);
    return undefined;
  } catch (e) {
    return messageOf(e);
  }
}

/** One attempt's outcome, and whether the walk that made it is still running. */
interface ArmedAttempt {
  record: ArmedRecord;
  /** The pass was cancelled between the board read and apply's first mutation — nothing was written. */
  stopped?: boolean;
}

/**
 * One proposal, applied against a board read FRESH for it — as the approve route reads one per
 * approval, and for a reason a shared snapshot could not answer: an earlier apply in this same loop
 * may have moved a bead this one rests on. Fresh across MACHINES too: the caller pulls the shared
 * board immediately before this runs, so the read below carries what other machines have written.
 *
 * Total. A {@link ProposalApplyError} is the board's answer or a rolled-back write, and anything
 * else is a bd that broke; both leave the proposal open with the reason on it, and neither stops the
 * loop. A CANCEL is the exception the caller re-raises, and it comes back as `stopped` rather than
 * as a throw so the two failure kinds never have to be told apart by identity.
 */
async function applyOne(input: ArmedInput, base: ArmedAsk): Promise<ArmedAttempt> {
  const proposalId = base.proposal;
  try {
    const board = await loadAllIssues(input.repo);
    // The board read is a bd CLI call over every issue — the last await before apply's FIRST
    // mutation, and the one the caller's checks cannot cover: a cancel arriving inside it would
    // otherwise not be seen until this proposal had been closed, deferred or reparented. Checked
    // here rather than by making apply itself abortable: apply's writes roll back as a unit, and
    // an abort mid-move is a partial move nobody asked for. Not applying at all is the safe answer.
    if (input.signal?.aborted) return { record: unmadeOf(base), stopped: true };
    const proposal = board.find((b) => b.id === proposalId);
    if (!proposal) {
      // Filed minutes ago and already gone: another machine's patrol withdrew it as a duplicate, or
      // a human declined it. Either way the ask has been answered by someone else and is not ours.
      return {
        record: {
          ...base,
          outcome: "error",
          detail: "it is no longer on the board — nothing was applied",
        },
      };
    }
    const applied = await applyProposal(input.repo, proposal, board, "policy");
    return {
      record: { ...base, outcome: "applied", detail: applied.summary, changed: applied.changed },
    };
  } catch (e) {
    // `refused`/`unusable` are the board declining — the ordinary outcome for an ask whose premise
    // moved. `failed` is a write that broke and was rolled back, which is anton's failure, not a
    // verdict, and reads as one in the log.
    const refused = e instanceof ProposalApplyError && e.failure !== "failed";
    return {
      record: { ...base, outcome: refused ? "refused" : "error", detail: messageOf(e) },
    };
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
