/**
 * EMISSION (anton-9qwq): a detection becomes a PROPOSAL BEAD — the board's own record of a judgment
 * call, rather than a report line that scrolls past. A proposal is an ordinary parentless `task`, so
 * every surface the board already has renders it: it gets a chip, a contract, a detail page, and the
 * approval affordance every other run target has. Nothing here is a new UI concept.
 *
 * Three properties carry this module, and each is a way emission could quietly do harm:
 *
 *   • ONE proposal per claim. The detection's `gardener:<kind>:<hash>` fingerprint rides on the bead
 *     as a label, and a fingerprint already on the board suppresses re-emission — so a patrol that
 *     runs nightly over an unfixed board asks once, not thirty times. (Mirrors the
 *     `stringer:<collector>:<hash>` convention /scan-triage dedups against.) Suppression cannot be
 *     the whole answer, though: it reads the LOCAL working set, so two patrols on different machines
 *     can both miss a fingerprint neither has pushed yet and file the same ask twice. Two things
 *     undo that: {@link arbitrateEmission} publishes the pass's own claims and withdraws the loser
 *     seconds later, and {@link reconcileDuplicateProposals} folds whatever that missed the next
 *     time a patrol runs.
 *   • DECLINED STAYS DECLINED. Suppression keys on "not settled", not on "open": an abandoned
 *     proposal — anton's won't-do outcome (LABELS.abandoned) — suppresses forever, which is what
 *     makes declining meaningful. A PLAINLY closed proposal (one that was applied, anton-1t3n) does
 *     NOT suppress: the move landed, so the detector has nothing left to find, and if it somehow
 *     does the board really did regress.
 *   • EVIDENCE TRAVELS WITH THE ASK. The detection's evidence lines and `discovered-from` edges to
 *     every bead the move concerns land on the proposal, so an approver can check the reasoning from
 *     the bead itself instead of re-deriving it from the board.
 *
 * Applying an approved proposal is anton-1t3n's job; nothing here mutates a subject bead.
 */
import { beads, CLAIM_SETTLE_MS, LABELS, type Bead, type SyncOutcome } from "../beads/bd";
import { withBeadWriteLocks } from "../beads/claim-lock";
import { loadAllIssues } from "../beads/issues";
import { isClaimed, isOpenWork } from "./board-index";
import {
  concernedBeads,
  fingerprintLabelOf,
  GARDENER_OBSERVED_AT_KEY,
  GARDENER_PLAN_KEY,
  isManualProposal,
  isProposalBead,
  namespaceOf,
  planOf,
  type GardenerDetection,
  type GardenerPlan,
  type ProposalNamespace,
} from "./detections";

/**
 * The labels every proposal carries besides its fingerprint and its `source:<producer>` — which is
 * the `source:stringer` convention, one namespace over, and is added per-producer in
 * {@link proposalDraft}. No `agent:` on purpose: a proposal is a decision, not work an agent
 * implements — the move is applied mechanically through the beads seam.
 */
export const PROPOSAL_LABELS: readonly string[] = ["domain:eng", "risk:low", "size:S"];

/** How each producer introduces itself on the beads it files — title prefix and provenance. */
const PRODUCER: Record<ProposalNamespace, { title: string; filedBy: string }> = {
  gardener: {
    title: "Gardener",
    filedBy: "the gardener patrol from a `%kind%` board-shape detection (anton-e42l)",
  },
  pm: {
    title: "Product master",
    filedBy: "the product-master pass from a `%kind%` product judgment (anton-d2sx)",
  },
};

/**
 * How many proposals ONE pass may file. A board that has never been tended can yield dozens at once,
 * and a patrol that dumped all of them would bury the product work it sits beside — the queue-quality
 * rule /scan-triage answers with `max_beads_per_scan`. Detections are deterministically ordered, so
 * the overflow is not lost: the next pass emits it, and the caller logs what was held back.
 */
export const MAX_PROPOSALS_PER_PASS = 10;

