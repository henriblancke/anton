import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DAYTIME_RESERVE_PCT,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_MIN_SCORE,
  DEFAULT_TICKET_TIMEOUT_MINUTES,
  DEFAULT_WEEKLY_TARGET_PCT,
} from "@/components/settings/settings-constants";
import {
  AUTONOMY_KINDS,
  resolveProposalAutonomy,
  type EarnedKind,
  type ProposalAutonomy,
} from "@/components/settings/settings-autonomy";
import type {
  DiscoveredAgent,
  EditableSettings,
  FormulaVariant,
  ValueLabelRow,
  VariantRow,
} from "@/components/settings/settings-types";

/**
 * Every editable field as one flat value — the staged edits, diffed against the persisted baseline
 * to decide what is dirty and serialized as the save body. One object rather than thirty `useState`
 * calls so the diff, the payload and the panels all read the same shape.
 */
export interface SettingsDraft {
  model: string;
  seedPrompt: string;
  reviewFixPrompt: string;
  productMasterPrompt: string;
  reviewEnabled: boolean;
  reviewAgent: string;
  reviewPrompt: string;
  reviewMaxRounds: number;
  reviewMinScore: number;
  reviewLowScoreRounds: number;
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  buildCommand: string;
  concurrency: number;
  jobTimeoutMinutes: number;
  ticketTimeoutMinutes: number;
  maxRetries: number;
  autonomy: boolean;
  conventionalCommits: boolean;
  budgetAware: boolean;
  daytimeReservePct: number;
  weeklyTargetPct: number;
  /** The enabled BUNDLED allowlist. User agents always run and are never members. */
  activeAgents: Set<string>;
  /** Per-label pipeline variants (anton-aa3m). Array order IS the precedence. */
  variantRows: VariantRow[];
  /** Nominated value labels (anton-prng). Array order IS the band order. */
  valueLabelRows: ValueLabelRow[];
  /** Per-kind proposal autonomy (anton-nbyy), held RESOLVED — "absent" is not a level. */
  proposalAutonomy: Record<string, ProposalAutonomy>;
}

/**
 * Seed the form from the persisted row.
 *
 * An absent bundled allowlist seeds "all bundled on", matching the runtime rule that an absent
 * allowlist means every bundled agent is active — so a no-op save stays all-active. A stored value
 * may carry stale user-agent ids from before the anton-dvo.1 reversal; they never match a bundled
 * toggle and are pruned by the bundled-only filter on save.
 */
export function draftFromSettings(
  settings: EditableSettings,
  bundledAgentIds: string[],
  earned: Record<string, EarnedKind>,
): SettingsDraft {
  return {
    model: settings.model ?? "",
    seedPrompt: settings.seedPrompt ?? "",
    reviewFixPrompt: settings.reviewFixPrompt ?? "",
    productMasterPrompt: settings.productMasterPrompt ?? "",
    // Absent → ON: the self-review gate runs unless the operator turns it off (anton-3apm).
    reviewEnabled: settings.reviewEnabled ?? true,
    reviewAgent: settings.reviewAgent ?? "",
    reviewPrompt: settings.reviewPrompt ?? "",
    reviewMaxRounds: settings.reviewMaxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS,
    reviewMinScore: settings.reviewMinScore ?? DEFAULT_REVIEW_MIN_SCORE,
    reviewLowScoreRounds: settings.reviewLowScoreRounds ?? DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
    testCommand: settings.testCommand ?? "",
    lintCommand: settings.lintCommand ?? "",
    typecheckCommand: settings.typecheckCommand ?? "",
    buildCommand: settings.buildCommand ?? "",
    concurrency: settings.concurrency ?? DEFAULT_CONCURRENCY,
    jobTimeoutMinutes: settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES,
    ticketTimeoutMinutes: settings.ticketTimeoutMinutes ?? DEFAULT_TICKET_TIMEOUT_MINUTES,
    maxRetries: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
    autonomy: settings.autonomy ?? true,
    conventionalCommits: settings.conventionalCommits ?? false,
    budgetAware: settings.budgetAware ?? false,
    daytimeReservePct: settings.budgetPolicy?.daytimeReservePct ?? DEFAULT_DAYTIME_RESERVE_PCT,
    weeklyTargetPct: settings.budgetPolicy?.weeklyTargetPct ?? DEFAULT_WEEKLY_TARGET_PCT,
    activeAgents: new Set(settings.agents ?? bundledAgentIds),
    // Rows carry a stable local id purely as a React key — reordering with index keys would move
    // the operator's cursor between inputs.
    variantRows: (settings.formulaVariants ?? []).map((v, i) => ({ id: `v${i}`, ...v })),
    valueLabelRows: (settings.valueLabels ?? []).map((label, i) => ({ id: `vl${i}`, label })),
    proposalAutonomy: resolveProposalAutonomy(settings.proposalAutonomy, earned),
  };
}

