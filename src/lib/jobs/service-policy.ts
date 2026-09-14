/**
 * The per-job policy sources the runner reads at lease time (anton-6fo2): a project's
 * concurrency/timeout/retry policy, the budget governor's policy, the meter it paces against, the
 * cross-machine run-liveness gate, and the bead labels the value gate ranks on. Split out of
 * service.ts so anton's public job API doesn't carry the settings + beads fan-out these resolvers
 * need. Wired into the runner by ./service-runner.
 */
import { getDb } from "../db";
import {
  budgetAwareQuotaShares,
  DEFAULT_CONCURRENCY,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REVIEW_FIX_CONCURRENCY,
  getProjectById,
  getProjectSettings,
  quotaMeterKey,
  resolveBudgetPolicy as resolveBudgetPolicyFromSettings,
} from "../projects";
import {
  resolveGovernedShare,
  type GovernedShare,
  type ResolvedQuotaShare,
} from "../quota-share";
import { projectWeeklySpendPct } from "../quota-spend";
import { withQuotaShare } from "./budget";
import type { ClaudeUsage } from "../claude/usage";
import { getRouterUsageCached, getRouterUsageFresh } from "../claude/router-usage";
import { beads } from "../beads/bd";
import { allIssues } from "../beads/issues";

/** Read a project's job policy from its settings, filling in defaults for any unset field. */
export async function resolvePolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  return {
    concurrency: settings.concurrency ?? DEFAULT_CONCURRENCY,
    // Per-PR review fixes get their own ceiling (anton-kwi6): the fan-out is unbounded by the
    // number of PRs in review, so without it a busy review day fills the global slot pool.
    reviewFixConcurrency: settings.reviewFixConcurrency ?? DEFAULT_REVIEW_FIX_CONCURRENCY,
    timeoutMs: (settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES) * 60_000,
    maxAttempts: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
    // Autonomy master-switch (anton-y3l): off pauses claiming of this project's execute-epic
    // jobs (they stay queued); absent defaults to on. See JobPolicy.autonomy in runner.ts.
    autonomy: settings.autonomy ?? true,
  };
}

/**
 * Per-project budget policy for the proactive governor (anton-szld), gated by the budget-aware
 * master-switch (anton-7mpv.1). Returns `null` unless the project has `budgetAware` turned ON — off is
 * the default — which the runner reads as "not governed": it never defers that project's work AND
 * never reads Claude usage on its behalf, so the nav usage pill isn't starved of the shared cache.
 * When on, it projects the operator's knobs onto the governor's full {@link BudgetPolicy}. A
 * project-less job is never budget-aware (empty settings → off).
 *
 * The quota share (R6.1) is applied HERE rather than as a second gate downstream: several repos run
 * against one subscription, so a governed project's weekly ceiling carries its share of the target,
 * and the one place that already decides "governed or not" is the one place that should decide "how
 * much". A share belongs to a meter pool, so projects on different router connections (or a router
 * and Anthropic) normalize independently; ungoverned projects remain untouched because they return
 * null before any board share is read.
 */
export async function resolveBudgetPolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  if (!projectId || !settings.budgetAware) return null;
  // Fail open, like every other governor read: an unreadable board is an EMPTY board, on which the
  // subject is absent and so ungoverned — the full weekly target for one tick — rather than a
  // rejection shared by every policy the coalesced read served, which would error the whole tick.
  const share = resolveGovernedShare(projectId, meterShareBoard(await quotaShareBoard().catch(() => []), settings));
  announceImbalance(quotaMeterKey(settings), share);
  return withQuotaShare(resolveBudgetPolicyFromSettings(settings), share.sharePct);
}

/** The board read currently in flight, so concurrent resolutions share it. Never held past settle. */
let inFlightShareBoard: Promise<GovernedShare[]> | null = null;

/**
 * The quota-share board, coalesced across CONCURRENT resolutions (PR #248 review). A share is a fact
 * about the whole board, so every governed project's policy needs the same three reads — all
 * projects, every picker plan, every in-flight job. The governor resolves one policy per governed
 * project on each 2s tick, which without this re-reads one unchanging DB state N times per tick.
 *
 * Coalescing, not caching: the promise is dropped the moment it settles, so the NEXT pass still
 * reads fresh — which is what lets a waking repo reclaim its cut on that pass rather than after a
 * cache expiry (R6.4). It only collapses reads that overlap, so callers must resolve their pass
 * together (see the runner's governor) to get the benefit; a sequential caller simply reads again.
 */
function quotaShareBoard(): Promise<GovernedShare[]> {
  if (inFlightShareBoard) return inFlightShareBoard;
  const board = budgetAwareQuotaShares().finally(() => {
    if (inFlightShareBoard === board) inFlightShareBoard = null;
  });
  inFlightShareBoard = board;
  return board;
}

/** The share denominator is one effective meter, never unrelated account/router pools. */
function meterShareBoard(board: readonly GovernedShare[], settings: Parameters<typeof quotaMeterKey>[0]) {
  const meterKey = quotaMeterKey(settings);
  return board.filter((project) => (project.meterKey ?? "anthropic") === meterKey);
}

/**
 * What the governor measures a project's share ceiling against (R6.1): this project's OWN attributed
 * weekly spend. The share cannot be enforced on the account meter `budgetGate` reads — that number
 * is moved by every repo on the machine, so gating it per-share would stop them all at one repo's
 * cut and leave the rest of the operator's weekly target unspendable (idle-fill, anton-ld7j).
 *
 * `usage` comes from the governor's own read so the spend window is anchored to the same weekly
 * reset the gate is deciding against. Fails soft to `null` — unattributed, never zero — so a db
 * hiccup relaxes the share rather than parking the project.
 */
