/**
 * Shadow mode (anton-lmps): what a pass WOULD have applied, recorded and never written.
 *
 * A shadow run is exactly the armed run minus the writes. It calls the same {@link planApply} an
 * approval calls, against a board read the same way apply reads one — so the answer an operator sees
 * here is the answer the armed feature would act on, not a second implementation that agrees with it
 * until the day it doesn't. That is what makes a week of shadow output evidence: "arming `stale`
 * would have deferred four beads and refused two, and here is each refusal in planApply's own words".
 *
 * The one property this module exists to hold: it CANNOT write. It reads a board and formats lines.
 * `planApply` is pure over (plan, board, moment) and returns the steps rather than running them, and
 * nothing here touches the executor that would. A proposal whose shadow throws is logged and skipped
 * — one unshadowable ask must never cost a pass the proposals it just filed, because the shadow
 * record is commentary and the beads are the work.
 *
 * Shared by both producers on purpose. The gardener patrol and the product-master pass file the same
 * proposal beads through the same emitter, so they shadow through the same code; a per-producer copy
 * would be two answers to "what would this have done" that drift.
 */
import { beads, type Bead } from "../beads/bd";
import { attachCycleEvidence } from "../beads/cycle-evidence";
import { loadAllIssues, sameBlocksEdges } from "../beads/issues";
import { CYCLE_AWARE_MOVES, planApply, toBdStampGrid, type ApplyMoment } from "./apply";
import {
  autonomyFor,
  type ProposalAutonomyPolicy,
  type ProposalTrackRecord,
} from "./autonomy";
import {
  planOf,
  type GardenerDetectionKind,
  type GardenerMove,
  type GardenerPlan,
  type RetireVerb,
} from "./detections";
import type { EmittedProposal } from "./emit";
import { passRecordLine, type ShadowVerdict } from "./record";

/** What the shadow decided for one proposal — `error` is anton failing to decide, never a verdict. */
export type ShadowOutcome = "apply" | "settled" | "refuse" | "error";

/**
 * One proposal's shadow, as data. Carries the whole ask — proposal, kind, verb, subjects and
 * counterpart — so a reader never has to open the bead to know which one this line is about, and
 * carries `planApply`'s own words in `detail` rather than a paraphrase: a refusal an operator will
 * act on has to be the string the armed pass would have refused with.
 */
export interface ShadowRecord {
  /** The proposal bead this pass just filed. */
  proposal: string;
  kind: GardenerDetectionKind;
  move: GardenerMove;
  /** Which retirement a `retire` move would run — the verb that decides what the move COSTS. */
  retireAs?: RetireVerb;
  subjects: string[];
  /** The move's counterpart: the new parent, the blocker, the replacement. */
  target?: string;
  outcome: ShadowOutcome;
  /** `planApply`'s summary, its refusal reason VERBATIM, or the error that stopped the shadow. */
  detail: string;
}

