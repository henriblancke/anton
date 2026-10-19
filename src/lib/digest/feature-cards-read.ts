/**
 * `digestFeatureGroups` (anton-y1uxp): the read half of the digest's feature cards — resolve each
 * changed feature's cost (feature-ledger-read.ts) and PR browser URL (git/remote.ts), then hand the
 * pure fold (feature-cards.ts) what it needs to build and group the cards.
 *
 * Kept out of feature-cards.ts for the same reason `feature-ledger-read.ts` is split from
 * `feature-ledger.ts` (see that module's own header): the fold is dependency-free on purpose, and
 * every source this module reaches for — a board snapshot, `.product/PRODUCT.md`, a git remote, the
 * anton.db ledger — is impure.
 */
import type { Bead } from "../beads/bd";
import { attachPrUrl, githubBaseUrl } from "../git/remote";
import { featureLedger } from "../feature-ledger-read";
import type { AntonDb } from "../jobs/queue";
import type { GatewayPricing } from "../model-pricing";
import { readProjectOutcomes } from "../outcomes";
import { getDb } from "../db";
import { getProjectById } from "../projects";
import type { TimelineEvent } from "../timeline";
import { listAllBeads } from "../tickets";
import { featureCardOf, groupFeatureCards, type DigestFeatureGroup } from "./feature-cards";

export interface DigestFeatureCardsOptions {
  /** The board snapshot the caller already holds — see feature-ledger-read.ts's own `board` option
   * for why a second fetch here would risk judging the cards against a different snapshot than the
   * one the caller resolved its window's events from. */
  board?: Bead[];
  gatewayPricing?: GatewayPricing;
}

/**
 * How many {@link featureLedger} calls run at once — each one is its own `bd show` spawn
 * (`reviewRoundsOf`) on top of the anton.db reads, so a window with many changed features must not
 * fire every call at the same instant. Mirrors `COHORT_FEATURE_CONCURRENCY` in cohort-read.ts.
 */
const LEDGER_CONCURRENCY = 8;

/** `items.map(fn)`, run at most `limit` at a time, order preserved — same shape cohort-read.ts uses. */
async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The digest's feature cards, grouped by outcome — `undefined` when `projectId` names no project.
 *
 * Only a feature with at least one event in `events` gets a card: this answers "what changed",
 * not "every feature that has ever existed". `events` not carrying a `featureId` (board-wide facts
 * like `autopilot.disarmed`/`scan.summary`, or a ticket whose nearest card ancestor is unresolved)
 * contribute no card — there is no feature to attribute them to.
 */
export async function digestFeatureGroups(
  db: AntonDb,
  projectId: string,
  events: readonly TimelineEvent[],
  { board: given, gatewayPricing }: DigestFeatureCardsOptions = {},
): Promise<DigestFeatureGroup[] | undefined> {
  const project = await getProjectById(db, projectId);
  if (!project) return undefined;

  const board = given ?? (await listAllBeads(project));
  const byId = new Map(board.map((b) => [b.id, b]));

  const eventsByFeature = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    if (!event.featureId || !byId.has(event.featureId)) continue;
    const list = eventsByFeature.get(event.featureId);
    if (list) list.push(event);
    else eventsByFeature.set(event.featureId, [event]);
  }
  const featureIds = [...eventsByFeature.keys()];

  const [outcomes, base, ledgers] = await Promise.all([
    readProjectOutcomes(project.repoPath),
    githubBaseUrl(project.repoPath),
    mapWithBoundedConcurrency(featureIds, LEDGER_CONCURRENCY, (id) =>
      featureLedger(db, projectId, id, { board, gatewayPricing }),
    ),
  ]);

  const cards = featureIds.map((id, i) =>
    attachPrUrl(
      featureCardOf(byId.get(id)!, eventsByFeature.get(id) ?? [], ledgers[i]?.totals.totals.usd),
      base,
    ),
  );

  return groupFeatureCards(cards, outcomes);
}

/** UI/read path over the shared anton.db — see {@link digestFeatureGroups}. */
export function projectDigestFeatureGroups(
  projectId: string,
  events: readonly TimelineEvent[],
  opts?: DigestFeatureCardsOptions,
): Promise<DigestFeatureGroup[] | undefined> {
  return digestFeatureGroups(getDb(), projectId, events, opts);
}