export async function resolveProjectMeterKey(projectId: string | null): Promise<string> {
  if (!projectId) return "anthropic";
  const settings = await getProjectSettings(getDb(), projectId);
  return quotaMeterKey(settings);
}

export async function resolveProjectSpend(
  projectId: string | null,
  usage: ClaudeUsage | null,
): Promise<number | null> {
  if (!projectId) return null;
  try {
    return await projectWeeklySpendPct(
      getDb(),
      projectId,
      usage,
      Date.now(),
      await resolveProjectMeterKey(projectId),
    );
  } catch {
    return null;
  }
}

/**
 * The meter a governed project actually paces against (anton-gnvw): its router's own usage when
 * routed through a gateway, the tick's account-wide read otherwise. `getRouterUsageCached` already
 * carries the short-TTL cache + single-flight + 429 backoff, keyed per (baseUrl, connectionId) — so
 * two routed projects sharing one router connection in the same tick still take one request. A router
 * or settings read that cannot be completed collapses to `null`; only successfully read, genuinely
 * unrouted settings use the account meter.
 */
export async function resolveProjectUsage(
  projectId: string | null,
  accountUsage: () => Promise<ClaudeUsage | null>,
): Promise<ClaudeUsage | null> {
  return resolveProjectMeter(projectId, accountUsage, getRouterUsageCached);
}

/**
 * Fresh meter resolver for burn samples. Unlike governor reads, both window edges must hit the
 * upstream meter so a routed job cannot subtract a cached router snapshot from itself.
 */
export async function resolveProjectUsageFresh(
  projectId: string | null,
  accountUsage: () => Promise<ClaudeUsage | null>,
  expectedMeterKey?: string,
): Promise<ClaudeUsage | null> {
  if (!projectId) return expectedMeterKey && expectedMeterKey !== "anthropic" ? null : accountUsage();
  const settings = await getProjectSettings(getDb(), projectId).catch(() => null);
  if (!settings) return null;
  const meterKey = quotaMeterKey(settings);
  if (expectedMeterKey && meterKey !== expectedMeterKey) return null;
  if (meterKey === "anthropic") return accountUsage();
  return getRouterUsageFresh(settings).catch(() => null);
}

async function resolveProjectMeter(
  projectId: string | null,
  accountUsage: () => Promise<ClaudeUsage | null>,
  readRouter: typeof getRouterUsageCached,
): Promise<ClaudeUsage | null> {
  if (!projectId) return accountUsage();
  const settings = await getProjectSettings(getDb(), projectId).catch(() => undefined);
  if (settings === undefined) return null;
  if (quotaMeterKey(settings) === "anthropic") return accountUsage(); // unrouted → today's meter
  // Routed: the account meter is not this project's traffic, so it is never read on its behalf —
  // `accountUsage` goes uncalled and a router-only board makes no Anthropic request this tick.
  return readRouter(settings).catch(() => null);
}

/** The last imbalance announced for each independent quota meter. */
const lastImbalanceAnnounced = new Map<string, string>();

/**
 * Say out loud when the declared shares don't sum to 100. The governor proportions them anyway — an
 * under-declared board must not leave weekly quota unspendable (idle-fill, anton-ld7j) — but an
 * operator who declared 30/30/30 is owed the reason their ceiling reads 33, not a number that
 * silently changed under them. The settings panel carries the same fact; this is for the operator
 * watching the runner rather than the panel.
 */
function announceImbalance(meterKey: string, share: ResolvedQuotaShare): void {
  const imbalance = share.imbalanced ? String(Math.round(share.declaredTotalPct)) : "";
  if (imbalance === lastImbalanceAnnounced.get(meterKey)) return;
  lastImbalanceAnnounced.set(meterKey, imbalance);
  if (!imbalance) return;
  console.warn(
    `[jobs] quota shares across budget-aware projects total ${imbalance}%, not 100% — each project's weekly ceiling is its declared share in proportion (Settings → Quota shares)`,
  );
}

/**
 * Cross-machine run-liveness source for the runner (anton-jz1). Reads the shared beads board to
 * tell whether an execute-epic run is already live for this epic on ANOTHER machine — the `jobs`
 * table is machine-local, so a Force run on machine B can't otherwise see a run executing on
 * machine A and would double-run it. Pulls the shared board FIRST: the local Dolt working set can
 * be a sync heartbeat (~30s) behind, so without a pull a lease machine A published moments ago
 * reads as absent and this gate lets B enqueue a second concurrent run — the exact race the lease
 * exists to close. Fails open (returns false) so a transient beads read never blocks a legitimate
 * run; the local dedupe + `jobs_active_epic_unique` still backstop same-machine.
 */
export async function liveRunCheck(projectId: string, epicBeadId: string): Promise<boolean> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return false;
    // Best-effort: a pull failure (offline, transient) falls back to the local snapshot rather
    // than blocking the check — the same fail-open posture as the surrounding try/catch.
    await beads.pull(project.repoPath).catch(() => {});
    const bead = await beads.show(project.repoPath, epicBeadId);
    return beads.isRunLive(bead, Date.now());
  } catch {
    return false;
  }
}

/**
 * Bead-label source for the runner's per-job value gate (anton-k05r): the labels of a queued
 * execute-epic job's target bead, so `jobValueScore` can rank governed work at lease time. Serves
 * off the shared issue snapshot (warm within its max-age) rather than `bd show`, so the 2s runner
 * tick never spawns bd per queued job. Returns `null` on any miss — the gate fails open on null.
 */
export async function readBeadLabels(
  projectId: string,
  beadId: string,
): Promise<readonly string[] | null> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return null;
    const bead = (await allIssues(project.repoPath)).find((b) => b.id === beadId);
    return bead?.labels ?? null;
  } catch {
    return null;
  }
}
