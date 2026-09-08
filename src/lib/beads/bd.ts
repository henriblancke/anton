/**
 * The single place anton talks to beads (bd). beads is the git-shareable source of truth for
 * work: epics/tickets, and — via labels + external-ref — approval, stage, and the PR link.
 * anton reads/writes here and never duplicates that state in anton.db. See DESIGN.md §3.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProposalBead } from "../gardener/detections";
import { errorText, sleepMs } from "../retry-helpers";
import {
  batchEnabled,
  batchOpArgs,
  BD_BATCH_ENV,
  buildPruneArgs,
  buildUpdateArgs,
  encodeBatchOps,
  isMissingBatchCommand,
  type BatchOp,
  type BeadPatch,
  type PruneAge,
} from "./bd-args";
import { asArray } from "./bd-json";
import { withBeadWriteLock } from "./claim-lock";
import { isPipelineArtifact } from "./contract";
import {
  buildCookArgs,
  parseCookedFormula,
  type CookedFormula,
  type CookOptions,
} from "./cook";
import { bd, type BdExec, type BdOpts } from "./dolt-exec";
import type { SyncOutcome } from "./dolt-sync";
import {
  bdGate,
  bdGateWrite,
  buildGateCheckArgs,
  buildGateCreateArgs,
  buildGateDiscoverArgs,
  parseGateCheck,
  type Gate,
  type GateCheckOpts,
  type GateCheckResult,
  type GateCreateOpts,
  type GatedMolecule,
  type GateDiscoverOpts,
} from "./gate";
import { graphPlanError, type GraphPlan } from "./graph-plan";
import {
  buildLintArgs,
  buildStaleArgs,
  parseDepCycles,
  parseDuplicateGroups,
  parseEpicCloseEligible,
  parseLintReport,
  parseOrphans,
  parseRecomputeBlocked,
  type DepCycle,
  type DuplicateGroup,
  type EpicCloseSweep,
  type LintOpts,
  type LintReport,
  type OrphanBead,
  type StaleOpts,
} from "./hygiene";
import { rankTargets, type RankedTarget } from "./rank";
import { invalidateIssueSnapshot } from "./snapshot";
import { doltSync } from "./sync-coalescer";

// Bead/BeadDep live in the leaf ./types module so snapshot.ts can share them without importing
// bd.ts back (breaking the bd ↔ snapshot cycle, anton-mur). Re-exported here so every existing
// `from ".../beads/bd"` import keeps working.
export type { Bead, BeadComment, BeadDep } from "./types";
import type { Bead } from "./types";

// The dependency types anton may write, validated at the link seam because bd validates nothing
// there (anton-igkb). Re-exported so callers reach the set through the same module as `link`.
export { LINK_TYPES, assertLinkType, isLinkType, type LinkType } from "./link-types";
import { assertLinkType, type LinkType } from "./link-types";

/**
 * The `agent:` VALUE that names no agent — the half {@link labelValueOf}(labels, "agent") returns,
 * as distinct from the whole label {@link LABELS.agentHuman}. Exported because the routing
 * chokepoints read the value, not the label: the active-agents allowlist compares agent ids, and
 * `human` is not one anybody can enable.
 */
export const HUMAN_AGENT = "human";

export const LABELS = {
  approved: "approved",
  stage: (s: "implementing" | "in-review") => `stage:${s}`,
  source: (s: string) => `source:${s}`,
  /**
   * Won't-do outcome (anton-6xj0). beads has no `cancelled` status, so an abandoned bead is
   * `closed` + this label: the history/contract survives (unlike delete) while the label keeps it
   * from reading as shipped (unlike a plain close). Every "was this delivered?" check must consult
   * it — see beads.isAbandoned.
   */
  abandoned: "abandoned",
  /**
   * Work a run reserved but did NOT deliver (anton-67xj): a ticket skipped behind a timed-out one
   * whose partial work was rolled back, or the timed-out ticket itself. Nothing from it is on the
   * run's branch, so it is in no PR — which is exactly what merge finalization cannot see for
   * itself: `bd` has no "this bead is not in that diff" fact, and a still-open child otherwise
   * reads as one the run merely forgot to close. Cleared the moment a run dispatches the ticket
   * again. See beads.isNotDelivered.
   */
  notDelivered: "not-delivered",
  /**
   * Cross-machine run-liveness lease (anton-jz1): `run-lease:<expiresAtEpochMs>[:<ownerRunId>]` on
   * the run target. Present + unexpired ⇒ a run is actively executing this epic on SOME machine, so
   * a Force run started elsewhere must not spawn a second concurrent run. This is the shared
   * (beads/dolt) mirror of the machine-local jobs lease: the `jobs` table is disposable and
   * per-machine, so it can't stop machine B double-running an epic already live on machine A.
   * Heartbeat-refreshed by execute-epic while the run is executing; cleared when the run settles;
   * an EXPIRED lease is ignored so a crashed/killed machine's run is re-triggerable (a stuck
   * `stage:implementing` label alone would otherwise wedge Force run — its whole purpose). The
   * optional `:<ownerRunId>` suffix identifies the publishing run so a resuming handler can tell its
   * OWN crash leftover (safe to sweep) from another machine's live lease (a park condition). See
   * DESIGN.md §3 (state by shareability).
   */
  runLease: (expiresAtMs: number, owner?: string) =>
    owner ? `run-lease:${expiresAtMs}:${owner}` : `run-lease:${expiresAtMs}`,
  /**
   * Latest pre-PR self-review score on a run target (anton-omum): `review-score:<0-10>`. A state
   * label, not a bd custom status — divergent label writes merge clean while divergent status
   * writes hard-wedge Dolt sync (docs/design/2026-07-30-custom-statuses-vs-stage-labels.md).
   * Written prefix-diffed (remove the old value, add the new) in one update like `stage:*`, so the
   * dimension stays single-valued; the full per-round history lives in the append-only score
   * comments beside it.
   */
  reviewScore: (score: number) => `review-score:${score}`,
  /**
   * The one `agent:` value that names no agent (anton-mv70): a person executes this bead — it needs
   * a credential, an account, a purchase, a signature, or a taste call. Every other `agent:<id>`
   * resolves to a specialist prompt, so a human bead left unmarked would dispatch to the DEFAULT
   * agent and burn a run failing at work no agent can do. Written by shaping (skills/bd/SKILL.md),
   * read here by every chokepoint that must refuse it — see {@link beads.isHumanWork}.
   */
  agentHuman: `agent:${HUMAN_AGENT}`,
} as const;

/** Prefix of the run-lease label (see LABELS.runLease). */
const RUN_LEASE_PREFIX = "run-lease:";

/** Prefix of the review-score label (see LABELS.reviewScore). */
const REVIEW_SCORE_PREFIX = "review-score:";

/**
 * Shape of a GitHub PR pointer (`gh-<number>`). The ONLY `external_ref` value anton treats as a PR:
 * the getPrRef fallback honors it until the one-time migration (anton-ftar) moves it to metadata.pr,
 * and that migration clears external_ref ONLY for refs matching this — a tracker URL is left alone.
 */
export const GH_PR_REF = /^gh-\d+$/i;

/**
 * Metadata key holding the PR a send-back retired off a bead (anton-leit) — see
 * {@link beads.retirePrRef}. Deliberately NOT `pr`: nothing may read it as a live pointer.
 */
const RETIRED_PR_KEY = "retiredPr";

/**
 * Parse a `run-lease:<expiry>[:<owner>]` label into its expiry (ms epoch) and optional owner (the
 * publishing run's id, anton-jz1). `expiry` is undefined for a malformed/non-numeric value. A label
 * with no `:<owner>` suffix (legacy format, or a liveness-only publish) parses `owner: undefined`.
 */
function parseRunLease(label: string): { expiry: number | undefined; owner: string | undefined } {
  const rest = label.slice(RUN_LEASE_PREFIX.length);
  const sep = rest.indexOf(":");
  const expStr = sep === -1 ? rest : rest.slice(0, sep);
  const owner = sep === -1 ? undefined : rest.slice(sep + 1) || undefined;
  const n = Number(expStr);
  return { expiry: Number.isFinite(n) ? n : undefined, owner };
}

