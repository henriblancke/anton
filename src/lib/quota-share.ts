/**
 * Per-project quota shares, as arithmetic (R6.1 / R6.3 / R6.4).
 *
 * Several repos run against ONE Claude subscription, so each declares a share of the weekly quota
 * rather than racing for whichever job the runner leases first. This module owns what that
 * declaration means: who is in the denominator right now, what each project's share works out to,
 * and which declared share is currently being spent somewhere else.
 *
 * APPROXIMATE by construction, and every caller must say so. Spend is attributed from `burn_samples`,
 * whose window only opens when a job runs ALONE and is discarded when a sibling dispatches — so a
 * busy machine attributes a fraction of what it actually spent. Shares are a PACING TARGET, never a
 * ledger, and a figure rendered as `12%` rather than `≈ 12%` is a claim this data cannot support.
 *
 * Client-safe and pure: it holds no db access and imports nothing from `jobs/`, so the settings
 * panel and the picker pass can share one definition of the split instead of drifting apart.
 */

/** What an operator may declare, as a percentage. 0 is legal — it parks a repo without disarming it. */
export const QUOTA_SHARE_RANGE = { min: 0, max: 100 } as const;

/** One project's declared position, as the split reads it. */
export interface QuotaShareProject {
  id: string;
  slug: string;
  name: string;
  /** The declared share, 0–100. Resolved: an unset project arrives carrying {@link defaultQuotaSharePct}. */
  sharePct: number;
  /** False = still on the equal-split default, so the panel can say the number was never chosen. */
  declared: boolean;
  /** Budget-aware execution is on. An ungoverned project spends unpaced and is not in the split. */
  governed: boolean;
  /** `reserve my share` (R6.5): held out of reallocation even while idle. */
  reserved: boolean;
  /**
   * The picker ranks startable work here, or quota-burning work is already in flight — what puts a
   * project in the denominator (R6.4). `null` = nothing observed it (the picker pass is not armed
   * here), which reads as "can spend": no share is renormalized away on a question nobody asked.
   */
  eligible: boolean | null;
  /**
   * Weekly quota attributed to this project, in the same percentage points the usage meter reads.
   * `null` when nothing on this machine is attributable to it yet — which is NOT zero spend, and
   * must never be rendered as `0%`.
   */
  spentWeeklyPct: number | null;
  /** The attribution still leans on tier seeds rather than measured burn — an estimate of an estimate. */
  seeded: boolean;
}

/** One row of the resolved split: what was declared, what is in force, and the gap between them. */
export interface QuotaShareRow extends QuotaShareProject {
  /** The declared share as a fraction of ALL declared shares — this project's cut when everyone is busy. */
  normalizedPct: number;
  /** The share actually in force this pass, after idle projects drop out of the denominator. */
  effectivePct: number;
  /** Idle, unreserved, and someone else can use it: this project's share is being spent elsewhere. */
  reallocated: boolean;
  /** Points gained from the projects that dropped out. 0 when nothing was reallocated. */
  gainedPct: number;
}

export interface QuotaSplit {
  rows: QuotaShareRow[];
  /** Σ declared shares across governed projects. */
  declaredTotalPct: number;
  /**
   * Σ NORMALIZED shares of the governed projects that dropped out of this pass's denominator — how
   * much of the split is currently being spent by somebody else. Normalized, not raw: the split the
   * panel shows and the governor enforces is already in proportion, so an imbalanced 30/30/30 board
   * with one idle project has 33.3 points in use elsewhere, not 30. 0 when nothing was reallocated.
   */
  reallocatedPct: number;
  /**
   * The declared shares do not sum to 100. Surfaced rather than silently normalized away: the split
   * below IS normalized, and an operator who declared 30/30/30 is owed the reason their cut reads 33.
   */
  imbalanced: boolean;
  /** Some row's spend still leans on tier seeds. */
  seeded: boolean;
  /** Σ attributed spend, or `null` when no project has an attributable figure at all. */
  spentTotalPct: number | null;
}

/** The share a project that has never declared one gets: an equal cut of the governed projects. */
export function defaultQuotaSharePct(governedCount: number): number {
  return governedCount > 0 ? 100 / governedCount : 100;
}