export interface ShadowInput {
  repo: string;
  /** What the pass just filed — shadowed in the order it was filed. */
  created: EmittedProposal[];
  policy: ProposalAutonomyPolicy;
  /**
   * What this board's settled proposals say about each kind (anton-m29g) — read off the caller's own
   * snapshot, alongside the policy, and threaded through to `autonomyFor` so the shadow set is picked
   * by the identical resolver the pass acts on rather than by a second reading of the policy.
   *
   * The earned floor gates `apply` alone: a kind set to `shadow` is unaffected by its record and
   * reaches here unchanged — which is how an unearned kind builds one in the first place.
   */
  record: ProposalTrackRecord;
  /** The pass's own board snapshot stamp: what every premise check dates "since we asked" against. */
  observedAtMs?: number;
  nowMs: number;
  /** The producer's log prefix, e.g. `[gardener]` — the pass's session log carries other lines too. */
  producer: string;
  /** Where the record lands. The session log, so the jobs page shows it with no new surface. */
  log: (chunk: string) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * The proposals this policy would shadow — the manual-move floor already applied by `autonomyFor`.
 *
 * `apply` is deliberately NOT shadowed: an armed kind is meant to be written, not described, so
 * routing it here would report a move as hypothetical that the pass is about to make for real. That
 * branch is armed.ts's (anton-4ab3), and the two levels are disjoint by construction — a kind
 * resolves to exactly one of them, so no proposal is ever both described and applied.
 */
function shadowable(
  created: EmittedProposal[],
  policy: ProposalAutonomyPolicy,
  record: ProposalTrackRecord,
): Array<{ proposal: EmittedProposal; plan: GardenerPlan }> {
  return created.flatMap((proposal) => {
    const plan = planOf(proposal.detection);
    return autonomyFor(plan.kind, plan, policy, record) === "shadow" ? [{ proposal, plan }] : [];
  });
}

/**
 * Shadow what this pass filed: decide each `shadow`-armed proposal against a FRESH board and record
 * the outcome. Writes nothing, and never throws — a shadow that cannot run is a line in the log.
 *
 * The board is re-read rather than reusing the pass's snapshot, because that is what an approval
 * does: the snapshot is minutes old by the time the proposals are filed, and shadowing against it
 * would report a verdict the armed pass would not have reached.
 */
export async function shadowProposals(input: ShadowInput): Promise<ShadowRecord[]> {
  const targets = shadowable(input.created, input.policy, input.record);
  if (targets.length === 0 || input.signal?.aborted) return [];

  let board: Bead[];
  try {
    board = await loadAllIssues(input.repo);
  } catch (e) {
    // The read is the shadow's whole input, so losing it loses every record — but it costs the pass
    // nothing else, because a shadow has nothing to leave half-done.
    await write(input, `SHADOW could not read the board — ${messageOf(e)}; nothing shadowed`);
    return [];
  }

  // Fetched separately from the board, and only when a shadowed target's move actually consults
  // cycle evidence (`approve` / `unapprove` — `planApply` only reaches the approval gate for those).
  // Every other move (`reparent`, `link`, `retire`, …) is cycle-blind, so an unconditional
  // `bd dep cycles` call would pay a subprocess this shadow never uses. Kept OUT of `loadAllIssues`'s
  // `withCycles: true` deliberately (mirrors apply.ts's `withCycleEvidenceIfNeeded`): that option
  // rejects the WHOLE read on a cycles failure, which would erase every shadow record — including
  // the cycle-blind ones the board read alone was sufficient for. A failure here instead leaves
  // `board` without cycle evidence, so only `decide()`'s cycle-aware verdicts fail closed on the gap
  // (`missingCycleEvidenceGap`); every other target still shadows normally.
  if (targets.some(({ plan }) => CYCLE_AWARE_MOVES.has(plan.move))) {
    try {
      const cycles = await beads.depCycles(input.repo);
      // Another writer can land or repair a `blocks` edge on a shared-server board in the gap between
      // `loadAllIssues` above and this `bd dep cycles` call settling — the same staleness
      // `loadAllIssues`'s own `sameBlocksEdges` retry and `attachCyclesBestEffort` guard against.
      // Attaching `cycles` to `board` unchecked would let `decide()` pair a fresh cycle answer with a
      // board whose edges no longer describe it: an `approve`/`unapprove` verdict could read `apply`
      // here while the armed path's own locked reread — which DOES recheck — would refuse the same
      // proposal, recording shadow evidence that overstates how safe the kind is to arm. Re-list and
      // compare before attaching, even when `board` itself starts edge-free — that only describes the
      // read that already happened, not whether a writer added the first edge during this gap; a
      // cycle-blind target in this same batch still decides off the original `board` even when the
      // recheck fails, since it never consults cycle evidence at all.
      const consistent = sameBlocksEdges(board, await loadAllIssues(input.repo));
      if (consistent) {
        attachCycleEvidence(board, cycles);
      } else {
        await write(
          input,
          "SHADOW board moved between the board read and cycle evidence — approve/unapprove verdicts fail closed",
        );
      }
    } catch (e) {
      await write(
        input,
        `SHADOW could not read cycle evidence — ${messageOf(e)}; approve/unapprove verdicts fail closed`,
      );
    }
  }

  // Floored to bd's stamp grid exactly as `observedAtOf` floors the armed path's fence. The armed
  // path reads its stamp back off the proposal bead; the shadow holds the pass's raw wall-clock
  // reading, which still carries milliseconds — and an unfloored fence orders a same-second write as
  // "before the observation" where the armed path sees the tie it fails closed on. Same grid, same
  // verdict; otherwise the shadow promises an apply the approval would refuse.
  const at: ApplyMoment = {
    nowMs: input.nowMs,
    observedAtMs: input.observedAtMs === undefined ? undefined : toBdStampGrid(input.observedAtMs),
  };
  const records: ShadowRecord[] = [];
  for (const { proposal, plan } of targets) {
    if (input.signal?.aborted) break;
    const record = decide(proposal.id, plan, board, at);
    records.push(record);
    await write(input, lineOf(record));
  }
  return records;
}

/** One proposal's verdict. Total: a `planApply` that throws becomes an `error` record, not a throw. */
function decide(
  proposal: string,
  plan: GardenerPlan,
  board: Bead[],
  at: ApplyMoment,
): ShadowRecord {
  const base = {
    proposal,
    kind: plan.kind,
    move: plan.move,
    ...(plan.retireAs ? { retireAs: plan.retireAs } : {}),
    subjects: plan.subjects,
    ...(plan.target ? { target: plan.target } : {}),
  };
  try {
    const decision = planApply(plan, board, at);
    // Verbatim on every branch, refusals most of all: an operator arms a kind on the strength of
    // these reasons, so a summarized one is a decision made on anton's paraphrase of itself.
    if (decision.status === "refuse") return { ...base, outcome: "refuse", detail: decision.reason };
    if (decision.status === "settled") return { ...base, outcome: "settled", detail: decision.summary };
    return { ...base, outcome: "apply", detail: decision.summary };
  } catch (e) {
    return { ...base, outcome: "error", detail: messageOf(e) };
  }
}

/** Typed through record.ts's vocabulary, so a reworded verdict is a type error, not a silent one. */
const VERDICT: Record<ShadowOutcome, ShadowVerdict> = {
  apply: "WOULD APPLY",
  settled: "ALREADY SETTLED",
  refuse: "WOULD REFUSE",
  error: "COULD NOT SHADOW",
};

/** One line per proposal, so a pass's whole shadow reads as a list in the session log. */
function lineOf(record: ShadowRecord): string {
  return passRecordLine({ mode: "shadow", ...record, verdict: VERDICT[record.outcome] });
}

/**
 * Best-effort: a session log that will not take a write must not fail the pass it describes — but it
 * is never silent either, or a broken log store reads as a pass that found nothing to shadow.
 */
async function write(input: ShadowInput, line: string): Promise<void> {
  await input.log(`${input.producer} ${line}\n`).catch((e) => {
    console.warn(`${input.producer} could not record a shadow — ${messageOf(e)}: ${line}`);
  });
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