// ── the seams this module composes (anton-n1m0, anton-ladt, anton-lsad) ──
//
// bd.ts is the single import site for beads state, not the single home of the code behind it. The
// bd spawn lives in ./dolt-exec (HOW one invocation runs), the sync pass and the shared-server
// preflight in ./dolt-sync, the coalescer and sync-status registry in ./sync-coalescer (WHEN a pass
// runs); the pure argv builders, output parsers and refusal readers each sit in the sibling named
// below. None imports this module back, so every seam is testable apart. All of it is re-exported
// here so every existing `from ".../beads/bd"` import keeps working.
export { BD_KILL_GRACE_ENV, BD_MAX_BUFFER_ENV, BD_STEP_TIMEOUT_ENV, BD_STEP_TIMEOUT_MS } from "./dolt-exec";
export { runBdForTest, type BdExec } from "./dolt-exec";
export { isBenignSyncOutput, isFirstPublishPullOutput, isNotWiredOutput } from "./dolt-sync";
export { PREFLIGHT_TTL_MS, preflightSharedServer, resetServerPreflight, runDoltSync } from "./dolt-sync";
export type { SyncMode, SyncOutcome } from "./dolt-sync";
export { getSyncStatus, getSyncStatusToken, SYNC_STALL_MS } from "./sync-coalescer";
export type { SyncRequest, SyncState, SyncStatus } from "./sync-coalescer";
export { BD_BATCH_ENV, batchEnabled, batchOpArgs, encodeBatchOps, quoteBatchValue } from "./bd-args";
export { buildPruneArgs, buildUpdateArgs, isMissingBatchCommand, LABEL_PREFIXES, labelValueOf } from "./bd-args";
export type { BatchOp, BatchUpdateFields, BeadPatch, LabelPrefix, PruneAge } from "./bd-args";
export { isMissingBeadError, unclaimableStatus } from "./bd-errors";
export { buildGateCheckArgs, buildGateCreateArgs, buildGateDiscoverArgs, gateReason, parseGateCheck } from "./gate";
export type { Gate, GateCheckOpts, GateCheckResult, GateCheckScope, GateCreateOpts } from "./gate";
export type { GatedMolecule, GateDiscoverOpts, GateType } from "./gate";
export { buildCookArgs, parseCookedFormula } from "./cook";
export type { CookedFormula, CookedGate, CookedStep, CookMode, CookOptions } from "./cook";
export { buildLintArgs, buildStaleArgs, parseDepCycles, parseDuplicateGroups } from "./hygiene";
export { parseEpicCloseEligible, parseLintReport, parseOrphans, parseRecomputeBlocked } from "./hygiene";
export type { DepCycle, DuplicateGroup, DuplicateMember, EpicCloseCandidate, EpicCloseSweep } from "./hygiene";
export type { LintOpts, LintReport, LintViolation, OrphanBead, StaleOpts, StaleStatus } from "./hygiene";
export type { GraphPlan, GraphPlanNode } from "./graph-plan";

async function bdWrite(cwd: string, args: string[], opts?: BdOpts): Promise<string> {
  const stdout = await bd(cwd, args, opts);
  // Mark the snapshot stale (keeping last-good data) and force a fresh post-write read, so the
  // next board read never blocks on a cold `bd list` queued behind the Dolt lock.
  invalidateIssueSnapshot(cwd, true);
  return stdout;
}

// ── the claimable set + the verified claim (anton-9anc) ──
//
// ONE definition of "what any worker may claim" and "how a claim becomes trustworthy", so a second
// anton, a headless job, and a plain Claude Code session on another machine all pick up the same
// work in the same order and never both believe they hold it. Everything else (the runner's pickup,
// the ready-count nudge, board ordering) consumes this rather than re-deriving the rule.

/** A bead's claim holder, normalized — blank/whitespace assignee means unclaimed. */
export const ownerOf = (b: Bead | undefined): string | undefined => b?.assignee?.trim() || undefined;

/**
 * A claimable run target plus the facts it was ranked on. The shape and the order both come from
 * `./rank` — the PRIME order is the SAME order the picker and an external `bd` worker follow, so
 * there is one definition of it and this module composes it (see {@link rankClaimableTargets}).
 */
export type ClaimableTarget = RankedTarget;

/**
 * The claimable POOL query: every approved, unclaimed bead bd itself considers ready — its
 * blocker-aware `GetReadyWork` semantics, which also drop in_progress/blocked/deferred/hooked work.
 * Readiness is bd's to answer and is deliberately not re-derived here; anton only narrows the answer
 * (see {@link rankClaimableTargets}).
 *
 * Deliberately WITHOUT `--type feature`, which the shaped ticket named: bd's `-t/--type` takes ONE
 * type (verified on bd 1.1.2) while the claimable set spans features, parentless task/bug
 * epics-of-one, and legacy childless epics — so a per-type argv would cost three spawns whose
 * results couldn't even be read as one consistent board. The type split happens in-process against
 * the board read {@link beads.claimableTargets} needs anyway for parentage and `blocks` edges.
 */
export function buildClaimableReadyArgs(): string[] {
  return ["ready", "--label", LABELS.approved, "--unassigned", "--json", "--limit", "0"];
}

/**
 * May a worker claim this bead and run it? The anton-side half of the claimable rule, applied to a
 * bead bd already reported as ready:
 *   - `open` — a claimed/closed/deferred bead is somebody's or nobody's work, never free work.
 *   - `approved` — the human gate. execute-epic poisons an unapproved target, so a set that
 *     included one would name work anton refuses to run.
 *   - unassigned — a claim already held is not up for grabs, even when bd's `--unassigned` filter
 *     wasn't the source of this pool.
 *   - {@link beads.isRunTarget} — the SAME predicate the approve route and the runner gate on, so
 *     the claimable set can never disagree with what anton will actually execute. That is what
 *     keeps container epics (their features each run on their own) and child tickets (executed as
 *     part of their target's run, never distributed) out of the set.
 *   - not {@link isProposalBead} — a proposal is a DECISION about the board, not work on it. It is
 *     shaped as a parentless task carrying a full contract, so every other clause here admits it,
 *     and a worker that claimed one would dispatch an agent to "implement" a board move anton
 *     applies itself on approval. The picker refuses one for the same reason (picker-targets.ts);
 *     this is the same rule for the workers that never see the picker — a human following
 *     `.beads/PRIME.md` and a second anton read this set instead.
 *   - not {@link beads.isHumanWork} — `agent:human` names the one specialist anton does not have,
 *     so a claimed human target would dispatch to the DEFAULT agent and burn a run failing at work
 *     no agent can do. It is approved work waiting for a person, not backlog: leaving it in the set
 *     is the hazard, leaving it on the board is the point.
 *
 * The human exclusion belongs here rather than in {@link buildClaimableReadyArgs}: bd's own
 * `--exclude-label` would move it into the argv every external worker copies, where it could drift
 * from this rule; the board read this narrowing already holds answers it for free.
 */
function isClaimable(b: Bead, board: Bead[]): boolean {
  return (
    b.status === "open" &&
    beads.isApproved(b) &&
    !ownerOf(b) &&
    beads.isRunTarget(b, board) &&
    !isProposalBead(b) &&
    !beads.isHumanWork(b)
  );
}

/**
 * Narrow bd's ready pool to the claimable run targets and RANK them in the PRIME order
 * ({@link rankTargets}). Pure over its input — no bd spawn — so the rule is testable against
 * fixture boards and reusable by any caller that already holds a board.
 *
 * `pool` is bd's blocker-aware ready answer; `board` is the full `--status all` list, which supplies
 * the parentage, `blocks` edges and feature children the narrowing and the unblocking count need.
 */
export function rankClaimableTargets(pool: Bead[], board: Bead[]): ClaimableTarget[] {
  return rankTargets(
    pool.filter((b) => isClaimable(b, board)),
    board,
  );
}

/**
 * Propagation window a verified claim settles for before it trusts its own read. Reused verbatim
 * from the run-lease arbitration (execute-epic's RUN_LEASE_SETTLE_MS): concluding "we hold it" from
 * seeing only our own assignee is a decision made on the ABSENCE of a rival claim, and absence is
 * unreliable on an eventually-consistent board — a machine that claimed the same instant may not
 * have propagated yet. Comfortably above sync round-trip latency, far below any run's lifetime.
 */
export const CLAIM_SETTLE_MS = 2_000;

/**
 * The verdict of {@link beads.claimVerified}. `lost` is a VALUE, not an exception: losing a race is
 * the protocol working, and a pickup loop must be able to move to the next target without a
 * try/catch — and `lost` with an undefined `owner` means the bead read back unassigned, so it is
 * neither ours nor anyone else's and retrying it is safe. `unverified` is the fail-closed answer —
 * the claim could not be proven, so the caller must NOT run the target; it may retry (a same-actor
 * claim is idempotent). `stale` is the claim we WON on work that left the claimable set while we
 * settled — ours on paper, not runnable: a retry can only reach the same verdict, and the local
 * claim is the caller's to release.
 */
export type ClaimVerification =
  | { ok: true; bead: Bead }
  | { ok: false; reason: "lost"; owner: string | undefined }
  | { ok: false; reason: "stale"; detail: string; bead: Bead }
  | { ok: false; reason: "unverified"; detail: string };