/**
 * The draft fields each of SECTIONS' `dirtyKeys` covers.
 *
 * A table rather than a hand-written comparison per key: the save bar names the SECTION an edit
 * lives in, so every field has to belong to exactly one key, and a field added to the draft without
 * a home here would be saved but never announced as unsaved. Lists and the autonomy policy are
 * compared by their own rules below and are deliberately absent.
 */
const DIRTY_FIELDS: Record<string, (keyof SettingsDraft)[]> = {
  model: ["model"],
  seedPrompt: ["seedPrompt"],
  reviewFixPrompt: ["reviewFixPrompt"],
  productMasterPrompt: ["productMasterPrompt"],
  concurrency: ["concurrency"],
  jobTimeoutMinutes: ["jobTimeoutMinutes"],
  ticketTimeoutMinutes: ["ticketTimeoutMinutes"],
  maxRetries: ["maxRetries"],
  autonomy: ["autonomy"],
  conventionalCommits: ["conventionalCommits"],
  budget: ["budgetAware", "daytimeReservePct", "weeklyTargetPct"],
  gates: ["testCommand", "lintCommand", "typecheckCommand", "buildCommand"],
  review: [
    "reviewEnabled",
    "reviewAgent",
    "reviewPrompt",
    "reviewMaxRounds",
    "reviewMinScore",
    "reviewLowScoreRounds",
  ],
};

/**
 * Which staged edits differ from what is persisted, keyed by the names SECTIONS declares.
 *
 * The save bar reads this to name the sections it is about to submit. Without it, the only signal
 * that anything was edited is a button that looks identical whether or not it will do something —
 * which on a page where one panel (Automation) saves immediately and every other waits for Save is
 * how an operator loses an edit they thought had landed.
 *
 * The persisted row is compared as a DRAFT, seeded through {@link draftFromSettings}: an absent
 * field and the default it seeds to are the same value, so an untouched form is never dirty and
 * "what a stored row means" is defined once rather than re-spelled per comparison.
 */
export function dirtyFields(
  draft: SettingsDraft,
  baseline: EditableSettings,
  bundledAgentIds: string[],
  earned: Record<string, EarnedKind>,
): Record<string, boolean> {
  const saved = draftFromSettings(baseline, bundledAgentIds, earned);
  return {
    ...Object.fromEntries(
      Object.entries(DIRTY_FIELDS).map(([key, fields]) => [
        key,
        fields.some((field) => changed(draft[field], saved[field])),
      ]),
    ),
    // A stale user-agent id in the staged set is not an edit — the save prunes it — so the
    // allowlist is compared as the save would send it.
    agents: !sameIds(
      bundledAgentIds.filter((id) => draft.activeAgents.has(id)),
      [...saved.activeAgents],
    ),
    formulaVariants: !sameVariants(draft.variantRows, saved.variantRows),
    valueLabels: !sameLabels(
      nominatedLabels(draft.valueLabelRows),
      nominatedLabels(saved.valueLabelRows),
    ),
    // Resolved on both sides: the baseline holds only the kinds an operator armed, so comparing the
    // raw maps would read the shipped default as an edit on every render.
    proposalAutonomy: AUTONOMY_KINDS.some(
      (kind) => draft.proposalAutonomy[kind.id] !== saved.proposalAutonomy[kind.id],
    ),
  };
}

/** Trimmed for text, so trailing whitespace is not an edit — the same way the save serializes it. */
function changed(staged: unknown, saved: unknown): boolean {
  return typeof staged === "string" && typeof saved === "string"
    ? staged.trim() !== saved.trim()
    : staged !== saved;
}

