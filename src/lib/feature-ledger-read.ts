/**
 * `featureLedger(db, projectId, beadId)` (anton-8zckg) — the read that turns the pure fold into an
 * answer: resolve the feature's scope from the board, pull every source the fold needs, and compose
 * what `feature-ledger.ts` computes from them.
 *
 * Cost and friction are ONE read (anton-sdz00), so a surface answers "what did this feature cost"
 * and "what did it cost us in attention" from a single resolved scope. Each source lands on the
 * counter that owns it: invocation rows and delivery times for the money and the clock; jobs,
 * escalations and the target's review thread for the intervention counters. Only the send-back
 * notes need no read of their own — they come off the board snapshot the scope was resolved from.
 *
 * Kept out of `feature-ledger.ts` for the same reason `feature-scope.ts` is (see that module's own
 * header): the fold is pure and dependency-free on purpose so a client component can import it, and
 * every source here is impure — a board snapshot and a comment-thread read (`tickets.ts` /
 * `beads`, which reach node:fs through the bd CLI wrapper) beside the anton.db reads. This is the
 * "caller" both of those modules' headers describe as owning the DB side.
 *
 * `undefined` when `projectId` names no project on this anton.db — there is no board to resolve a
 * scope from, which is a different fact from a scope that resolved and recorded nothing.
 */
import { beads, type Bead } from "./beads/bd";
import { parseTicketNotes } from "./beads/notes";
import { invocationsForBeads } from "./claude-invocations";
import { getDb } from "./db";
import { escalationsForBeads } from "./escalations";
import {
  lastDeliveryMs,
  ledgerFriction,
  ledgerTiming,
  ledgerTotals,
  type FrictionNote,
  type FrictionReviewRound,
  type LedgerFriction,
  type LedgerTiming,
  type LedgerTotals,
} from "./feature-ledger";
import { ledgerScope, type LedgerScope } from "./feature-scope";
import { jobsForBeads, type AntonDb } from "./jobs/queue";
import type { GatewayPricing } from "./model-pricing";
import { getProjectById } from "./projects";
import { reviewReportOf } from "./review-report";
import { listDeliveriesByBead } from "./runs";
import { listAllBeads } from "./tickets";

/**
 * One feature's whole ledger: which beads it covers, what it cost, how long it took, and how much
 * human attention it needed.
 *
 * Cost and friction ride together on purpose (anton-sdz00) — "what did this feature cost" and "what
 * did it cost US" are the same question asked twice, and a caller that had to compose them from two
 * reads would inevitably render one against a scope the other never saw.
 */
export interface FeatureLedger {
  scope: LedgerScope;
  totals: LedgerTotals;
  timing: LedgerTiming;
  /** The intervention counters, every one a PROXY signal — see {@link LedgerFriction}. */
  friction: LedgerFriction;
}

/**
 * What `beadId` — plus its working-layer children (`ledgerScope`) — cost and how long it took,
 * folded from rows anton already writes. `undefined` when `projectId` names no project.
 */
export async function featureLedger(
  db: AntonDb,
  projectId: string,
  beadId: string,
  gatewayPricing?: GatewayPricing,
): Promise<FeatureLedger | undefined> {
  const project = await getProjectById(db, projectId);
  if (!project) return undefined;

  const board = await listAllBeads(project);
  const scope = ledgerScope(board, beadId);
  const [rows, deliveries, jobs, escalations, rounds] = await Promise.all([
    invocationsForBeads(db, projectId, scope.ids),
    // A ticket's own local commit is only a feature delivery when the run it committed inside
    // actually delivered — a run that parks or fails before pushing must not hand this feature a
    // `leadMs` ending at an unpublished commit (PR #320 review). `listDeliveriesByBead` checks that
    // per session rather than dropping local commits outright, which still credits a non-final
    // grouped-run child reparented onto a different feature later (PR #320 review, P2).
    listDeliveriesByBead(db, projectId, scope.ids, { includeLocalCommits: false }),
    jobsForBeads(db, projectId, scope.ids),
    escalationsForBeads(db, projectId, scope.ids),
    reviewRoundsOf(project.repoPath, beadId),
  ]);

  return {
    scope,
    totals: ledgerTotals(rows, gatewayPricing),
    timing: ledgerTiming(rows, lastDeliveryMs(deliveries, scope.ids)),
    friction: ledgerFriction({ rounds, jobs, escalations, notes: sendBackNotes(board, scope.ids) }),
  };
}

/**
 * The review rounds recorded on the run target's comment thread — the one friction source no table
 * holds, since a gate's history lives only in the comments it appended (`review-report.ts`).
 *
 * The ONE extra bd spawn this read costs, and it is spent on the target alone: a gate reviews the
 * run's whole diff once and comments on the target, so hydrating each ticket in the scope would
 * multiply the spawns to find threads that are empty by construction.
 *
 * A failed read reports NO rounds rather than throwing. The rest of the ledger is dollars and
 * timing read from anton.db, and losing all of it to an unreadable comment thread would trade the
 * answer for the footnote — a scope with zero rounds already reads as "not reviewed", which is the
 * honest thing to say when the thread could not be replayed.
 */
async function reviewRoundsOf(repoPath: string, targetId: string): Promise<FrictionReviewRound[]> {
  try {
    return reviewReportOf(await beads.showWithComments(repoPath, targetId)).rounds;
  } catch (e) {
    console.warn(`[feature-ledger] could not read ${targetId}'s review history`, e);
    return [];
  }
}

/**
 * The scope's bead notes, flattened — what `countSendBacks` matches its two send-back phrases
 * against (`rework-marks.ts`).
 *
 * Read off the board snapshot already in hand rather than per bead: `bd list --json` carries the
 * `notes` blob, so a whole feature's send-backs cost zero extra spawns. Every bead in the scope is
 * read, not just the target: a reopen writes its instruction note on the TICKET it sent back.
 */
function sendBackNotes(board: readonly Bead[], ids: readonly string[]): FrictionNote[] {
  const wanted = new Set(ids);
  return board
    .filter((bead) => wanted.has(bead.id))
    .flatMap((bead) => parseTicketNotes(bead.notes).map((note) => ({ text: note.text })));
}

/** UI/read path over the shared anton.db — see {@link featureLedger}. */
export function projectFeatureLedger(
  projectId: string,
  beadId: string,
  gatewayPricing?: GatewayPricing,
): Promise<FeatureLedger | undefined> {
  return featureLedger(getDb(), projectId, beadId, gatewayPricing);
}