/** The seam a verified claim drives, injectable so tests can interleave claimers without a board. */
export interface ClaimVerifiedDeps {
  pull?: (cwd: string) => Promise<unknown>;
  push?: (cwd: string) => Promise<SyncOutcome>;
  claim?: (cwd: string, id: string, actor: string) => Promise<unknown>;
  show?: (cwd: string, id: string) => Promise<Bead>;
  /** Fresh `--status all` board, for the post-settle re-validation (see {@link staleClaimReason}). */
  board?: (cwd: string) => Promise<Bead[]>;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/**
 * Why this target is no longer runnable, or undefined when it still is — the post-settle half of
 * {@link isClaimable}, applied to the bead WE now hold (anton-9anc review).
 *
 * Owning the assignee proves the race was won, not that the prize is still worth having: another
 * machine can close or abandon the target, drop `approved`, or land a feature under a legacy epic
 * (turning it into a container) inside the very settle window this protocol waits out. Re-asserting
 * the rest of the claimable rule against a FRESH board is what keeps a verified claim from licensing
 * a run the claimable set would refuse.
 *
 * The assignee/`open` legs of {@link isClaimable} are deliberately NOT re-checked: `bd update
 * --claim` has by now made us the assignee and flipped the status to in_progress, so both would
 * reject the very claim they were meant to confirm.
 */
export function staleClaimReason(bead: Bead, board: Bead[]): string | undefined {
  if (beads.isAbandoned(bead)) return "the target was abandoned while the claim settled";
  if (bead.status !== "open" && bead.status !== "in_progress") {
    return `the target is ${bead.status} — no longer runnable work`;
  }
  if (!beads.isApproved(bead)) return "approval was withdrawn while the claim settled";
  if (!beads.isRunTarget(bead, board)) {
    return "the target is no longer a run target (a container epic or a child ticket)";
  }
  if (beads.isHumanWork(bead)) {
    return `the target was labelled ${LABELS.agentHuman} while the claim settled — a person executes it, no agent can`;
  }
  return undefined;
}

/**
 * Claim `id` for `actor` and prove the claim held — the write half of the cross-machine pickup
 * protocol (anton-9anc). See {@link beads.claimVerified} for the contract; this is the body, split
 * out so the whole sequence is one readable unit.
 */
async function runClaimVerified(
  cwd: string,
  id: string,
  actor: string,
  deps: ClaimVerifiedDeps,
): Promise<ClaimVerification> {
  const pull = deps.pull ?? beads.pull;
  const push = deps.push ?? beads.push;
  const claim = deps.claim ?? beads.claim;
  const show = deps.show ?? beads.show;
  const readBoard = deps.board ?? ((c: string) => beads.list(c, ["--status", "all"]));
  const sleep = deps.sleep ?? sleepMs;
  const settleMs = deps.settleMs ?? CLAIM_SETTLE_MS;
  const unverified = (detail: string): ClaimVerification => ({
    ok: false,
    reason: "unverified",
    detail: `${id}: ${detail}`,
  });

  // 1. Pull first, so a claim another machine already published is visible locally — bd's own
  //    `--claim` then refuses ours outright, and we lose cheaply without writing anything.
  try {
    await pull(cwd);
  } catch (e) {
    return unverified(`could not refresh the board before claiming (${errorText(e)})`);
  }

  // 2. Claim. `bd update --claim` is the atomic local compare-and-swap (it refuses a bead already
  //    claimed by someone else and is idempotent for the same actor), so no read-then-write CAS is
  //    re-implemented here. On refusal, read the board for the holder rather than parsing bd's
  //    message: the assignee IS the evidence, and it can't rot the way an error string can.
  try {
    await claim(cwd, id, actor);
  } catch (e) {
    const current = await show(cwd, id).catch(() => null);
    const holder = ownerOf(current ?? undefined);
    if (current && holder && holder !== actor) return { ok: false, reason: "lost", owner: holder };
    return unverified(`bd refused the claim (${errorText(e)})`);
  }

  // 3. Publish it. A claim no other machine can see is not a claim; if the push fails we cannot
  //    prove we hold it, so we fail closed. The local claim stands and a retry re-claims idempotently.
  let outcome: SyncOutcome;
  try {
    outcome = await push(cwd);
  } catch (e) {
    return unverified(`claimed locally but could not publish the claim (${errorText(e)})`);
  }

  // 4/5. Settle, then re-pull — but only when there is a remote at all. A not-wired board has no
  //      second machine to race, so waiting out a propagation window it can't have would stall every
  //      single-machine pickup for nothing.
  // Only a real remote sync needs a settle window. A not-wired board has no second machine to
  // race; a shared server has no propagation delay at all — the claim was visible to every other
  // machine the moment it committed, so waiting would slow every pickup for nothing (anton-0tul).
  if (outcome === "synced") {
    await sleep(settleMs);
    try {
      await pull(cwd);
    } catch (e) {
      return unverified(`could not re-read the board to verify the claim (${errorText(e)})`);
    }
  }

  // 6. Assert the assignee. This is the only step that makes the claim trustworthy: after the merge
  //    of two concurrent claims exactly one actor survives on the bead, and a worker may run only if
  //    that actor is itself. A `lost` with NO owner is the bead reading back unassigned — our claim
  //    did not survive the merge, so it is not ours to run, but nobody else holds it either: the
  //    target may simply be free again, and re-claiming it is safe (a same-actor claim is idempotent).
  const verified = await show(cwd, id).catch(() => null);
  if (!verified) return unverified("could not re-read the bead to verify the claim");
  const owner = ownerOf(verified);
  if (owner !== actor) return { ok: false, reason: "lost", owner };

  // 7. Re-assert the REST of the claimable rule against a fresh board. Winning the assignee proves
  //    the race, not that the target is still work anton may run — see staleClaimReason. The board
  //    read is the same `--status all` list claimableTargets narrows, so the two can't disagree.
  let board: Bead[];
  try {
    board = await readBoard(cwd);
  } catch (e) {
    return unverified(`could not re-read the board to re-validate the target (${errorText(e)})`);
  }
  // Judge the BOARD's copy when it has one: `bd list` is the read the claimable rule was written
  // against (it carries parentage the way isRunTarget expects), so judging it keeps this verdict and
  // claimableTargets from disagreeing on the same bead. `show`'s copy stays the assignee evidence.
  const onBoard = board.find((b) => b.id === id) ?? verified;
  const stale = staleClaimReason(onBoard, board);
  return stale
    ? { ok: false, reason: "stale", detail: `${id}: ${stale}`, bead: verified }
    : { ok: true, bead: verified };
}

/**
 * Every issue type a run target can have. NECESSARY, not sufficient — the structural clauses in
 * {@link beads.isRunTarget} still decide (a container epic and a parented task are both out) — but
 * a type absent here can never be started, whatever its shape. Exported so anything that has to
 * name the runnable vocabulary without a board in hand (the policy calibration fallback) reads it
 * from the predicate rather than restating it: a `chore` fallback would propose work no pass can
 * ever admit.
 */
export const RUN_TARGET_TYPES = ["feature", "epic", "task", "bug"] as const;
export type RunTargetType = (typeof RUN_TARGET_TYPES)[number];

const isRunTargetType = (t: string | undefined): t is RunTargetType =>
  RUN_TARGET_TYPES.includes(t as RunTargetType);

export const beads = {
  /**
   * Truly claimable work (excludes in_progress/blocked/deferred). `--limit 0` = unlimited:
   * `bd ready` (like `bd list`) defaults to 50 results, which would silently drop work in a
   * repo with a large ready queue.
   */
  ready: (cwd: string) => bd(cwd, ["ready", "--json", "--limit", "0"]).then(asArray<Bead>),

  // ── gates (anton-uk95) ── every call spawns in `repo`, never with `-C`; see bdGate above.

  /**
   * Create a gate that blocks `opts.blocks` until it resolves; returns the gate bead's id. A
   * `gh:run`/`gh:pr` gate created here is later evaluated against THIS repo, because that is the
   * cwd its check runs in.
   */
  async gateCreate(repo: string, opts: GateCreateOpts): Promise<string> {
    const out = await bdGateWrite(repo, buildGateCreateArgs(opts));
    const parsed = JSON.parse(out);
    const gate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!gate?.id) throw new Error("bd gate create: could not parse gate id from output");
    return gate.id as string;
  },

  /**
   * Evaluate this repo's open gates and close the satisfied ones. The GitHub verdicts come from a
   * `gh` subprocess that resolves its repository from the cwd this spawns in — which is why the
   * project repo is a required argument and `-C` is never used.
   *
   * Callers MUST branch on `errors`: an un-evaluatable gate is unknown, not unresolved (see
   * {@link GateCheckResult}).
   */
  gateCheck: (repo: string, opts: GateCheckOpts = {}): Promise<GateCheckResult> =>
    (opts.dryRun ? bdGate : bdGateWrite)(repo, buildGateCheckArgs(opts)).then(parseGateCheck),

  /** Manually resolve (close) a gate — the human-gate path, and the operator override for the rest. */
  gateResolve: (repo: string, id: string, reason?: string) =>
    bdGateWrite(repo, ["gate", "resolve", id, ...(reason ? ["--reason", reason] : [])]),

  /**
   * This repo's gates — open only by default, `all` to include resolved ones. `--limit 0`
   * (unlimited) for the same reason `list` passes it: bd's default 50 would silently truncate.
   */
  gateList: (repo: string, opts: { all?: boolean } = {}): Promise<Gate[]> =>
    bdGate(repo, [
      "gate",
      "list",
      "--json",
      "--limit",
      "0",
      ...(opts.all ? ["--all"] : []),
    ]).then(asArray<Gate>),

  /**
   * Fill in the `await_id` of `gh:run` gates created before their workflow run existed, by matching
   * recent runs on branch/SHA/time. Its candidate runs come from the cwd repo's GitHub remote, so it
   * carries the same cwd rule as `gateCheck` — run from the wrong directory it matches another
   * project's runs. Returns bd's human summary: at bd 1.1.2 `gate discover` emits no JSON.
   */
  gateDiscover: (repo: string, opts: GateDiscoverOpts = {}): Promise<string> =>
    (opts.dryRun ? bdGate : bdGateWrite)(repo, buildGateDiscoverArgs(opts)),

  /**
   * A `gh:pr` gate — the merge wait anton arms on a run target when it opens that target's PR
   * (anton-k0kj). It is the ONE gate flavour anton creates on work it runs, and it is deliberately
   * NOT a prerequisite: it awaits the target's OWN pull request, so every "what blocks this bead?"
   * computation skips it (see epic-graph). Anything else would make an in-review target read as
   * blocked by itself and refuse the recovery run its closed-unmerged PR needs.
   *
   * `await_type` lives on {@link Gate}, and gate beads reach a board read through
   * `bd list --type gate` (loadAllIssues), which carries the field — so the cast is the seam's, not
   * a caller's.
   */
  isMergeWaitGate: (b: Bead): b is Gate =>
    b.issue_type === "gate" && (b as Gate).await_type === "gh:pr",