/**
 * A share as a proportion of some denominator. An empty denominator means nothing in it can spend,
 * so no share is in force — never a divide-by-zero and never an accidental 100.
 */
function proportionOf(sharePct: number, totalPct: number): number {
  return totalPct > 0 ? (sharePct / totalPct) * 100 : 0;
}

/**
 * Whether the declared shares fail to sum to 100. Only meaningful once something is governed — a
 * board of pure defaults sums to 100 by construction, and a board with no governed project has
 * nothing to balance.
 */
function isImbalanced(governedCount: number, declaredTotalPct: number): boolean {
  return governedCount > 0 && Math.round(declaredTotalPct) !== 100;
}

/** One budget-aware project's declaration, as the governor reads it off the store. */
export interface GovernedShare {
  projectId: string;
  /** What the operator declared, or absent when this project has never declared a share. */
  declaredPct?: number;
  /**
   * The picker ranks startable work here, or quota-burning work is already in flight (R6.4).
   * Absent/null means UNKNOWN, which reads as "can spend": a share is never renormalized away on a
   * question this machine never asked.
   */
  eligible?: boolean | null;
  /** `reserve my share` (R6.5): held in the denominator even while idle. */
  reserved?: boolean;
}

/** The share in force for one project, plus the board-level facts that produced it. */
export interface ResolvedQuotaShare {
  /** The share of the weekly target this project may spend, 0–100 (R6.1), after renormalization. */
  sharePct: number;
  /** The declaration it came from — the equal split when this project never declared one. */
  declaredPct: number;
  /** False = still on the equal-split default, so a caller can say the number was never chosen. */
  declared: boolean;
  /** Σ shares across every governed project. */
  declaredTotalPct: number;
  /** Σ shares across the projects in this pass's denominator — the divisor `sharePct` came from. */
  participantTotalPct: number;
  /** Some project dropped out of the denominator this pass, so `sharePct` exceeds the declaration. */
  renormalized: boolean;
  /** The declarations don't sum to 100. `sharePct` IS proportioned — say so, don't smooth it away. */
  imbalanced: boolean;
}

/**
 * Whether a project belongs in this pass's denominator: it holds eligible work, or it reserves its
 * share (R6.5), or its eligibility was never stated. Fail-open on the unknown is deliberate —
 * mistaking a busy repo for an idle one hands its quota to a neighbour and defers its work.
 */
function canSpend(project: { eligible?: boolean | null; reserved?: boolean }): boolean {
  return project.eligible !== false || project.reserved === true;
}

/**
 * The share `projectId` spends against right now, given every budget-aware project on this machine.
 *
 * Undeclared projects ride the equal split, so a machine that has declared nothing still divides its
 * quota rather than racing for it. Declarations that don't sum to 100 are taken in proportion — the
 * same arithmetic {@link resolveQuotaSplit} shows the operator, so the governor and the panel can
 * never disagree about a project's cut — with {@link ResolvedQuotaShare.imbalanced} carrying the
 * fact so a caller can surface it rather than quietly rescaling behind the operator's back.
 *
 * The denominator is RENORMALIZED per pass over the projects that can actually spend (R6.4): an idle
 * repo is simply absent from the divisor, so its share is spent by the repos that have work rather
 * than resetting unused at the end of the week. There is no lending ledger to unwind — the next pass
 * recomputes the divisor, so a repo that wakes up reclaims its cut with no operator action.
 * `reserve my share` (R6.5) is the opt-out: a reserved project stays in the divisor while idle, so a
 * repo touched irregularly keeps its allocation.
 *
 * The subject is ALWAYS in its own denominator. Resolving a ceiling for a project means that project
 * is asking to spend, so it is not idle whatever the last picker pass recorded; renormalizing it out
 * would hand it a 0% ceiling and defer its work forever — the opposite of the idle-fill this exists
 * to serve.
 *
 * A project absent from `board` is ungoverned and resolves to the whole 100: no share binds it, and
 * scaling its ceiling by someone else's split would pace a project the operator never armed.
 */
