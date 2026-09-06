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
  /** The picker currently ranks startable work here — what puts a project in the denominator (R6.4). */
  eligible: boolean;
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
  const participants = governed.filter((p) => p.eligible || p.reserved);
  const participantTotal = participants.reduce((sum, p) => sum + p.sharePct, 0);

  const rows = projects.map<QuotaShareRow>((project) => {
    const participating = project.governed && (project.eligible || project.reserved);
    const normalizedPct =
      project.governed && declaredTotalPct > 0 ? (project.sharePct / declaredTotalPct) * 100 : 0;
    const effectivePct =
      participating && participantTotal > 0 ? (project.sharePct / participantTotal) * 100 : 0;
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
    // Only meaningful once something is declared — a board of pure defaults sums to 100 by
    // construction, and a board with no governed project has nothing to balance.
    imbalanced: governed.length > 0 && Math.round(declaredTotalPct) !== 100,
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