  /**
   * A `human` gate — the wait anton arms on a run target whose agent reported `needs-human`
   * (anton-287p). The opposite of the merge wait in every way that matters here: it IS a real
   * blocker (epic-graph counts it, so nothing re-runs the target behind it), and NOTHING closes it
   * on its own — `bd gate check` never evaluates it and gate-check's expiry pass skips it — so it
   * ends only when a person runs `bd gate resolve`.
   */
  isHumanGate: (b: Bead): b is Gate =>
    b.issue_type === "gate" && (b as Gate).await_type === "human",

  /**
   * Molecules whose gate has closed and whose next step is runnable — the gate-resume discovery
   * call. It is `bd ready --gated`, NOT `bd mol ready --gated`: that form errors with "unknown flag:
   * --gated" on both 1.1.0 and 1.1.2 (contradicting its own usage line), and bare `bd mol ready`
   * lists EVERY ready molecule step, so it is not a substitute.
   *
   * PARENTED BEADS ONLY (measured on 1.1.0 and 1.1.2, anton-k0kj): bd reports a gated bead here
   * only when it HAS a parent — which it names as the `molecule_id`, molecule or not. A gate hung on
   * a PARENTLESS bead (a standalone task/bug run target, a top-level feature, the target a run's own
   * `gh:pr` merge gate blocks) never appears, before or after it closes: that bead simply returns to
   * ordinary `bd ready`, which nothing in anton polls. So both board-derived halves of gate-check —
   * the merge finalization and `plainGateResumes` — exist because this call cannot see them.
   */
  readyGated: (repo: string): Promise<GatedMolecule[]> =>
    bdGate(repo, ["ready", "--gated", "--json", "--limit", "0"]).then(asArray<GatedMolecule>),

  /**
   * ONE call for the whole board: `bd list --json` carries each issue's `parent` and inline
   * `dependencies`, so grouping + edges are derived in-process — no per-epic/per-ticket spawns.
   * Reads the Dolt working set (reliable), unlike the JSONL export which lags uncommitted writes.
   *
   * `--limit 0` (unlimited) is REQUIRED: `bd list` defaults to 50 results, so without it a repo
   * with >50 issues returns a truncated slice — epics show only the children that happened to
   * land in the window (wrong ticket counts + wrong completion), and the autonomous jobs operate
   * on partial data. Callers may still override by passing their own `--limit` in `extra`.
   */
  list: (cwd: string, extra: string[] = []) =>
    bd(cwd, ["list", "--json", "--limit", "0", ...extra]).then(asArray<Bead>),

  show: async (cwd: string, id: string): Promise<Bead> => {
    // Count-only `bd show --json` (bd 1.1.0): deliberately WITHOUT --include-comments /
    // --include-dependents, so it returns the bead's fields + dependency counts without streaming
    // full comment/dependent bodies (slow on hub beads). anton's callers only need the bead itself
    // and its counts here; opt into hydration explicitly at the (rare) call site that needs it.
    // `bd show --json` returns an array (one or more issues), not an object.
    const parsed = JSON.parse(await bd(cwd, ["show", id, "--json"]));
    if (Array.isArray(parsed)) return parsed[0];
    return parsed.issue ?? parsed;
  },

  /**
   * The bead WITH its comment thread hydrated (`--include-comments`) — the explicit opt-in
   * {@link beads.show} deliberately withholds, because streaming comment bodies is slow on a hub
   * bead and nothing else needs them.
   *
   * One caller today: the review report (lib/review-report.ts), which replays the per-round score
   * comments a finished self-review appended to the run target. bd omits `comments` entirely on a
   * bead that has none, so the field is normalized to `[]` here — a reader must not have to tell
   * "no comments" from "the read didn't carry them".
   */
  showWithComments: async (cwd: string, id: string): Promise<Bead> => {
    const parsed = JSON.parse(await bd(cwd, ["show", id, "--json", "--include-comments"]));
    const bead: Bead = Array.isArray(parsed) ? parsed[0] : (parsed.issue ?? parsed);
    return { ...bead, comments: bead?.comments ?? [] };
  },

  /** Pure argv builder for cook, exposed for testing (see buildUpdateArgs). */
  buildCookArgs,

  /**
   * Resolve a formula into its steps (`bd cook`, anton-brdg) — the ONLY place anton shells a formula
   * verb. `formula` is a path to a `.formula.{toml,json}` or a bare name bd resolves through its
   * search paths (`.beads/formulas/` first). Returns the typed pipeline; callers never parse stdout.
   *
   * A cook failure (unreadable file, unknown key, a runtime cook missing a variable) rejects with
   * {@link bd}'s error, whose message already carries the full argv — formula path included — and
   * bd's stderr, so a park message can name the file without this wrapper reformatting it.
   *
   * `exec` is injectable for tests, like {@link runDoltSync}; production passes none, so every cook
   * goes through the same bounded, process-group-reaped spawn as the rest of the seam.
   */
  cook: async (
    cwd: string,
    formula: string,
    opts: CookOptions = {},
    exec: BdExec = bd,
  ): Promise<CookedFormula> => {
    const out = await exec(cwd, buildCookArgs(formula, opts));
    return parseCookedFormula(out, formula);
  },

  /** All parent-child + blocks + related edges among the given beads, from inline `dependencies`. */
  edgesOf(beads: Bead[]): Array<{ from: string; to: string; type: string }> {
    const out: Array<{ from: string; to: string; type: string }> = [];
    for (const b of beads) {
      for (const d of b.dependencies ?? []) {
        if (d?.issue_id && d?.depends_on_id && d?.type) {
          out.push({ from: d.issue_id, to: d.depends_on_id, type: d.type });
        }
      }
    }
    return out;
  },

  /** Create a bead; returns its id (bd prints the id on the last line). */
  async create(
    cwd: string,
    opts: {
      title: string;
      type: "epic" | "feature" | "task" | "bug" | "chore";
      acceptance?: string;
      context?: string;
      description?: string; // the whole contract markdown (Goal / Acceptance / Context / …)
      labels?: string[]; // e.g. ["area:reports", "domain:eng"] — set at create time, not patched after
      deps?: string[]; // e.g. ["parent-child:bd-100"]
      /**
       * Custom metadata, set in the SAME write as the bead (`bd create --metadata <json>`) rather
       * than patched after: a bead whose machine-readable payload arrives in a second write has a
       * window in which it exists without it, and a reader that lands there can only guess. Nested
       * objects round-trip through `bd show --json` and `bd list --json` (measured on 1.1.2), which
       * is what lets a gardener proposal carry its move as data instead of prose (anton-1t3n).
       */
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    const args = ["create", opts.title, "--type", opts.type];
    if (opts.acceptance) args.push("--acceptance", opts.acceptance);
    if (opts.context) args.push("--context", opts.context);
    // `bd tag` takes one label per call, so the whole set goes on the create (skills/bd/SKILL.md).
    if (opts.labels?.length) args.push("--labels", opts.labels.join(","));
    if (opts.deps?.length) args.push("--deps", opts.deps.join(","));
    if (opts.description) args.push("--description", opts.description);
    if (opts.metadata) args.push("--metadata", JSON.stringify(opts.metadata));
    args.push("--json"); // plain output appends tips/status lines after the id; JSON is clean
    const out = await bdWrite(cwd, args);
    const parsed = JSON.parse(out);
    const bead = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!bead?.id) throw new Error("bd create: could not parse bead id from output");
    return bead.id as string;
  },