/**
 * How many proposals ONE pass may APPLY unattended (anton-4ab3) — a different budget from
 * {@link MAX_PROPOSALS_PER_PASS}, and deliberately smaller.
 *
 * That cap bounds a founder's ATTENTION: ten asks is a readable morning, and being wrong costs a
 * longer list. This one bounds unattended WRITES to the board, where being wrong costs board state
 * nobody chose — a different question, which deserves a smaller answer. Three is a night's tidying;
 * a board that wants more than that in one pass is a board an operator should be looking at.
 *
 * The overflow is not lost and not applied later by stealth: it stays open as an ordinary ask that
 * a human approves or declines. No later pass re-decides it — suppression keys on the fingerprint
 * an open proposal already carries, so the ask standing on the board is what keeps it from being
 * re-filed, and the armed walk only ever visits the proposals its own pass just created.
 */
export const MAX_APPLIES_PER_PASS = 3;

/**
 * Fingerprints the board says NOT to propose again: every proposal still open, plus every one
 * declined (abandoned). A plainly-closed proposal is absent deliberately — see the module header.
 */
export function suppressedFingerprints(board: Bead[]): Set<string> {
  const out = new Set<string>();
  for (const bead of board) {
    const fingerprint = fingerprintLabelOf(bead);
    if (!fingerprint) continue;
    if (isOpenWork(bead) || beads.isAbandoned(bead)) out.add(fingerprint);
  }
  return out;
}

export interface EmissionPlan {
  /** What this pass files, in detection order, capped at the limit. */
  emit: GardenerDetection[];
  /** Claims the board already carries — open or declined. */
  suppressed: GardenerDetection[];
  /** Fresh claims over the cap. Not dropped: the next pass sees the same detections. */
  deferred: GardenerDetection[];
}

export interface EmissionInput {
  detections: GardenerDetection[];
  /** The full board (`--status all`): a DECLINED proposal is closed, so a live-only read misses it. */
  board: Bead[];
  /**
   * When `board` was read — the moment every proposal's evidence describes. Rides onto each bead so
   * apply dates changes against the snapshot the detection actually saw rather than against the
   * bead's creation stamp, which the sequential creates below push later (see
   * {@link GARDENER_OBSERVED_AT_KEY}). Omitted only by callers with no snapshot to name.
   */
  observedAtMs?: number;
  /**
   * The job's cancel signal, checked between creates. A pass files up to ten beads through
   * sequential bd writes, so a cancel arriving mid-loop has to stop the rest of them — without it a
   * cancelled patrol runs every judgment-tier write it planned before noticing.
   */
  signal?: AbortSignal;
  limit?: number;
}

/**
 * What a pass would file, decided without writing anything. Pure, so the dedup rule — the whole point
 * of the fingerprint — is testable against a fixture board rather than a live one.
 */
export function planEmission(input: EmissionInput): EmissionPlan {
  const limit = input.limit ?? MAX_PROPOSALS_PER_PASS;
  const blocked = suppressedFingerprints(input.board);
  const seen = new Set<string>();
  const fresh: GardenerDetection[] = [];
  const suppressed: GardenerDetection[] = [];

  for (const detection of input.detections) {
    // Two detections with one fingerprint are one claim, however the caller assembled the list.
    if (seen.has(detection.fingerprint)) continue;
    seen.add(detection.fingerprint);
    if (blocked.has(detection.fingerprint)) suppressed.push(detection);
    else fresh.push(detection);
  }

  return { emit: fresh.slice(0, limit), suppressed, deferred: fresh.slice(limit) };
}

/** Exactly the `beads.create` options a proposal is made of — built pure so a test can read them. */
export interface ProposalDraft {
  title: string;
  type: "task";
  labels: string[];
  acceptance: string;
  description: string;
  deps: string[];
  /**
   * The move, as data, under {@link GARDENER_PLAN_KEY} — what apply-on-approve reads (anton-1t3n) —
   * alongside the evidence snapshot's stamp, which dates every premise check apply makes.
   */
  metadata: {
    [GARDENER_PLAN_KEY]: GardenerPlan;
    [GARDENER_OBSERVED_AT_KEY]?: string;
  };
}

