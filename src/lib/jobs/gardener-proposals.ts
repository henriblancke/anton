/**
 * The gardener patrol's JUDGMENT tier (anton-9qwq), split out of gardener.ts (anton-l4do) so the
 * handler reads as an orchestration over its three tiers and this one — the only tier that files
 * beads — can be exercised without a job queue.
 *
 * The board-shape claims the hygiene report has no verb for (misfiled work, missing ordering edges,
 * retirement candidates) become approvable proposal beads, deduplicated by fingerprint so a nightly
 * patrol over an unfixed board asks once — and, for the duplicates only overlapping patrols on
 * different machines can create, folded back to one ask before new ones are filed and arbitrated
 * again right after, so a twin filed by another machine is withdrawn within seconds rather than at
 * the next patrol.
 *
 * This tier writes to PROPOSALS alone: applying one is an approval away (anton-1t3n), so nothing
 * here touches the beads a proposal is about.
 */
import type { Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { detectBoard } from "../gardener/detect";
import {
  arbitrateEmission,
  emitProposals,
  MAX_PROPOSALS_PER_PASS,
  NO_REMOTE_SKIP,
  PartialEmissionError,
  reconcileDuplicateProposals,
  type ArbitrationResult,
  type EmissionArbitrationDeps,
  type EmissionResult,
  type EmittedProposal,
  type ReconcileResult,
} from "../gardener/emit";
import { shadowProposals } from "../gardener/shadow";
import type { HygieneFinding } from "../hygiene";
import type { PassScope } from "./pass-preamble";

export type { EmissionArbitrationDeps };

export interface GardenerProposalInput {
  /** Tier 2's findings: a retirement's evidence IS a hygiene finding. */
  findings: HygieneFinding[];
  /** The premise fence — the stamp of the read every proposal's evidence describes. */
  observedAtMs: number;
  arbitration?: EmissionArbitrationDeps;
}

// ── what a patrol SAYS about its judgment tier (the console is an operator's only view of a 03:00
//    pass, so every fold, every cap and every twin left standing has a line) ──

/** What reconciliation left behind, or absent when it left nothing an operator should know about. */
function unfoldedDuplicates(reconciled: ReconcileResult): string | undefined {
  // Neither silence nor a fold: a twin an approval or a run holds is left for a human, and a close
  // that failed is a duplicate still standing. Both have to be visible to tell either from a board
  // that simply has no duplicates.
  if (reconciled.held.length === 0 && reconciled.failed.length === 0) return undefined;
  const failed =
    reconciled.failed.length > 0
      ? `, ${reconciled.failed.length} fold(s) failed: ${reconciled.failed.join(", ")}`
      : "";
  return (
    `left ${reconciled.held.length} duplicate proposal(s) standing ` +
    `(approved or claimed: ${reconciled.held.join(", ") || "none"})${failed}`
  );
}

/** Why arbitration left duplicates for the next patrol, or absent when it left none. */
function unwithdrawnTwins(arbitrated: ArbitrationResult): string | undefined {
  // The one silent case is a board with no remote: nothing can have filed the claim twice there, so
  // saying "duplicates left" every pass would be noise about an impossible state.
  const unjudged = arbitrated.skipped && arbitrated.skipped !== NO_REMOTE_SKIP;
  const clauses = [
    unjudged ? `— ${arbitrated.skipped}` : undefined,
    arbitrated.held.length > 0 ? `(held: ${arbitrated.held.join(", ")})` : undefined,
    arbitrated.failed.length > 0 ? `(failed: ${arbitrated.failed.join(", ")})` : undefined,
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length > 0 ? `emission arbitration left duplicates for the next patrol ${clauses.join(" ")}` : undefined;
}

/**
 * Whatever landed before a create failed is real board state living only in the local working set.
 * Report and propagate it as soon as it lands, or a pass that parks on the failing proposal leaves
 * the ones that DID file invisible to every other machine.
 */
function reportEmission(scope: PassScope, emission: EmissionResult): void {
  if (emission.created.length > 0) {
    console.log(
      `[gardener] ${scope.project.id}: filed ${emission.created.length} proposal(s) ` +
        `(${emission.created.map((p) => p.id).join(", ")})` +
        `${emission.suppressed > 0 ? `, ${emission.suppressed} already on the board` : ""}`,
    );
    scope.nudge(scope.project);
  }
  // Never a silent cap: the overflow is deterministic and the next pass files it, but a reader has
  // to be able to tell "the board is this clean" from "we stopped at ten".
  if (emission.deferred > 0) {
    console.log(
      `[gardener] ${scope.project.id}: held back ${emission.deferred} proposal(s) — one pass files ` +
        `at most ${MAX_PROPOSALS_PER_PASS}; the next patrol picks them up`,
    );
  }
}

/**
 * Converge on ONE ask per claim before filing new ones. Fingerprint suppression is only atomic
 * within a patrol: two on different machines each read a working set the other's proposal has not
 * synced into yet, so the same claim can reach the board twice with nothing to refuse the second.
 * Folding the twins here is the only place that duplication is ever undone — see gardener/emit.ts.
 *
 * Best-effort by design: a failed fold is noise the next patrol retries, not a reason to cost this
 * pass its proposals.
 */
async function foldRivalDuplicates(scope: PassScope, board: Bead[]): Promise<void> {
  const reconciled = await reconcileDuplicateProposals(scope.project.repoPath, board, {
    signal: scope.ctx.signal,
  });
  if (reconciled.folded.length > 0) {
    console.log(
      `[gardener] ${scope.project.id}: folded ${reconciled.folded.length} duplicate proposal(s) ` +
        `(${reconciled.folded.map((f) => `${f.id}→${f.into}`).join(", ")})`,
    );
    scope.nudge(scope.project);
  }
  const standing = unfoldedDuplicates(reconciled);
  if (standing) console.log(`[gardener] ${scope.project.id}: ${standing}`);
}

/**
 * Publish what this pass filed and withdraw the twin a patrol on another machine filed for the same
 * claim — the run-lease arbitration applied to emission (gardener/emit.ts). Without it a duplicate
 * only ever goes away when the NEXT patrol reconciles, which on a nightly schedule leaves an
 * operator a whole day to act on one ask twice.
 *
 * Best-effort like every other fold: it reports why it stood down rather than costing the pass
 * anything. Returns the proposals it withdrew, which are no longer this pass's to speak for.
 */
async function withdrawTwins(
  scope: PassScope,
  emission: EmissionResult,
  deps: EmissionArbitrationDeps | undefined,
): Promise<Set<string>> {
  if (emission.created.length === 0) return new Set();
  const arbitrated = await arbitrateEmission(scope.project.repoPath, emission.created, {
    ...deps,
    signal: scope.ctx.signal,
  }).catch((e): ArbitrationResult => {
    // Never the pass's failure, and never a stopped pass's REPORTED failure either: the proposals
    // stand, and the next patrol folds whatever this could not.
    console.error(`[gardener] ${scope.project.id}: emission arbitration failed`, e);
    return { folded: [], held: [], failed: [], skipped: "arbitration itself failed" };
  });
  if (arbitrated.folded.length > 0) {
    console.log(
      `[gardener] ${scope.project.id}: withdrew ${arbitrated.folded.length} proposal(s) another ` +
        `patrol had already filed (${arbitrated.folded.map((f) => `${f.id}→${f.into}`).join(", ")})`,
    );
    scope.nudge(scope.project);
  }
  // A twin left standing is a duplicate an operator can still see, so it is never silent — whether
  // arbitration stood down, ran into a held twin, or failed its close.
  const standing = unwithdrawnTwins(arbitrated);
  if (standing) console.log(`[gardener] ${scope.project.id}: ${standing}`);
  return new Set(arbitrated.folded.map((f) => f.id));
}

/**
 * What the armed patrol WOULD have done with what it just filed (anton-lmps) — decided against a
 * board read fresh at this moment, exactly as an approval would, and writing nothing.
 *
 * Runs AFTER arbitration and skips what it withdrew: a proposal folded into another machine's twin
 * is a closed ask, and shadowing it would report on a question nobody is being asked.
 */
function shadow(
  scope: PassScope,
  created: EmittedProposal[],
  withdrawn: Set<string>,
  observedAtMs: number,
): Promise<unknown> {
  return shadowProposals({
    repo: scope.project.repoPath,
    created: created.filter((p) => !withdrawn.has(p.id)),
    policy: scope.policy,
    observedAtMs,
    nowMs: scope.clock.now(),
    producer: "[gardener]",
    log: scope.log,
    signal: scope.ctx.signal,
  });
}

/**
 * File this patrol's proposals: fold the duplicates a rival patrol left standing, emit, withdraw the
 * twin another machine filed for the same claim, then record what an armed patrol would have done.
 *
 * Throws what emission throws — a create that keeps failing has to park the pass for a human — but
 * never before reporting and propagating whatever DID land.
 */
export async function fileGardenerProposals(
  scope: PassScope,
  input: GardenerProposalInput,
): Promise<void> {
  const { ctx } = scope;
  const repo = scope.project.repoPath;

  // The board read spans EVERY status for two reasons: detection reads container-ness and superseding
  // twins off the whole graph, and a DECLINED proposal is a closed bead — a live-only read would miss
  // it and re-ask a question a human already answered. Through `loadAllIssues`, not a bare `bd list
  // --status all`: that flag is unsupported on some bd versions, and a patrol that threw here would
  // park every pass without ever filing a proposal.
  ctx.signal.throwIfAborted();
  const board = await loadAllIssues(repo);
  const detections = detectBoard({
    board,
    hygiene: { findings: input.findings },
    now: scope.clock.now(),
  });
  await ctx.heartbeat();
  // Re-check RIGHT before the first write. The board read and detection above take real time, and a
  // cancel arriving inside them is invisible to `ctx.heartbeat()` — which does not inspect the
  // signal — so without this a cancelled patrol would still file judgment-tier proposal beads.
  // `emitProposals` carries the signal on from here and re-checks between its own creates.
  ctx.signal.throwIfAborted();

  await foldRivalDuplicates(scope, board);
  ctx.signal.throwIfAborted();

  try {
    const emission = await emitProposals(repo, {
      board,
      detections,
      observedAtMs: input.observedAtMs,
      signal: ctx.signal,
    });
    reportEmission(scope, emission);
    const withdrawn = await withdrawTwins(scope, emission, input.arbitration);
    await shadow(scope, emission.created, withdrawn, input.observedAtMs);
  } catch (e) {
    // The proposals a stopped pass DID file are on the board like any other, so they get the same
    // arbitration — a pass that parked on its third create must not leave the first two doubled. Not
    // shadowed, though: the pass is failing and will retry, and its commentary is worth less than
    // getting the beads that landed onto the other machines.
    if (e instanceof PartialEmissionError) {
      reportEmission(scope, e.result);
      await withdrawTwins(scope, e.result, input.arbitration);
    }
    throw e;
  }
}