  /**
   * Create a whole tree in ONE bd write (`bd create --graph`), answering plan key → real bead id.
   *
   * This is the atomic form, and therefore the only correct one for a multi-bead write. N sequential
   * {@link beads.create} calls fail halfway and strand whatever already landed (skills/bd/SKILL.md):
   * the retry then renumbers around the orphans instead of replacing them. Measured on bd 1.1.2, a
   * plan that fails MID-write — a `parent_id` the board does not hold, so the failure comes after the
   * first node — rolls the whole plan back and leaves the board byte-identical; up-front schema
   * faults (an unknown `type`) never reach a write at all. Both mean the same thing to a caller: a
   * rejection here created nothing, so the retry is the unchanged plan.
   *
   * bd reads the plan from a FILE, not stdin, so one is written to a private temp dir and removed
   * whatever the outcome — a plan carries the founder's draft prose, which has no business outliving
   * the call in `$TMPDIR`.
   *
   * Every planned key is asserted present in the answer: bd drops an unknown node field with only a
   * warning, and a schema that drifts under us must fail loud here rather than hand back an id map
   * with a hole in it that a caller would read as `undefined`.
   */
  async createGraph(cwd: string, plan: GraphPlan): Promise<Record<string, string>> {
    const dir = mkdtempSync(join(tmpdir(), "anton-bd-graph-"));
    try {
      const file = join(dir, "plan.json");
      writeFileSync(file, JSON.stringify(plan));
      const out = await bdWrite(cwd, ["create", "--graph", file, "--json"]).catch((err: unknown) => {
        const reason = graphPlanError(err) ?? (err as Error).message;
        throw new Error(`bd create --graph: ${reason}`);
      });
      const ids = (JSON.parse(out) as { ids?: Record<string, string> }).ids ?? {};
      const missing = plan.nodes.filter((n) => !ids[n.key]).map((n) => n.key);
      if (missing.length > 0) {
        throw new Error(`bd create --graph: no id came back for node(s) ${missing.join(", ")}`);
      }
      return ids;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // `bd tag` takes a single label; use the repeatable --add-label/--remove-label instead.
  tag: (cwd: string, id: string, labels: string[]) =>
    bdWrite(cwd, ["update", id, ...labels.flatMap((l) => ["--add-label", l])]),
  untag: (cwd: string, id: string, labels: string[]) =>
    bdWrite(cwd, ["update", id, ...labels.flatMap((l) => ["--remove-label", l])]),

  /**
   * Write one dependency edge, `type` validated HERE because bd will not validate it (anton-igkb):
   * `--type` is free text, and every value but `blocks`/`conditional-blocks` yields a non-blocking
   * edge with no error — see {@link assertLinkType}. The runtime check backs the compile-time type:
   * an edge type that arrives as data (a gardener plan, a JSON payload) never sees the type checker.
   *
   * `async` so a refused type REJECTS rather than throwing synchronously — every other verb here
   * fails as a rejection, and a caller's `.catch()` must not be bypassed by where the failure came
   * from. `exec` is injectable for tests, like {@link beads.cook}, which is what lets the guard be
   * proven to reject BEFORE a spawn rather than after one.
   */
  link: async (cwd: string, a: string, b: string, type: LinkType, exec: BdExec = bdWrite) => {
    assertLinkType(type);
    return exec(cwd, ["link", a, b, "--type", type]);
  },

  /**
   * Take a dependency edge back — the exact undo of {@link beads.link}, which is why the argument
   * order is identical: `bd link a b` and `bd dep remove a b` both read "a depends on b".
   *
   * bd holds ONE edge per directed pair whatever its type (anton-wsap), so this removes whichever
   * edge that pair carries rather than only a `blocks` one — a caller that wants a specific type
   * gone must know it is the one there. The one write that makes an anton-drawn ordering reversible
   * (gardener/repair-dep-missing.ts): an edge nothing can un-draw is a board fact anton may not
   * record on its own judgement.
   */
  unlink: (cwd: string, a: string, b: string) => bdWrite(cwd, ["dep", "remove", a, b]),

  /**
   * Move a bead under a new parent (`bd update --parent`), or — with an empty `parentId` — detach
   * it entirely, which is bd's own clear-the-field form and therefore the undo of a re-parent that
   * has to be rolled back (see gardener/apply.ts). One write per bead: bd's batch grammar has no
   * parent key, so a multi-bead regroup is N writes and the caller owns their atomicity.
   */
  reparent: (cwd: string, id: string, parentId: string) =>
    bdWrite(cwd, ["update", id, "--parent", parentId]),

  /**
   * Close a bead as SUPERSEDED by another (`bd supersede <id> --with <replacement>`) — closed, plus
   * a `supersedes` edge naming where the work actually landed. Distinct from a plain close, whose
   * reason is prose: the survivor's id is the record, so a reader following the graph finds it
   * without parsing anything.
   */
  supersede: (cwd: string, id: string, replacementId: string) =>
    bdWrite(cwd, ["supersede", id, "--with", replacementId]),

  /** Attach the PR to the bead as its external reference (git-shareable). */
  setExternalRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--external-ref", ref]),

  /**
   * Write the PR pointer to `metadata.pr` — the single seam anton uses for the PR link (anton-is7x).
   * Keeping it out of `external_ref` frees that field for tracker integrations; every read goes
   * through getPrRef, every write through here, so no call site touches `external_ref` for PRs.
   *
   * Any RETIRED pointer ({@link retirePrRef}) is dropped in the same write: that key exists only to
   * name the PR a bead no longer points at, so a live pointer makes it stale by definition — and
   * leaving both would have two channels answering "which PR is this bead's?".
   */
  setPrRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--set-metadata", `pr=${ref}`, "--unset-metadata", RETIRED_PR_KEY]),

  /**
   * Read a bead's PR pointer through the seam (anton-is7x). `metadata.pr` is authoritative; until the
   * one-time migration (anton-ftar) moves legacy pointers over, a `gh-*` `external_ref` is honored as
   * a fallback. A NON-`gh-` `external_ref` (e.g. a tracker URL) is deliberately ignored — external_ref
   * is no longer the PR channel, so a tracker link there must never read as a PR / in-review.
   */
  getPrRef: (b: Bead): string | undefined => {
    const pr = b.metadata?.pr;
    if (typeof pr === "string" && pr) return pr;
    const ref = b.external_ref;
    return ref && GH_PR_REF.test(ref) ? ref : undefined;
  },

  /**
   * RETIRE a bead's PR pointer (anton-leit): the live pointer comes off and the same PR lands on
   * `metadata.retiredPr`, in ONE atomic `bd update`. What a send-back does to a target it is putting
   * back in front of a runner — the bead must stop reading as in-review (every surface derives that
   * from {@link getPrRef}, and execute-epic's step 0a finishes an attempt on it), while the PR it
   * just came off stays reachable from the bead: that link is the only way a later reader — or
   * {@link getRetiredPrRef}'s callers — can tell a target whose PR merged after the retire from one
   * that never had a PR at all.
   *
   * Both live channels are cleared, because {@link getPrRef} reads both: unsetting `metadata.pr`
   * alone would leave a legacy `gh-*` external_ref readable and the bead would still look in-review.
   * A NON-`gh-` external_ref (a tracker URL) is left untouched for the same reason getPrRef ignores
   * it. Takes the bead rather than an id because that decision is a property of its current state.
   */
  retirePrRef: (cwd: string, bead: Bead, ref: string) =>
    bdWrite(cwd, [
      "update",
      bead.id,
      "--unset-metadata",
      "pr",
      "--set-metadata",
      `${RETIRED_PR_KEY}=${ref}`,
      ...(bead.external_ref && GH_PR_REF.test(bead.external_ref) ? ["--external-ref", ""] : []),
    ]),

  /**
   * The PR a send-back retired off this bead ({@link retirePrRef}), if any. Never a live pointer —
   * {@link setPrRef} drops this key — so a reader that wants "the PR this bead is in review on"
   * must keep asking {@link getPrRef}, and this answers the different question: "which PR did the
   * run that finished this bead open, before the send-back put it back to work?"
   */
  getRetiredPrRef: (b: Bead): string | undefined => {
    const pr = b.metadata?.[RETIRED_PR_KEY];
    return typeof pr === "string" && pr ? pr : undefined;
  },

  /**
   * One-time cutover primitive (anton-ftar): move a legacy `gh-*` external_ref onto `metadata.pr`
   * and clear external_ref in a SINGLE atomic `bd update` — no partial state to recover from. Only
   * ever called for gh- shaped refs (see planPrRefMigration), so a tracker URL in external_ref is
   * never touched. `--external-ref ""` is bd's clear-the-field form (like `--defer ""`).
   */
  migratePrRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--set-metadata", `pr=${ref}`, "--external-ref", ""]),

  /**
   * Append to a bead's notes blob (`bd note`). `actor` attributes the write in bd's audit trail —
   * pass it for a human note so the entry isn't stamped with whatever unix user the server runs
   * as; anton's own job notes leave it unset. The visible authorship a reader sees comes from the
   * note header itself (see beads/notes.ts), not from bd.
   */
  note: (cwd: string, id: string, text: string, actor?: string) =>
    bdWrite(cwd, ["note", id, text], actor ? { env: { BEADS_ACTOR: actor } } : undefined),

  /**
   * Append an entry to a bead's comment thread (`bd comment`). Unlike {@link note} — one blob that
   * later writes edit around — comments are append-only and individually timestamped, which is what
   * makes them the home for a history a reader replays in order (the per-round review scores,
   * anton-omum).
   */
  comment: (cwd: string, id: string, text: string) => bdWrite(cwd, ["comment", id, text]),

  /** The bead's existing `review-score:*` labels — the stale set {@link setReviewScore} replaces. */
  reviewScoreLabels: (b: Bead): string[] =>
    (b.labels ?? []).filter((l) => l.startsWith(REVIEW_SCORE_PREFIX)),

  /**
   * Publish the latest review score as a state label in ONE update: drop every prior
   * `review-score:*` (pass them as `stale`) and add the new value, so the prefix stays
   * single-valued the way `stage:*` does.
   */
  setReviewScore: (cwd: string, id: string, score: number, stale: string[] = []) =>
    bdWrite(cwd, [
      "update",
      id,
      ...stale.flatMap((l) => ["--remove-label", l]),
      "--add-label",
      LABELS.reviewScore(score),
    ]),

  /**
   * Close a bead as DONE. `reason` is bd's own close reason — the durable record of what settled it,
   * which a plain close leaves blank. Deliberately NOT the abandon path: a reason here describes
   * work that landed, while a won't-do outcome goes through {@link beads.abandon}, which also labels
   * the bead so nothing downstream reads it as shipped.
   */
  close: (cwd: string, id: string, reason?: string) =>
    bdWrite(cwd, ["close", id, ...(reason?.trim() ? ["--reason", reason.trim()] : [])]),

  /**
   * Apply several board writes as ONE `bd batch` transaction (anton-aijz): every op lands or none
   * does, so a mid-flight failure leaves each bead in its prior state instead of stranding a
   * half-closed unit. Empty ops spawn nothing.
   *
   * Rejects on a real failure — with the batch already rolled back, so the caller's retry starts
   * from the state it expected. The ONE tolerated failure is a bd with no `batch` subcommand: those
   * ops are re-applied sequentially (loudly, since that path is not atomic), which is also what
   * `ANTON_BD_BATCH=0` selects up front.
   */
  batch: async (cwd: string, ops: BatchOp[]): Promise<void> => {
    if (ops.length === 0) return;
    if (batchEnabled()) {
      try {
        await bdWrite(cwd, ["batch", "--json"], { stdin: encodeBatchOps(ops) });
        return;
      } catch (e) {
        if (!isMissingBatchCommand(e)) throw e;
        console.warn(
          `[beads.batch] this bd has no 'batch' subcommand — applying ${ops.length} writes ` +
            `sequentially, which is NOT all-or-nothing. Upgrade bd, or set ${BD_BATCH_ENV}=0 to ` +
            `choose the sequential path deliberately and silence this.`,
        );
      }
    }
    for (const op of ops) await bdWrite(cwd, batchOpArgs(op));
  },

  /**
   * Permanently delete a bead and clean up references (`bd delete --force`). `cascade` also
   * deletes every dependent recursively — used for epics so their child tickets go with them;
   * without it, deleting an issue that still has dependents fails. This is irreversible.
   */
  delete: (cwd: string, id: string, opts: { cascade?: boolean } = {}) =>
    bdWrite(cwd, ["delete", id, "--force", ...(opts.cascade ? ["--cascade"] : [])]),

  /** Pure argv builder for prune, exposed for testing (see buildUpdateArgs). */
  buildPruneArgs,

  /**
   * Prune piled-up closed beads (`bd prune`, anton-uobe) — permanent deletion of closed,
   * non-ephemeral, non-pinned beads only; open/in_progress beads are never touched (bd itself
   * guarantees this — never weaken it here). Default is a dry-run preview; `force` deletes (a
   * write, so the board snapshot invalidates and counts refresh). Returns the affected count:
   * bd emits `prune_count` on a dry-run and `pruned_count` on a force AND on the
   * nothing-to-prune message — read both.
   */
  prune: async (cwd: string, age: PruneAge, opts: { force?: boolean } = {}): Promise<number> => {
    const args = buildPruneArgs(age, opts);
    const out = opts.force ? await bdWrite(cwd, args) : await bd(cwd, args);
    const parsed = JSON.parse(out || "{}") as { prune_count?: number; pruned_count?: number };
    const count = parsed.pruned_count ?? parsed.prune_count;
    if (count === undefined) {
      // Neither field present — likely a bd output-format change; surface it instead of a silent 0.
      console.warn("[beads.prune] unexpected bd output — no prune_count/pruned_count:", out.slice(0, 200));
    }
    return count ?? 0;
  },

  // ── board hygiene (anton-6qbc) ── the gardener patrol's verbs; see the section above for the
  // measured output shapes and for why `--auto-merge` / `--fix` are absent.

  /** Pure argv builders for the two hygiene verbs that take options (see buildUpdateArgs). */
  buildLintArgs,
  buildStaleArgs,

  /**
   * `bd epic close-eligible` — close epics whose children are ALL closed. The one structural write
   * the patrol may make, so it defaults to a preview: pass `apply` to actually close. The apply is a
   * bdWrite (snapshot invalidates); the preview is a plain read.
   *
   * bd itself owns the eligibility rule, deliberately — an epic with an open child is not eligible,
   * and neither is a CHILDLESS epic (both measured), which is what keeps a freshly-created empty
   * epic from being closed out from under the person shaping it.
   */
  epicCloseEligible: async (
    cwd: string,
    opts: { apply?: boolean } = {},
  ): Promise<EpicCloseSweep> => {
    const dryRun = !opts.apply;
    const args = ["epic", "close-eligible", ...(dryRun ? ["--dry-run"] : []), "--json"];
    const out = await (dryRun ? bd : bdWrite)(cwd, args);
    return parseEpicCloseEligible(out, dryRun);
  },

  /** `bd lint` — beads missing the template sections their type requires. Read-only. */
  lintReport: (cwd: string, opts: LintOpts = {}): Promise<LintReport> =>
    bd(cwd, buildLintArgs(opts)).then(parseLintReport),

  /**
   * `bd stale` — beads untouched for `days` (bd's default: 30), optionally scoped to ONE status.
   * The patrol sweeps per status because the thresholds differ: a month-old `open` bead is backlog,
   * a month-old `in_progress` one is an abandoned run. Read-only; returns ordinary beads.
   */
  staleList: (cwd: string, opts: StaleOpts = {}): Promise<Bead[]> =>
    bd(cwd, buildStaleArgs(opts)).then(asArray<Bead>),

  /**
   * `bd orphans` — beads named by a commit message that are still open: work that shipped and was
   * never closed. bd matches commits from the cwd repo's git history, so this carries the same
   * "spawn in the project repo" rule the gate verbs do. Read-only: `--fix` is never passed.
   */
  orphansList: (cwd: string): Promise<OrphanBead[]> =>
    bd(cwd, ["orphans", "--json"]).then(parseOrphans),

  /** `bd dep cycles` — blocking cycles in the dependency graph. Read-only; see {@link DepCycle}. */
  depCycles: (cwd: string): Promise<DepCycle[]> =>
    bd(cwd, ["dep", "cycles", "--json"]).then(parseDepCycles),

  /**
   * `bd duplicates` — groups of beads with identical content, with bd's suggested merge target.
   * Read-only by construction: `--auto-merge` is never passed, because merging duplicates is a
   * judgment move the patrol reports rather than makes.
   */
  duplicateGroups: (cwd: string): Promise<DuplicateGroup[]> =>
    bd(cwd, ["duplicates", "--json"]).then(parseDuplicateGroups),

  /**
   * `bd recompute-blocked` — rebuild the denormalized `is_blocked` flag from the dependency graph,
   * returning how many rows were wrong. Idempotent (a consistent board corrects 0 rows) but a WRITE:
   * it commits, so it goes through bdWrite. This is the patrol's other safe verb — `bd ready` trusts
   * that flag, so a stale one hides ready work or serves blocked work to a claimer.
   */
  recomputeBlocked: (cwd: string): Promise<number> =>
    bdWrite(cwd, ["recompute-blocked", "--json"]).then(parseRecomputeBlocked),

  /**
   * Return a closed bead to `open` (`bd reopen`), emitting bd's own Reopened event.
   *
   * `reason` is the durable record of WHY the work was reopened — the provenance a rework leaves
   * behind (anton-4ocm), so a score attributed to an earlier round can still be read against the
   * decision that sent the ticket back. Omitted by the runner's cross-machine resume, which reopens
   * a bead only to re-run work its own branch is missing: that is bookkeeping, not a judgement.
   */
  reopen: (cwd: string, id: string, reason?: string) =>
    bdWrite(cwd, ["reopen", id, ...(reason ? ["--reason", reason] : [])]),

  /**
   * Snooze a bead (`bd defer`) / restore it (`bd undefer`) — the "not now, but not dead" state
   * (anton-ywi8). A deferred bead keeps its contract, notes, and edges but drops out of `bd ready`,
   * so the runtime never picks it up; undefer returns it to `open`. Deliberately distinct from
   * close (finished) and from blocked (waiting on a specific dependency). Manual only — bd's
   * `--until <date>` scheduling is out of scope.
   */
  defer: (cwd: string, id: string) => bdWrite(cwd, ["defer", id]),
  undefer: (cwd: string, id: string) => bdWrite(cwd, ["undefer", id]),

  /** A bead snoozed out of the ready queue (`bd defer`). */
  isDeferred: (b: Bead) => b.status === "deferred",

  /**
   * Abandon a whole unit of work — the won't-do outcome (anton-6xj0), applied as a transaction
   * (anton-aijz). A cascade passes every bead it settles (descendants first, the target last); a
   * single abandon is the one-entry case. Each reason is REQUIRED — it is the durable record of the
   * decision — and every reason is validated before the first write, so a blank one writes nothing.
   * Deliberately NOT a delete (that destroys the history a won't-do decision is made of) and NOT a
   * plain close (that reads as shipped).
   *
   * Two phases, in this order:
   *   1. label each bead `abandoned` and drop its stage label. The stage is a claim on in-flight
   *      work — an abandoned bead has none, and leaving `stage:implementing` behind (set by the run
   *      that was killed to make room for this abandon) would keep it reading as in-flight. bd's
   *      batch grammar has no label key, so these stay N separate updates.
   *   2. close them all, with their reasons, in ONE `bd batch` — all-or-nothing.
   *
   * Label-then-close (the reverse of the original single-bead order) is what makes a cascade
   * recoverable. The only state a crash can leave is "open + abandoned", which no run picks up —
   * execute-epic gates on the LABEL, not the status — and which re-running abandon finishes,
   * because an open bead is still found by openDescendants and still passes the already-closed
   * guard. Closing first would leave N beads closed-without-the-label, reading as SHIPPED, with no
   * path left to correct them.
   */
  abandonAll: async (cwd: string, entries: Array<{ id: string; reason: string }>): Promise<void> => {
    const closes = entries.map(({ id, reason }): BatchOp => {
      const why = reason.trim();
      if (!why) throw new Error("abandon requires a reason");
      return { op: "close", id, reason: `abandoned: ${why}` };
    });
    if (closes.length === 0) return;
    for (const { id } of entries) {
      await bdWrite(cwd, [
        "update",
        id,
        "--add-label",
        LABELS.abandoned,
        "--remove-label",
        LABELS.stage("implementing"),
        "--remove-label",
        LABELS.stage("in-review"),
      ]);
    }
    await beads.batch(cwd, closes);
  },

  /** Abandon a single bead — see {@link beads.abandonAll}, of which this is the one-entry case. */
  abandon: (cwd: string, id: string, reason: string): Promise<void> =>
    beads.abandonAll(cwd, [{ id, reason }]),

  /** A bead a human abandoned (closed + `abandoned`) — closed, but explicitly NOT delivered. */
  isAbandoned: (b: Bead) => b.labels?.includes(LABELS.abandoned) ?? false,

  /** A bead a run reserved but never delivered (see LABELS.notDelivered) — open, and in no PR. */
  isNotDelivered: (b: Bead) => b.labels?.includes(LABELS.notDelivered) ?? false,

  setStatus: (cwd: string, id: string, status: string) =>
    bdWrite(cwd, ["update", id, "--status", status]),

  /**
   * Atomically claim a bead: assignee + status in_progress, idempotent when already claimed by
   * the same actor (`bd update --claim`). The actor is passed explicitly via BEADS_ACTOR (bd's
   * highest-precedence identity) so the claim lands on the human operator who owns this anton
   * instance — not whatever unix user the server happens to run as.
   *
   * REJECTS when another actor already holds the bead ("issue already claimed by …"), which is what
   * makes this the local compare-and-swap {@link beads.claimVerified} builds the cross-machine
   * protocol on. It is the automation primitive: it flips status, so a human reservation goes
   * through {@link beads.assign} instead.
   */
  claim: (cwd: string, id: string, actor?: string) =>
    bdWrite(cwd, ["update", id, "--claim"], actor ? { env: { BEADS_ACTOR: actor } } : undefined),

  /** Pure argv builder for the claimable pool query, exposed for testing (see buildUpdateArgs). */
  buildClaimableReadyArgs,

  /** Pure ranker over an already-loaded board — see {@link rankClaimableTargets}. */
  rankClaimableTargets,

  /** Pure post-claim re-validation of a held target — see {@link staleClaimReason}. */
  staleClaimReason,

  /**
   * What any worker may claim right now, RANKED (anton-9anc): approved, unclaimed, blocker-free run
   * targets, ordered by priority, then by how many open beads each transitively unblocks, then by
   * age. One deterministic, explainable answer to "what does anton pick up next" — every consumer
   * reads this order rather than inventing its own, so the runner, the board, and the ready-count
   * nudge can never disagree about the queue.
   *
   * Two reads, taken together: bd's own ready query (blocker-awareness stays bd's job) and the full
   * board (`--status all`, the same read the approve route and execute-epic gate on, so a target
   * this returns is one anton will actually run). Reads only — claiming is {@link beads.claimVerified}.
   * `deps` is injectable for tests, like {@link runDoltSync}'s `exec`.
   */
  claimableTargets: async (
    cwd: string,
    deps: {
      ready?: (cwd: string) => Promise<Bead[]>;
      board?: (cwd: string) => Promise<Bead[]>;
    } = {},
  ): Promise<ClaimableTarget[]> => {
    const readPool = deps.ready ?? ((c: string) => bd(c, buildClaimableReadyArgs()).then(asArray<Bead>));
    const readBoard = deps.board ?? ((c: string) => beads.list(c, ["--status", "all"]));
    const [pool, board] = await Promise.all([readPool(cwd), readBoard(cwd)]);
    return rankClaimableTargets(pool, board);
  },

  /**
   * Claim a target for `actor` and PROVE the claim held (anton-9anc) — pull, claim, push, settle,
   * re-pull, re-show, assert assignee, re-validate the target. Never throws: it answers `ok` (we
   * hold it and it is still runnable), `lost` (another actor holds it — the protocol working, so a
   * pickup loop moves on), `stale` (we hold it but it left the claimable set while we settled; the
   * caller must not run it and owns releasing the claim) or `unverified` (we could not prove either
   * way, so the caller must not run the target; a retry is safe).
   *
   * Why each leg exists — claims ride eventually-consistent Dolt sync, so no single step is enough:
   * the pull surfaces a claim another machine already published (bd then refuses ours for free), the
   * push publishes ours, the settle gives a near-simultaneous rival time to reach the remote, and
   * the re-read is what turns "we wrote it" into "we hold it" after the merge picks a winner. This
   * is the run-lease arbitration pattern (anton-jz1) applied to the assignee, and it NARROWS rather
   * than closes the window — a real cross-process lock needs a bd primitive that doesn't exist
   * (anton-od4), which is why a claim remains advisory.
   *
   * Composes with the human-claim guard rather than duplicating it: the whole sequence runs on the
   * SAME per-bead write chain claim.ts's CAS uses, so an operator's Claim and a worker's pickup are
   * ordered against each other in this process, and bd's `--claim` — not a re-implemented
   * read-then-write CAS — is the local compare-and-swap. Never call it from inside a
   * `withClaimLock` body (it would wait on the lock that body holds).
   */
  claimVerified: (
    cwd: string,
    id: string,
    actor: string,
    deps: ClaimVerifiedDeps = {},
  ): Promise<ClaimVerification> => {
    const who = actor.trim();
    // A blank actor can't be asserted against the post-claim assignee (bd would fall back to
    // git user.name / $USER), so every verdict below would be a guess. Caller bug — fail loud.
    if (!who) throw new Error(`claimVerified(${id}): an actor is required to verify a claim`);
    return withBeadWriteLock(cwd, id, () => runClaimVerified(cwd, id, who, deps));
  },

  /**
   * Set a bead's assignee WITHOUT touching status (`bd assign <id> <actor>`). This is the
   * human-reservation primitive: unlike `claim`, it never flips the bead to in_progress, so the
   * bead stays `open` and deriveStage stays `backlog` — a person reserves it without triggering a
   * run. `actor` is a positional arg (not BEADS_ACTOR) because `bd assign` names the assignee
   * directly; do NOT route human claims through `claim`, which is the automation-run primitive.
   */
  assign: (cwd: string, id: string, actor: string) => bdWrite(cwd, ["assign", id, actor]),

  /** Clear a bead's assignee (`bd assign <id> ""`) — used when releasing a claim. */
  unassign: (cwd: string, id: string) => bdWrite(cwd, ["assign", id, ""]),

  /** Pure argv builder, exposed for testing and callers that want to inspect the write. */
  buildUpdateArgs,

  /**
   * Apply a field patch as ONE `bd update` invocation. `currentLabels` are the bead's existing
   * labels, needed to diff managed prefixes without disturbing control labels. A patch that
   * touches nothing is a no-op (no bd is spawned).
   */
  update: async (
    cwd: string,
    id: string,
    patch: BeadPatch,
    currentLabels: string[] = [],
  ): Promise<void> => {
    const args = buildUpdateArgs(id, patch, currentLabels);
    if (!args) return;
    await bdWrite(cwd, args);
  },

  /**
   * Full sync with the Dolt remote (pull, commit if needed, then push), coalescing concurrent
   * calls per repo. Tolerant of a clean working set and of a workspace with no remote; REJECTS
   * on a real push failure — call sites must log or rethrow, never ignore the promise. Fire-and-
   * forget callers read delivery from the sync-status registry, not the resolution — only the
   * durable job needs the outcome, so only `push` surfaces it.
   */
  sync: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "full");
  },