/**
 * The proposal bead for one detection: the full ticket contract (Goal / Acceptance / Context / Out of
 * scope / Verify), the evidence, the fingerprint, a `discovered-from` edge to every bead the move
 * concerns — so the proposal is reachable from each bead it would touch, not just the one it acts on
 * — and the MOVE ITSELF as metadata.
 *
 * The prose and the metadata are for different readers and neither substitutes for the other: a
 * human decides from the evidence, and apply-on-approve (anton-1t3n) executes from the plan. Both
 * land in one `bd create`, so no proposal ever exists in a state where the board shows the ask but
 * approving it has nothing to run.
 *
 * `task` and parentless is what makes it a run target the board renders as a chip; a `chore`, or a
 * child of anything, would be a bead only the tickets list ever shows.
 *
 * `observedAtMs` is when the board this detection came from was READ. It is stamped separately from
 * the bead's own creation time because the two drift apart within a single pass — see
 * {@link GARDENER_OBSERVED_AT_KEY}.
 */
export function proposalDraft(
  detection: GardenerDetection,
  observedAtMs?: number,
): ProposalDraft {
  const namespace = namespaceOf(detection.kind);
  return {
    title: `${PRODUCER[namespace].title}: ${moveClause(detection)}`,
    type: "task",
    labels: [detection.fingerprint, ...PROPOSAL_LABELS, `source:${namespace}`],
    acceptance: acceptanceOf(detection),
    description: descriptionOf(detection),
    deps: concernedBeads(detection).map((id) => `discovered-from:${id}`),
    metadata: {
      [GARDENER_PLAN_KEY]: planOf(detection),
      ...(observedAtMs !== undefined && Number.isFinite(observedAtMs)
        ? { [GARDENER_OBSERVED_AT_KEY]: new Date(observedAtMs).toISOString() }
        : {}),
    },
  };
}

export interface EmittedProposal {
  id: string;
  fingerprint: string;
  detection: GardenerDetection;
}

export interface EmissionResult {
  created: EmittedProposal[];
  /** Claims the board already carried — the count that proves a re-run asked nothing twice. */
  suppressed: number;
  /** Fresh claims held back by the cap, for the caller to log. Never silently dropped. */
  deferred: number;
}

/**
 * A pass that stopped part-way — a create that failed, or a cancel that arrived mid-loop — carrying
 * what DID land. The proposals already filed are real board state that exists only in the local Dolt
 * working set, so the stop has to hand them back rather than swallow them: if the failing create
 * keeps failing the job parks, and a caller that never learned about the earlier ones never
 * propagates them to the other machines (see jobs/gardener.ts).
 */