export function resolveGovernedShare(
  projectId: string,
  board: readonly GovernedShare[],
): ResolvedQuotaShare {
  const equalSplit = defaultQuotaSharePct(board.length);
  const declared = board.map((p) => p.declaredPct ?? equalSplit);
  const declaredTotalPct = declared.reduce((sum, pct) => sum + pct, 0);
  const imbalanced = isImbalanced(board.length, declaredTotalPct);
  const index = board.findIndex((p) => p.projectId === projectId);
  if (index < 0) {
    return {
      sharePct: 100,
      declaredPct: 100,
      declared: false,
      declaredTotalPct,
      participantTotalPct: declaredTotalPct,
      renormalized: false,
      imbalanced,
    };
  }
  const participantTotalPct = declared.reduce(
    (sum, pct, i) => (i === index || canSpend(board[i]) ? sum + pct : sum),
    0,
  );
  return {
    sharePct: proportionOf(declared[index], participantTotalPct),
    declaredPct: declared[index],
    declared: board[index].declaredPct !== undefined,
    declaredTotalPct,
    participantTotalPct,
    renormalized: participantTotalPct < declaredTotalPct,
    imbalanced,
  };
}

/**
 * Resolve the split in force right now.
 *
 * The denominator is the projects that can actually spend: governed, and either holding eligible
 * work or reserving their share. An idle repo is simply ABSENT from it — there is no lending ledger
 * to unwind, and a share that resets unused is wasted quota. A project that wakes up re-enters the
 * denominator on the next pass with no operator action.
 *
 * With nothing left in the denominator no share is in force and nothing is reallocated: an idle
 * machine is not lending anyone anything, and saying so would name a beneficiary that doesn't exist.
 */
export function resolveQuotaSplit(projects: readonly QuotaShareProject[]): QuotaSplit {
  const governed = projects.filter((p) => p.governed);
  const declaredTotalPct = governed.reduce((sum, p) => sum + p.sharePct, 0);
  const participants = governed.filter(canSpend);
  const participantTotal = participants.reduce((sum, p) => sum + p.sharePct, 0);

  const rows = projects.map<QuotaShareRow>((project) => {
    const participating = project.governed && canSpend(project);
    const normalizedPct = project.governed ? proportionOf(project.sharePct, declaredTotalPct) : 0;
    const effectivePct = participating ? proportionOf(project.sharePct, participantTotal) : 0;
    return {
      ...project,
      normalizedPct,
      effectivePct,
      reallocated:
        project.governed && !participating && participantTotal > 0 && project.sharePct > 0,
      gainedPct: Math.max(0, effectivePct - normalizedPct),
    };
  });

  const attributed = projects.filter((p) => p.spentWeeklyPct !== null);
  return {
    rows,
    declaredTotalPct,
    reallocatedPct: rows.reduce((sum, r) => (r.reallocated ? sum + r.normalizedPct : sum), 0),
    imbalanced: isImbalanced(governed.length, declaredTotalPct),
    seeded: projects.some((p) => p.seeded),
    spentTotalPct:
      attributed.length > 0 ? attributed.reduce((sum, p) => sum + (p.spentWeeklyPct ?? 0), 0) : null,
  };
}

/**
 * A percentage, marked approximate (R6.3). The `≈` is not decoration: it is the whole difference
 * between a pacing target and a bill, and it belongs to every spend and share figure this feature
 * renders.
 *
 * A null figure reads as unattributed, never as zero — "no sample" and "spent nothing" are opposite
 * facts, and collapsing them is exactly the lie the marker exists to prevent.
 */
export function formatApproxPct(pct: number | null, digits = 0): string {
  if (pct === null || !Number.isFinite(pct)) return "not sampled yet";
  // Under half a point at whole-percent precision, "≈ 0%" would read as "spent nothing". Say the
  // truer thing: it is below what this precision can show.
  const rounded = Number(pct.toFixed(digits));
  if (rounded === 0 && pct > 0) return `< ${(10 ** -digits).toFixed(digits)}%`;
  return `≈ ${rounded.toFixed(digits)}%`;
}