  /**
   * Pull-only sync (heartbeat): remote changes land locally without pushing. Never pushes —
   * see SyncMode. Shares the per-repo coalescing with `sync`, so passes never overlap.
   */
  pull: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "pull");
  },

  /**
   * Heartbeat backstop pass (anton-sr8f): pulls, plus retries a push when this repo has unpushed
   * local commits (a prior write-nudged push failed) OR has not yet been reconciled by this process
   * — the first backstop after a (re)start runs one reconciling full pass so commits stranded by a
   * crash before their push still ship, since the in-memory backlog count can't survive a restart
   * (anton-z908). A caught-up, reconciled repo pulls only — idle repos stay quiet. Shares the
   * per-repo coalescer with `sync`/`pull`, so a backstop push can never overlap a write-nudged one
   * (beads GH#2466); a not-wired repo is unaffected.
   */
  backstop: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "backstop");
  },

  /**
   * Durable sync-push job pass (anton-nowq): always runs a full push to retry a write's commit,
   * unlike `backstop` which snapshots the (possibly stale) unpushed count and can drop to pull-only
   * when it coalesces behind a still-in-flight write push — leaving a push that then fails unretried
   * by the very job meant to retry/park it. Never inflates the backlog (the work is already counted).
   * Shares the per-repo coalescer with `sync`/`pull`/`backstop`, so it can never overlap another push
   * (beads GH#2466). REJECTS on a real push failure so the runner applies its retry/backoff/park
   * policy, and resolves "not-wired" when the repo has no remote — nothing was delivered, so the
   * caller must not treat that as a completed push (see makeSyncPushHandler).
   */
  push: (cwd: string): Promise<SyncOutcome> => doltSync(cwd, "push"),

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,

  /**
   * Work a PERSON executes, not an agent (`agent:human`, see {@link LABELS.agentHuman}). Approved,
   * shaped, real work — it just resolves to no specialist prompt, so anton must refuse it at every
   * point where a bead turns into a dispatch rather than let it fall through to the default agent.
   * Shared by {@link isClaimable} (it never enters the claimable set), execute-epic's run gate (a
   * forced dispatch of a human TARGET is poisoned) and its per-ticket gate (a human TICKET inside an
   * ordinary run is held behind a human gate at its own boundary), so the set anton picks from and
   * the runner agree at every level of the tree.
   */
  isHumanWork: (b: Bead) => b.labels?.includes(LABELS.agentHuman) ?? false,

  isEpic: (b: Bead) => b.issue_type === "epic",

  /** The bead's parent id, from whichever field the bd read populated (`list` vs `show`). */
  parentOf: (b: Bead): string | undefined => (b.parent ?? b.parent_id) as string | undefined,

  /**
   * A bead that GROUPS run targets rather than being one: an epic with at least one `feature`
   * child. Each feature is its own run (own worktree, own PR), so executing or approving the epic
   * above them would be one button launching N PRs — not a gate. The rule is structural, not
   * type-only, so no existing bead needs re-typing: an epic becomes a container the moment a
   * feature lands under it (docs/design/2026-07-26-tier-and-linear-ux.md).
   */
  isContainer: (b: Bead, board: Bead[]): boolean =>
    beads.isEpic(b) && board.some((c) => c.issue_type === "feature" && beads.parentOf(c) === b.id),

  /**
   * A bead anton can execute as a run: a `feature` (the shippable delivery unit — one worktree,
   * one PR), a parentless task/bug (an "epic-of-one" — a single-ticket run), or a legacy `epic`
   * with no feature children (its own children batch into one PR, exactly as before the tier
   * split). A task/bug WITH a parent is a child ticket, executed as part of its run target's run;
   * every other type (chore, learning, molecule, …) is never runnable on its own. Shared by
   * execute-epic (the run gate) and the approve route (validating targets before enqueue) so both
   * agree on what "runnable" means.
   *
   * `board` — the bead list the container check reads — is REQUIRED, deliberately: a permissive
   * default would answer the pre-tier question (every epic is runnable) at every boundary that
   * holds only a single `bd show` bead, letting a container epic be claimed, PR-linked and moved
   * to review, after which review-fix would run it and close its feature children on merge. Every
   * classification site loads the full list already; pass it.
   *
   * Pipeline plumbing (`molecule`/`gate`) is refused UP FRONT rather than left to fall out of the
   * whitelist below (anton-ve2r): the whitelist excludes it only by luck of type, and a run target
   * is what approval enqueues — a gate reaching it would hand a run an async wait to execute.
   */
  isRunTarget: (b: Bead, board: Bead[]): boolean =>
    !isPipelineArtifact(b) &&
    isRunTargetType(b.issue_type) &&
    (b.issue_type === "feature" ||
      (beads.isEpic(b) && !beads.isContainer(b, board)) ||
      ((b.issue_type === "task" || b.issue_type === "bug") && !beads.parentOf(b))),

  /**
   * Does this run target execute its CHILDREN as its tickets, rather than being its own single
   * ticket? An epic always groups (a childless one is a poison run, exactly as before the tier
   * split); a feature groups only once tickets are shaped under it — a feature shaped as one unit
   * of work IS its own ticket. Everything else is a leaf. Shared by execute-epic (which tickets a
   * run works through) and epic-detail (which tickets its page shows) so the run and its detail
   * page never disagree about what the target contains.
   */
  groupsChildren: (b: Bead, children: Bead[]): boolean =>
    beads.isEpic(b) || (b.issue_type === "feature" && children.length > 0),

  // ── cross-machine run-liveness lease (anton-jz1) ──

  /** The `run-lease:*` labels currently on a bead (normally 0 or 1; a crashed refresh may leave 2). */
  runLeaseLabels: (b: Bead): string[] =>
    (b.labels ?? []).filter((l) => l.startsWith(RUN_LEASE_PREFIX)),

  /**
   * Expiry (ms epoch) of the bead's run-lease, or undefined when absent/malformed. Takes the MAX
   * across labels so a lingering older lease can't make a fresher one read as expired.
   */
  runLeaseExpiry: (b: Bead): number | undefined => {
    let max: number | undefined;
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry } = parseRunLease(l);
      if (expiry !== undefined && (max === undefined || expiry > max)) max = expiry;
    }
    return max;
  },

  /**
   * Is a run actively executing this bead on some machine right now? True iff it carries a
   * run-lease whose expiry is still in the future. An expired lease (crashed/killed machine that
   * stopped heartbeating, or a settled run) reads false so the epic is re-triggerable (anton-jz1).
   */
  isRunLive: (b: Bead, nowMs: number): boolean => {
    const exp = beads.runLeaseExpiry(b);
    return exp !== undefined && exp > nowMs;
  },

  /**
   * Does the bead carry an UNEXPIRED run-lease owned by a run OTHER than `ownRunId` (anton-jz1)? A
   * queued execute-epic job that reschedules (quota/backoff) re-enters its handler WITHOUT the
   * enqueue-time liveRunCheck, so if a Force run started on another machine while this job was
   * parked, the fresh target now carries that machine's live lease. The handler treats this as a
   * park/retry condition rather than overwriting the lease — replacing it would let both machines
   * run the epic at once. This run's OWN lease (same owner, e.g. a crash leftover) and any expired
   * lease read false, so a resume sweeps and re-publishes its own lease normally. An owner-less lease
   * (legacy format, or a liveness-only publish that recorded no owner) is conservatively treated as
   * foreign when unexpired: parking is recoverable, a double-run is not.
   */
  foreignRunLeaseLive: (b: Bead, nowMs: number, ownRunId: string): boolean => {
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry, owner } = parseRunLease(l);
      if (expiry !== undefined && expiry > nowMs && owner !== ownRunId) return true;
    }
    return false;
  },

  /**
   * The bead's run-lease labels OWNED by `ownRunId` (anton-jz1) — the leases this run itself
   * published, matched by the `:<owner>` suffix. Used to sweep a run's OWN crash leftover on an
   * idempotent short-circuit that returns BEFORE the general lease-adoption step (the external-ref
   * early return in execute-epic): clearing these lets a stopped run free the epic immediately
   * instead of leaving it looking live until the TTL, while a foreign machine's lease is deliberately
   * left for its own owner/TTL to clear — honoring "finally clears only what we own".
   */
  ownRunLeaseLabels: (b: Bead, ownRunId: string): string[] =>
    (b.labels ?? []).filter(
      (l) => l.startsWith(RUN_LEASE_PREFIX) && parseRunLease(l).owner === ownRunId,
    ),

  /**
   * Tiebreak for two runs that acquired the lease at the same instant (anton-jz1). The foreign-lease
   * gate reads the board BEFORE a run publishes its own lease, so two machines force-running an epic
   * simultaneously can both clear that gate before either lease is visible remotely. After publishing,
   * a handler re-pulls and re-reads the target and calls this: it returns true iff `ownRunId` should
   * KEEP the lease and proceed, i.e. no OTHER live lease on the bead has an owner that sorts
   * lexicographically at or below `ownRunId`. Because every colliding run applies the same
   * lowest-owner-wins rule against the same merged label set, exactly one proceeds and the rest park.
   * An owner-less foreign live lease (legacy / liveness-only publish) can't be arbitrated, so this
   * yields (returns false): parking is recoverable, a double-run is not. No foreign live lease at all
   * → true (the run is uncontested).
   *
   * The lowest-owner-wins tiebreak is ONLY sound for that SYMMETRIC case — two fresh runs that raced
   * before either lease was visible. It is NOT safe against an already-live INCUMBENT (a run that
   * started earlier, only arbitrates at its own startup, and won't yield): from the label set alone
   * this function can't tell an incumbent from a co-racer, so a latecomer whose owner sorts lower
   * would wrongly "win" and double-run. The caller must therefore park on any foreign live lease when
   * its pre-check was stale (couldn't rule out an incumbent) and only reach this arbitration after a
   * trusted, fresh pre-check — see execute-epic step 1b (`preCheckTrusted`).
   */
  winsRunLeaseRace: (b: Bead, nowMs: number, ownRunId: string): boolean => {
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry, owner } = parseRunLease(l);
      if (expiry === undefined || expiry <= nowMs) continue; // expired: not a live contender
      if (owner === ownRunId) continue; // our own lease
      if (owner === undefined || owner <= ownRunId) return false; // a foreign owner sorts first → it wins
    }
    return true;
  },

  /**
   * Publish/refresh the run-lease on the target, atomically replacing any existing lease labels
   * (`stale`, e.g. the prior expiry this process published, or leftovers from a crashed run) in a
   * single `bd update`. Removing a label that isn't present is a bd no-op, so a slightly-stale
   * `stale` list is harmless. `owner` stamps the publishing run's id onto the lease so a resuming
   * handler can distinguish its own lease from another machine's (see foreignRunLeaseLive).
   */
  publishRunLease: (
    cwd: string,
    id: string,
    expiresAtMs: number,
    stale: string[] = [],
    owner?: string,
  ) =>
    bdWrite(cwd, [
      "update",
      id,
      ...stale.flatMap((l) => ["--remove-label", l]),
      "--add-label",
      LABELS.runLease(expiresAtMs, owner),
    ]),

  /** Remove the given run-lease labels from the target (run settled). No-op when there are none. */
  clearRunLease: (cwd: string, id: string, stale: string[]): Promise<string> =>
    stale.length === 0
      ? Promise.resolve("")
      : bdWrite(cwd, ["update", id, ...stale.flatMap((l) => ["--remove-label", l])]),
};