export class PartialEmissionError extends Error {
  constructor(
    readonly result: EmissionResult,
    cause: unknown,
  ) {
    super(
      `filing gardener proposals stopped after ${result.created.length} of the pass's creates landed: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
    this.name = "PartialEmissionError";
  }
}

/**
 * File this pass's proposals. Sequential on purpose: each create is a bd write against the same Dolt
 * working set, and a failure part-way leaves the proposals already filed standing — they carry their
 * fingerprints, so the retry that re-reads the board files only what is still missing.
 *
 * Standing locally is not the same as being SEEN, though, so a stop throws
 * {@link PartialEmissionError} with the landed proposals attached instead of losing them.
 */
export async function emitProposals(repo: string, input: EmissionInput): Promise<EmissionResult> {
  const plan = planEmission(input);
  const created: EmittedProposal[] = [];
  const sofar = (): EmissionResult => ({
    created,
    suppressed: plan.suppressed.length,
    deferred: plan.deferred.length,
  });

  for (const detection of plan.emit) {
    // Between EVERY create, not once before the loop: a cancel arriving after the first write must
    // stop the rest of the pass rather than let a cancelled patrol finish all ten of its
    // judgment-tier writes. Reported the same way a failed create is — what landed is board state
    // either way, and the caller has to propagate it.
    if (input.signal?.aborted) throw new PartialEmissionError(sofar(), input.signal.reason);
    let id: string;
    try {
      id = await beads.create(repo, proposalDraft(detection, input.observedAtMs));
    } catch (e) {
      throw new PartialEmissionError(sofar(), e);
    }
    created.push({ id, fingerprint: detection.fingerprint, detection });
  }

  return sofar();
}

// ── reconciling duplicate claims ──

/**
 * A twin nobody has acted on yet. The two states that make a proposal untouchable are a human's
 * APPROVAL and a run's CLAIM: folding an approved twin discards a decision somebody already made,
 * and folding a claimed one races the apply that holds it (`applyProposal` runs the whole
 * application under the proposal's write lock and refuses a settled bead).
 */
function unclaimedTwin(bead: Bead): boolean {
  return !(bead.labels ?? []).includes(LABELS.approved) && !isClaimed(bead);
}

/** Ranks the twin the board is most invested in first, then oldest id — total, so two patrols agree. */
function survivorFirst(a: Bead, b: Bead): number {
  return Number(unclaimedTwin(a)) - Number(unclaimedTwin(b)) || a.id.localeCompare(b.id);
}

/** One fingerprint the board carries more than once: the proposal that stands, and its twins. */
export interface DuplicateProposals {
  fingerprint: string;
  /** The twin that keeps the ask — approved or claimed if any is, else the first filed. */
  keep: string;
  /** Twins to fold into `keep`: same claim, nobody acting on them. */
  fold: string[];
  /** Twins left standing because an approval or a run holds them. Named, never quietly folded. */
  held: string[];
}

/**
 * Duplicate open proposals, decided without writing anything — the answer to the one gap
 * fingerprint suppression structurally cannot close.
 *
 * Suppression is a check against a board read, and the creation it guards is a separate bd write, so
 * it is only atomic within one patrol. Two patrols on DIFFERENT machines each read a working set the
 * other's proposal has not synced into yet, so both see the fingerprint missing and both file it;
 * bd has no uniqueness constraint on a label to refuse the second, and no cross-process lock exists
 * to serialize them (see beads/claim-lock.ts — the same limit every anton claim lives with). Making
 * the check and the create atomic across machines is therefore not on the table; converging AFTER
 * the fact is, and it is enough, because a fingerprint means the two beads ask exactly the same
 * question: it is recomputed from the parsed kind/subjects/target at apply time
 * (`parseGardenerPlan`, detections.ts), so twins that share one cannot name different moves.
 *
 * The survivor is picked by a TOTAL order both machines compute alike, so two patrols reconciling
 * the same board concurrently converge on the same bead rather than folding each other away.
 *
 * `only` narrows the fold to named claims — what {@link arbitrateEmission} passes so a pass's own
 * arbitration answers for the proposals it just filed and nothing else.
 */
export function planReconciliation(
  board: Bead[],
  only?: ReadonlySet<string>,
): DuplicateProposals[] {
  const groups = new Map<string, Bead[]>();
  for (const bead of board) {
    const fingerprint = fingerprintLabelOf(bead);
    // Open only: a declined twin is a recorded answer and a plainly-closed one is already folded or
    // applied — neither is a second ask standing on the board.
    if (!fingerprint || !isProposalBead(bead) || !isOpenWork(bead)) continue;
    if (only && !only.has(fingerprint)) continue;
    const group = groups.get(fingerprint);
    if (group) group.push(bead);
    else groups.set(fingerprint, [bead]);
  }

  const duplicates: DuplicateProposals[] = [];
  for (const [fingerprint, group] of groups) {
    if (group.length < 2) continue;
    const [keep, ...twins] = [...group].sort(survivorFirst);
    duplicates.push({
      fingerprint,
      keep: keep.id,
      fold: twins.filter(unclaimedTwin).map((b) => b.id),
      held: twins.filter((b) => !unclaimedTwin(b)).map((b) => b.id),
    });
  }
  return duplicates.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * Does the survivor still carry this claim, read from inside its own write lock? A fold's whole
 * premise is that the ask survives on `keep`; a deleted or re-labelled survivor makes the close a
 * silent retraction of the last standing ask.
 *
 * Fails CLOSED — an unreadable survivor answers "no", so the twin is left standing and the next
 * patrol re-asks. Judged on the fingerprint alone, not on openness: a survivor closed since the
 * snapshot was answered (applied, or declined and now suppressed), which is a legitimate end for the
 * ask, while requiring it open would strand duplicate noise whenever an apply settles it mid-fold.
 */
async function survivorHolds(repo: string, duplicate: DuplicateProposals): Promise<boolean> {
  try {
    return fingerprintLabelOf(await beads.show(repo, duplicate.keep)) === duplicate.fingerprint;
  } catch {
    return false;
  }
}

export interface ReconcileResult {
  folded: Array<{ id: string; into: string }>;
  /** Duplicates an approval or a run holds — left for a human rather than folded under them. */
  held: string[];
  /** Folds whose close failed. Reported, not thrown: the next patrol sees the twin and retries. */
  failed: string[];
}

/** The one phrase that marks a close as a fold. Written by {@link foldReason}, read by nothing else. */
const FOLD_REASON_PREFIX = "duplicate of ";

/**
 * Why a folded duplicate was closed — built here rather than inline, because TWO readers depend on
 * telling this close from an apply's.
 *
 * A fold is a PLAIN close on purpose (see {@link reconcileDuplicateProposals}), so nothing about the
 * bead's status distinguishes "the founder accepted this ask" from "overlapping patrols filed it
 * twice and we kept the other one". The settled-proposal record (track-record.ts) counts the first as
 * evidence a kind can be armed on, and counting the second would score every fold as a success —
 * inflating precision exactly when a detector is at its noisiest, which is the failure mode
 * inverted. One builder, one predicate, so the writer and the reader cannot drift.
 */
export function foldReason(keep: string, fingerprint: string): string {
  return (
    `${FOLD_REASON_PREFIX}${keep}: overlapping patrols filed the same claim ` +
    `(${fingerprint}) twice — ${keep} carries the ask`
  );
}

/** Was this close a {@link foldReason} — a duplicate withdrawn — rather than an apply or a decline? */
export function isFoldReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.trimStart().startsWith(FOLD_REASON_PREFIX);
}

export interface ReconcileOptions {
  /** The patrol's cancel signal, checked between closes. */
  signal?: AbortSignal;
  /** Fold only these claims. Omitted, every duplicate on the board is in scope. */
  fingerprints?: ReadonlySet<string>;
}

/**
 * Fold this board's duplicate proposals into one ask each.
 *
 * PLAINLY closed, never abandoned: `suppressedFingerprints` reads abandonment as "a human declined
 * this claim" and suppresses it forever, so abandoning a twin would poison the fingerprint the
 * SURVIVOR still needs — the patrol would stop re-asking a question nobody answered. A plain close
 * carries bd's own reason instead, which names the bead that kept the ask.
 *
 * Each fold takes the write lock of BOTH twins — the one being folded and the survivor it is folded
 * into — and re-reads both there, for the same reason every other write in this feature does:
 * `board` is a snapshot, and the states that make a twin untouchable — an approval, a run's claim,
 * an apply already settling it — all land through that lock. Under it the orders are decided: either
 * the approval lands first and this fold sees it and skips, or the fold lands first and
 * `applyProposal`'s own locked re-read refuses a settled proposal. The SURVIVOR earns its lock the
 * same way from the other direction: a delete lands through that lock too (`deleteTicket`), and
 * closing the last open twin as a duplicate of a bead that is no longer there would leave the claim
 * with no standing ask at all until a later patrol re-derived it.
 *
 * A failed close is REPORTED rather than thrown. It leaves board noise, not a wrong write, and the
 * duplicate is still there for the next patrol — parking a patrol over cosmetic cleanup would cost
 * the tiers that matter.
 */
export async function reconcileDuplicateProposals(
  repo: string,
  board: Bead[],
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { signal, fingerprints } = options;
  const result: ReconcileResult = { folded: [], held: [], failed: [] };

  for (const duplicate of planReconciliation(board, fingerprints)) {
    result.held.push(...duplicate.held);
    for (const id of duplicate.fold) {
      // Between every close, like the emission loop: a cancelled patrol must stop writing, and what
      // already landed is board state the caller still has to propagate.
      if (signal?.aborted) return result;
      try {
        const folded = await withBeadWriteLocks(repo, [duplicate.keep, id], async () => {
          if (!(await survivorHolds(repo, duplicate))) return false;
          const live = await beads.show(repo, id);
          const stale =
            fingerprintLabelOf(live) !== duplicate.fingerprint ||
            !isOpenWork(live) ||
            !unclaimedTwin(live);
          if (stale) return false;
          await beads.close(repo, id, foldReason(duplicate.keep, duplicate.fingerprint));
          return true;
        });
        if (folded) result.folded.push({ id, into: duplicate.keep });
      } catch {
        result.failed.push(id);
      }
    }
  }

  return result;
}

// ── arbitrating this pass's own claims (anton-x4ks) ──

/**
 * How long an emission settles before it judges its own board read. Reused verbatim from the
 * verified-claim protocol ({@link CLAIM_SETTLE_MS}), and for the identical reason: concluding "ours
 * is the only proposal for this claim" from the ABSENCE of a twin is a decision made on absence,
 * which is unreliable on an eventually-consistent board — a machine that filed the same instant may
 * not have propagated yet. Comfortably above sync round-trip latency, and paid once per pass that
 * actually filed something.
 */
export const EMISSION_SETTLE_MS = CLAIM_SETTLE_MS;

/**
 * The one stand-down that means "no twin can exist" rather than "a twin may be standing": a board
 * with no remote is not shared, so nothing could have filed the claim twice. Exported so a caller
 * can tell it from the skips that DO leave duplicate noise for the next patrol.
 */
export const NO_REMOTE_SKIP = "the board has no remote — no second patrol to race";

/** The seam arbitration drives, injectable so a test can stage two patrols without a real remote. */
export interface EmissionArbitrationDeps {
  /**
   * Publish this pass's proposals. Defaults to `beads.push` rather than `beads.sync` for two
   * reasons: it RESOLVES the outcome, so "this board has no remote" is knowable rather than
   * guessed, and it never grows the unpushed backlog — the write nudge that fired for the same
   * creates already counted them, and both share the per-repo coalescer so neither doubles a push.
   */
  push?: (cwd: string) => Promise<SyncOutcome>;
  pull?: (cwd: string) => Promise<unknown>;
  /** The post-settle board read — every status, like the patrol's own (see jobs/gardener.ts). */
  board?: (cwd: string) => Promise<Bead[]>;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  signal?: AbortSignal;
}

export interface ArbitrationResult extends ReconcileResult {
  /**
   * Why no arbitration ran, when none did. Never silence: a skipped arbitration means a twin may be
   * standing that only the NEXT patrol will fold, and a reader has to be able to tell that from a
   * pass that arbitrated and found nothing.
   */
  skipped?: string;
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Converge the claims THIS pass filed down to one proposal each — the run-lease arbitration pattern
 * (anton-jz1, and `beads.claimVerified`) applied to emission: publish, settle, re-read, and fold the
 * loser when another machine's twin is there.
 *
 * Why it is needed at all: `planEmission` suppresses a fingerprint already on the board, but that
 * read is a snapshot and the `bd create` it guards is a separate write, so suppression is only
 * atomic within ONE patrol. bd has no uniqueness constraint on a label and no cross-process
 * conditional write (anton-od4), so nothing can refuse the second create. What CAN be done is decide
 * the winner afterwards, and do it fast: {@link reconcileDuplicateProposals} already folds twins,
 * but only when the next patrol runs — a nightly schedule leaves an operator a whole day to act on
 * an ask the board is carrying twice. Arbitrating here shrinks that to the settle window.
 *
 * It NARROWS the race rather than closing it, which is the honest limit of every anton claim: a
 * rival whose push has not landed by the time we re-read is invisible, and both machines keep their
 * proposal. That costs a duplicate the next patrol folds — never a lost ask, because the survivor is
 * chosen by the same total order on both machines ({@link planReconciliation}), so two arbitrations
 * running at once fold the same loser instead of folding each other away.
 *
 * Fails OPEN, every step: an unpublishable or unreadable board yields `skipped` and leaves both
 * twins standing. Duplicate noise the next patrol clears is the cheap outcome; withdrawing an ask on
 * the strength of a board read we could not trust is the expensive one.
 */
export async function arbitrateEmission(
  repo: string,
  created: readonly EmittedProposal[],
  deps: EmissionArbitrationDeps = {},
): Promise<ArbitrationResult> {
  const skip = (skipped: string): ArbitrationResult => ({
    folded: [],
    held: [],
    failed: [],
    skipped,
  });
  if (created.length === 0) return skip("this pass filed no proposals");
  if (deps.signal?.aborted) return skip("the patrol was cancelled");

  const push = deps.push ?? beads.push;
  const pull = deps.pull ?? beads.pull;
  const readBoard = deps.board ?? loadAllIssues;
  const sleep = deps.sleep ?? sleepMs;

  // Publish first, and not only so the twin's machine can see ours: a proposal no other machine can
  // read cannot lose a race there, so an unpublished pass that withdrew its own ask would retract
  // the only copy of it anyone has.
  let outcome: SyncOutcome;
  try {
    outcome = await push(repo);
  } catch (e) {
    return skip(`could not publish this pass's proposals (${errorText(e)})`);
  }
  // A board with no remote has no second machine to race, so waiting out a propagation window it
  // cannot have would stall every single-machine patrol for nothing.
  if (outcome === "not-wired") return skip(NO_REMOTE_SKIP);

  await sleep(deps.settleMs ?? EMISSION_SETTLE_MS);
  if (deps.signal?.aborted) return skip("the patrol was cancelled");

  try {
    await pull(repo);
  } catch (e) {
    return skip(`could not sync the board after publishing (${errorText(e)})`);
  }
  let board: Bead[];
  try {
    board = await readBoard(repo);
  } catch (e) {
    return skip(`could not read the board back after publishing (${errorText(e)})`);
  }

  // Scoped to the claims this pass filed: arbitration answers for its OWN creates, and the patrol
  // already folded everything else on the board before it filed them.
  return reconcileDuplicateProposals(repo, board, {
    signal: deps.signal,
    fingerprints: new Set(created.map((p) => p.fingerprint)),
  });
}

// ── the proposal's prose (pure) ──

/** The move as one imperative clause — what the title, the rubric and the Verify section share. */
function moveClause(detection: GardenerDetection): string {
  const subjects = subjectPhrase(detection);
  switch (detection.move) {
    case "reparent":
      return detection.target
        ? `re-parent ${subjects} under ${detection.target}`
        : `re-parent ${subjects} onto a board card`;
    case "link":
      return `record that ${detection.target ?? "its blocker"} blocks ${subjects}`;
    case "retire":
      if (detection.retireAs === "supersede") {
        return `supersede ${subjects} with ${detection.target ?? "the bead that replaced it"}`;
      }
      return detection.retireAs === "defer" ? `defer ${subjects}` : `close ${subjects}`;
    case "reprioritize":
      return `move ${subjects} to ${detection.detail ?? "a different priority"}`;
    case "split":
      return `split ${subjects} into separate tickets`;
    case "unapprove":
      return `fix ${subjects} or withdraw its approval`;
    case "approve":
      return `approve ${subjects} so a run can start on ${pronoun(detection)}`;
  }
}

/** How the subjects read once named — one bead is an "it", several are a "them". */
function pronoun(detection: GardenerDetection): string {
  return detection.subjects.length === 1 ? "it" : "them";
}

/** Ids up to a pair; past that a count, so a cluster's title stays a title. */
function subjectPhrase(detection: GardenerDetection): string {
  return detection.subjects.length <= 2
    ? detection.subjects.join(" and ")
    : `${detection.subjects.length} beads`;
}

/**
 * The state the board is in once the move is applied — the proposal's definition of done. Written as
 * an assertion an approver can check with one `bd show`, not as an instruction to an agent.
 */
function appliedState(detection: GardenerDetection): string {
  const subjects = detection.subjects.join(", ");
  const is = detection.subjects.length === 1 ? "is" : "are";
  switch (detection.move) {
    case "reparent":
      return detection.target
        ? `${subjects} ${is} parented to ${detection.target}`
        : `${subjects} ${is} parented to a board card — a feature, or an epic with no feature children`;
    case "link":
      return `a blocks edge records ${detection.target} → ${subjects}, so ${subjects} leaves the ready set until ${detection.target} lands`;
    case "retire":
      if (detection.retireAs === "supersede") {
        return `${subjects} ${is} closed as superseded by ${detection.target}`;
      }
      return detection.retireAs === "defer"
        ? `${subjects} ${is} deferred — out of the ready set, contract intact`
        : `${subjects} ${is} closed with a reason naming the work that shipped it`;
    case "reprioritize":
      return `${subjects} ${is} at priority ${detection.detail}, so ranked pickup reaches ${detection.subjects.length === 1 ? "it" : "them"} in that order`;
    case "split":
      return `${subjects} ${is} replaced by the separate tickets sketched below, each with its own contract`;
    case "unapprove":
      // Both outcomes are stated, because both settle this ask: repairing the gaps is the OTHER
      // answer, and approving after a repair records that rather than stripping the label off work
      // that is sound again (see apply.ts `planUnapprove`).
      return `${subjects} either meets the approve gate again, or no longer carries \`approved\` — with a note on the bead naming the gaps that withdrew it`;
    case "approve":
      return `${subjects} ${is} approved, so anton starts a run on ${pronoun(detection)} — the approval IS the start`;
  }
}

/** How a MANUAL proposal (see {@link isManualProposal}) tells its reader to settle it. */
const MANUAL_INSTRUCTIONS: Partial<Record<GardenerDetection["move"], string[]>> = {
  reparent: [
    "This bead is a DECISION only a human can make: no single home was obvious, so the proposal",
    "names none and **Approve is refused**. Pick a board card (the Evidence lists what is open",
    "under the container), move it by hand with `bd update <id> --parent <card>`, then DECLINE",
    "this proposal — declining is what settles it and stops the patrol re-asking.",
  ],
  split: [
    "This bead is a DECISION only a human can make: decomposing a ticket writes new contracts, which",
    "is `/shape`'s work, so **Approve is refused**. Run `/shape` (or split it by hand) using the",
    "sketch below as a starting point, then DECLINE this proposal — declining is what settles it and",
    "stops the pass re-asking.",
  ],
};

function acceptanceOf(detection: GardenerDetection): string {
  return [
    `- [ ] ${appliedState(detection)}`,
    "- [ ] no other bead is re-parented, linked, reprioritized, retired, approved or unapproved — the move above is the whole change",
    isManualProposal(detection)
      ? "- [ ] this proposal is DECLINED once the move is made by hand — approving it is refused, so declining is what settles it"
      : "- [ ] this proposal is closed with a note naming what changed",
  ].join("\n");
}

function descriptionOf(detection: GardenerDetection): string {
  return [
    "## Goal",
    detection.summary,
    "",
    "## Evidence",
    ...detection.evidence.map((line) => `- ${line}`),
    "",
    "## Context",
    `Filed by ${PRODUCER[namespaceOf(detection.kind)].filedBy.replace("%kind%", detection.kind)}.`,
    ...(isManualProposal(detection)
      ? (MANUAL_INSTRUCTIONS[detection.move] ?? [])
      : [
          "This bead is a DECISION, not implementation work: approving it applies the move through the",
          "beads seam, declining it records the reason.",
        ]),
    "",
    `- move: \`${detection.move}\`${detection.retireAs ? ` (\`${detection.retireAs}\`)` : ""}`,
    `- subjects: ${detection.subjects.join(", ")}`,
    ...(detection.target ? [`- target: ${detection.target}`] : []),
    ...(detection.detail ? [`- to: ${detection.detail}`] : []),
    `- fingerprint: \`${detection.fingerprint}\` — while this bead is open, or once it is declined,`,
    "  the patrol makes this claim no second time",
    "",
    "## Out of scope",
    "- any board change beyond the move above",
    "- the subjects' own contracts, priorities and labels",
    "- the other proposals this pass filed — each is approved or declined on its own",
    "",
    "## Verify",
    `- after the move, the board shows that ${appliedState(detection)}`,
    `- the next patrol files nothing new for \`${detection.fingerprint}\``,
  ].join("\n");
}
