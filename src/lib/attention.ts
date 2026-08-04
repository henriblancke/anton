/**
 * What needs the operator, worst first (anton-ue90.1).
 *
 * Three unrelated producers answer the same question — the run-health sweep raises escalations, the
 * gardener patrol reports hygiene findings, and the self-review gate scores run targets — and the
 * board used to render each of them as its own band with its own heading. They are one list, and
 * the only thing that orders it is what it costs to ignore a row:
 *
 *   • `stopped`      — work has HALTED and only a human can restart it. Nothing else outranks this.
 *   • `attention`    — nothing is stopped, but something can't be trusted: a dependency cycle breaks
 *                      the readiness `bd ready` serves, an abandoned in-progress bead reads as
 *                      in-flight to every other machine, and a run target in the rework band did not
 *                      satisfy its contract.
 *   • `housekeeping` — real, but nothing downstream is wrong today: contract gaps, staleness,
 *                      shipped-not-closed, duplicates.
 *
 * Pure and dependency-free on purpose: this runs in the browser, so it type-imports its inputs and
 * never reaches for the modules that produce them (lib/hygiene and lib/escalations both pull drizzle
 * and better-sqlite3). It decides severity and order ONLY — every label an operator reads is copy,
 * and copy lives in the component.
 */
import type {
  EscalationView,
  HygieneFinding,
  HygieneFindingKind,
  HygieneReport,
  ReviewTrajectory,
  ScoredTarget,
} from "@/lib/types";

export type AttentionSeverity = "stopped" | "attention" | "housekeeping";

/**
 * One row of the strip, discriminated by where it came from so the component can render each
 * source's own affordances — an escalation's Resume/Abandon, a finding's bead links, a score's
 * target link — without this module knowing anything about them.
 */
export type AttentionItem =
  | { key: string; severity: AttentionSeverity; source: "escalation"; escalation: EscalationView }
  | { key: string; severity: AttentionSeverity; source: "hygiene"; finding: HygieneFinding }
  | { key: string; severity: AttentionSeverity; source: "review"; target: ScoredTarget };

/**
 * Which findings mean the board is misreporting itself, and which are tidy-up.
 *
 * A cycle and an abandoned run are promoted because both make OTHER readers wrong: `bd ready` can't
 * order a ring, and an `in_progress` bead with no live lease tells every other machine that work is
 * underway. The rest are genuinely housekeeping — they cost nothing until someone gets to them, so
 * they are folded behind a count rather than shouted. A strip where everything is loud is a strip an
 * operator learns to skip.
 */
export const HYGIENE_KIND_SEVERITY: Record<HygieneFindingKind, AttentionSeverity> = {
  "dep-cycle": "attention",
  "stale-in-progress": "attention",
  lint: "housekeeping",
  "stale-open": "housekeeping",
  orphan: "housekeeping",
  duplicate: "housekeeping",
};

/**
 * Below this, the review contract's own anchored scale calls the work substantial rework
 * (skills/review/SKILL.md §5) — the same floor `scoreBand` uses for its `rework` band. A trend is
 * not an alert, so only a target that landed here is promoted out of the trend pill and into the
 * strip.
 */
export const REWORK_SCORE_CEILING = 5;

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  stopped: 0,
  attention: 1,
  housekeeping: 2,
};

/**
 * Tie-break inside a severity band. Fixed rather than by age or score: the bands already carry the
 * judgement, and a stable secondary order means two renders of an unchanged board are identical.
 */
const SOURCE_RANK: Record<AttentionItem["source"], number> = {
  escalation: 0,
  review: 1,
  hygiene: 2,
};

export interface AttentionInput {
  /** Open escalations — stalls the unstick pass could not safely restart. */
  escalations?: EscalationView[];
  /** The gardener's latest patrol, or undefined for a project that has never been patrolled. */
  hygiene?: HygieneReport;
  /** Recent review scores, or undefined for a project nothing has ever scored. */
  trajectory?: ReviewTrajectory;
}

export interface AttentionSummary {
  /** `stopped` and `attention` rows, worst first — what the strip renders as rows. */
  items: AttentionItem[];
  /** The rest, folded behind a count until asked for. */
  housekeeping: AttentionItem[];
  counts: Record<AttentionSeverity, number>;
  /**
   * True when something was actually CHECKED and found nothing — a patrol ran, or runs were scored,
   * and no item came out of it. Distinct from "nothing to say": a project that has never been
   * patrolled and never been scored is not a clean project, and must not be reported as one.
   */
  clean: boolean;
  /**
   * Whether the strip should render at all. False means no producer has ever reported: no
   * escalations, no patrol, no score. The strip renders NOTHING rather than an empty state, because
   * an empty state here is a claim ("clean") that nothing has earned.
   */
  reported: boolean;
}

/**
 * Merge the three producers into one ranked list.
 *
 * Order is total and deterministic — severity, then source, then the order the producer supplied.
 * Both producers already sort their own output (`openEscalations` by age, `sortFindings` by kind
 * then key), so preserving input order inside a band keeps two patrols over an unchanged board
 * rendering identically.
 */
export function rankAttention({
  escalations = [],
  hygiene,
  trajectory,
}: AttentionInput): AttentionSummary {
  const all: AttentionItem[] = [];

  for (const escalation of escalations) {
    all.push({
      key: `escalation:${escalation.id}`,
      severity: "stopped",
      source: "escalation",
      escalation,
    });
  }

  // Only the WORST target is promoted, and only from the rework band. Every scored target is
  // already visible on its own card; the strip's job is to name the one worth opening first.
  const worst = trajectory?.worst;
  if (worst && worst.score < REWORK_SCORE_CEILING) {
    all.push({
      key: `review:${worst.id}`,
      severity: "attention",
      source: "review",
      target: worst,
    });
  }

  for (const finding of hygiene?.findings ?? []) {
    all.push({
      key: `hygiene:${finding.key}`,
      severity: HYGIENE_KIND_SEVERITY[finding.kind],
      source: "hygiene",
      finding,
    });
  }

  const ordered = all
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] ||
        SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source] ||
        a.index - b.index,
    )
    .map(({ item }) => item);

  const counts: Record<AttentionSeverity, number> = {
    stopped: 0,
    attention: 0,
    housekeeping: 0,
  };
  for (const item of ordered) counts[item.severity] += 1;

  // A patrol that ran, or a score that exists, is a check that happened. An escalation is not — it
  // only ever exists when something IS wrong, so it can never make a board "clean".
  const reported = ordered.length > 0 || hygiene !== undefined || trajectory !== undefined;

  return {
    items: ordered.filter((item) => item.severity !== "housekeeping"),
    housekeeping: ordered.filter((item) => item.severity === "housekeeping"),
    counts,
    clean: ordered.length === 0 && (hygiene !== undefined || trajectory !== undefined),
    reported,
  };
}

/** Did the patrol change anything itself? Drives whether the applied tier is worth a line. */
export function hasAppliedActions(hygiene: HygieneReport | undefined): boolean {
  if (!hygiene) return false;
  return hygiene.actions.closedEpics.length > 0 || hygiene.actions.rowsRecomputed > 0;
}
