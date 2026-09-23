/**
 * `featureLedger(db, projectId, beadId)` (anton-8zckg) — the read that turns the pure fold into an
 * answer: resolve the feature's scope from the board, pull its invocation rows and delivery times,
 * and fold both into the totals and timing `feature-ledger.ts` computes.
 *
 * Kept out of `feature-ledger.ts` for the same reason `feature-scope.ts` is (see that module's own
 * header): the fold is pure and dependency-free on purpose so a client component can import it, and
 * this read needs three impure things that must not ride along — a board snapshot (`tickets.ts`,
 * which reaches node:fs through the bd CLI wrapper) and two db reads. This is the "caller" both of
 * those modules' headers describe as owning the DB side.
 *
 * `undefined` when `projectId` names no project on this anton.db — there is no board to resolve a
 * scope from, which is a different fact from a scope that resolved and recorded nothing.
 */
import { invocationsForBeads } from "./claude-invocations";
import { getDb } from "./db";
import {
  lastDeliveryMs,
  ledgerTiming,
  ledgerTotals,
  type LedgerTiming,
  type LedgerTotals,
} from "./feature-ledger";
import { ledgerScope, type LedgerScope } from "./feature-scope";
import type { AntonDb } from "./jobs/queue";
import type { GatewayPricing } from "./model-pricing";
import { getProjectById } from "./projects";
import { listDeliveriesByBead } from "./runs";
import { listAllBeads } from "./tickets";

/** One feature's whole ledger: which beads it covers, what it cost, and how long it took. */
export interface FeatureLedger {
  scope: LedgerScope;
  totals: LedgerTotals;
  timing: LedgerTiming;
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
  const [rows, deliveries] = await Promise.all([
    invocationsForBeads(db, projectId, scope.ids),
    listDeliveriesByBead(db, projectId, scope.ids),
  ]);

  return {
    scope,
    totals: ledgerTotals(rows, gatewayPricing),
    timing: ledgerTiming(rows, lastDeliveryMs(deliveries, scope.ids)),
  };
}

/** UI/read path over the shared anton.db — see {@link featureLedger}. */
export function projectFeatureLedger(
  projectId: string,
  beadId: string,
  gatewayPricing?: GatewayPricing,
): Promise<FeatureLedger | undefined> {
  return featureLedger(getDb(), projectId, beadId, gatewayPricing);
}