/** What Save PATCHes. "" clears an override → the shipped default applies. */
export function settingsPatchBody(
  draft: SettingsDraft,
  bundledAgentIds: string[],
  agents: DiscoveredAgent[],
): Record<string, unknown> {
  return {
    // "" clears the override → driver runs with no --model / no seed / the default review-fix prompt.
    model: orNull(draft.model),
    seedPrompt: orNull(draft.seedPrompt),
    reviewFixPrompt: orNull(draft.reviewFixPrompt),
    productMasterPrompt: orNull(draft.productMasterPrompt),
    // Self-review gate (anton-3apm). The knobs are sent even while the gate is off, so turning it
    // back on restores the operator's reviewer instead of silently resetting it.
    reviewEnabled: draft.reviewEnabled,
    // A stored reviewer whose agent has since been deleted is shown but NOT resubmitted: the
    // PATCH rejects unknown ids, which would fail every unrelated save until someone noticed.
    // Omitting the key leaves the stored id untouched — runtime already falls back on its own.
    ...(reviewerMissing(draft.reviewAgent, agents)
      ? {}
      : { reviewAgent: orNull(draft.reviewAgent) }),
    reviewPrompt: orNull(draft.reviewPrompt),
    reviewMaxRounds: draft.reviewMaxRounds,
    reviewMinScore: draft.reviewMinScore,
    reviewLowScoreRounds: draft.reviewLowScoreRounds,
    // "" clears a verify gate → it's skipped (no behavior change).
    testCommand: orNull(draft.testCommand),
    lintCommand: orNull(draft.lintCommand),
    typecheckCommand: orNull(draft.typecheckCommand),
    buildCommand: orNull(draft.buildCommand),
    // Per-label pipeline variants (anton-aa3m), in the order shown — that order is the precedence.
    // A half-filled row is scaffolding, not a mapping, so it's dropped rather than 400ing the whole
    // save; [] clears the map (every run walks the project's default).
    formulaVariants: stagedVariants(draft.variantRows),
    // Nominated value labels (anton-prng), in the order shown — that order is the band order.
    // Blank scaffolding rows and a repeat nomination (unreachable by definition — the first match
    // wins) are dropped rather than 400ing the whole save; [] clears the nominations, which puts
    // ranking back on native fields alone.
    valueLabels: nominatedLabels(draft.valueLabelRows),
    concurrency: draft.concurrency,
    jobTimeoutMinutes: draft.jobTimeoutMinutes,
    ticketTimeoutMinutes: draft.ticketTimeoutMinutes,
    maxRetries: draft.maxRetries,
    // The enabled BUNDLED ids, in discovered order. Only bundled ids we actually rendered — a
    // stale id from a since-deleted or user agent (still in the seeded set) is pruned rather than
    // re-persisted, so user agents never leak into the bundled allowlist.
    agents: bundledAgentIds.filter((id) => draft.activeAgents.has(id)),
    autonomy: draft.autonomy,
    conventionalCommits: draft.conventionalCommits,
    budgetAware: draft.budgetAware,
    // Only the two exposed knobs; the server deep-merges into the stored policy, so knobs set via
    // the API (dayWindow, minSessionHeadroomPct, …) survive a save from this form.
    budgetPolicy: {
      daytimeReservePct: draft.daytimeReservePct,
      weeklyTargetPct: draft.weeklyTargetPct,
    },
    // Every kind this build renders, at its resolved level. Explicit `propose` entries and not
    // omissions: the server merges per kind, so an omitted kind keeps whatever it held — which is
    // how disarming one would silently fail to persist.
    proposalAutonomy: draft.proposalAutonomy,
  };
}

/** An override the operator cleared — "" means "no override", which the API spells `null`. */
function orNull(value: string): string | null {
  return value.trim() || null;
}

/** A stored reviewer id that no longer resolves to a discoverable agent — shown, never resubmitted. */
export function reviewerMissing(value: string, agents: DiscoveredAgent[]): boolean {
  return value !== "" && !agents.some((a) => a.id === value);
}

/** Order-insensitive id-set equality — the allowlist is a set, so a reorder is not an edit. */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}

/** The mappings a save would send: trimmed, with half-filled scaffolding rows dropped. */
function stagedVariants(rows: VariantRow[]): FormulaVariant[] {
  return rows
    .map((v) => ({ label: v.label.trim(), formula: v.formula.trim() }))
    .filter((v) => v.label && v.formula);
}

/**
 * Variant equality, compared the way the save serializes. Order IS significant here — the list's
 * order is the precedence an operator tunes, so moving a row is a real edit even though the set is
 * unchanged.
 */
function sameVariants(rows: VariantRow[], stored: FormulaVariant[]): boolean {
  const staged = stagedVariants(rows);
  if (staged.length !== stored.length) return false;
  return staged.every((v, i) => v.label === stored[i].label && v.formula === stored[i].formula);
}

/**
 * The nominations a save would send: trimmed, blanks dropped, and a repeat dropped rather than sent.
 * A label nominated twice can never reach its second tier (the first match wins), so the server
 * rejects it — pruning it here keeps one stray duplicate from failing an otherwise valid save.
 */
export function nominatedLabels(rows: ValueLabelRow[]): string[] {
  const seen = new Set<string>();
  return rows
    .map((r) => r.label.trim())
    .filter((label) => label !== "" && !seen.has(label) && (seen.add(label), true));
}

/** Ordered label equality — the list's order is the band order, so a reorder IS an edit. */
function sameLabels(staged: string[], stored: string[]): boolean {
  return staged.length === stored.length && staged.every((label, i) => label === stored[i]);
}
