/**
 * How far a pass may go with a proposal it just filed (anton-nbyy) — the policy as DATA, decided in
 * one place before anything consults it.
 *
 * Three values, and the middle one is why the feature is affordable: `propose` files the proposal and
 * stops (everything anton does today), `shadow` also records what applying it WOULD have done, and
 * `apply` writes it. The decision is per KIND rather than per producer, because what a mistake costs
 * is a property of the move: a `degraded-approval` unapprove and a `shipped-orphan` close come out of
 * the same pass and are nothing alike to get wrong.
 *
 * TWO hard floors sit under the policy, and both are consulted before it. A `split` and a targetless
 * re-parent have no mechanical move to run, so {@link autonomyFor} answers `propose` for them
 * whatever the setting says. And a kind whose own proposals have not EARNED it (anton-m29g) cannot
 * be armed either: the founder's accept/decline verdicts arrive here as DATA — a
 * {@link ProposalTrackRecord}, derived from the board by the caller (track-record.ts) exactly as the
 * policy is derived from settings — and a kind below its bar resolves to `propose` under an `apply`
 * policy. Shadow mode answers "would this apply CLEANLY?"; nothing but the record answers "is this
 * proposal RIGHT?".
 *
 * That second floor is not the gardener's alone. The board-picker faces the identical trap — a plan
 * that ranks a target proves the executor, never the judgment — so it reads the SAME bars through
 * {@link earnedPickerAutonomy} (anton-vkp9), over the operator's releases and vetoes instead of over
 * a kind's proposals. One trust ladder, two records; a second one would be a second thing to keep
 * honest.
 *
 * Pure values, in the same sense detections.ts is: nothing here reads a board, a settings store, or a
 * bead. That purity is what lets both floors be PROVEN properties instead of comments.
 */
import {
  GARDENER_DETECTION_KINDS,
  isManualProposal,
  KINDS,
  type GardenerDetectionKind,
  type GardenerMove,
  type RetireVerb,
} from "./detections";

/**
 * The three values, ordered by how much of the move the pass is trusted to make — which is also the
 * order the settings control offers them in, so "further right is more autonomous" reads the same in
 * the type and on screen.
 */
export const PROPOSAL_AUTONOMY_LEVELS = ["propose", "shadow", "apply"] as const;

export type ProposalAutonomy = (typeof PROPOSAL_AUTONOMY_LEVELS)[number];

/**
 * The resolved policy: every kind decided, never partial. Written as a total `Record` on purpose —
 * adding a detection kind without deciding what it defaults to is a type error at
 * {@link DEFAULT_PROPOSAL_AUTONOMY_POLICY} rather than a kind that silently inherits someone's
 * fallback branch.
 */
export type ProposalAutonomyPolicy = Record<GardenerDetectionKind, ProposalAutonomy>;

/** What a project STORES: only the kinds an operator moved off the default. */
export type ProposalAutonomyOverrides = Partial<ProposalAutonomyPolicy>;

/**
 * The shipped policy. `propose` everywhere, so a project that never opens the setting behaves exactly
 * as it did before this existed — arming anything is an act, never an upgrade side effect.
 */
export const DEFAULT_PROPOSAL_AUTONOMY_POLICY: ProposalAutonomyPolicy = {
  "container-orphan": "propose",
  "parentless-cluster": "propose",
  "implied-order": "propose",
  superseded: "propose",
  stale: "propose",
  "shipped-orphan": "propose",
  mispriority: "propose",
  "missing-order": "propose",
  misfiled: "propose",
  oversized: "propose",
  "low-value": "propose",
  "degraded-approval": "propose",
  "withheld-approval": "propose",
};

function isAutonomy(value: unknown): value is ProposalAutonomy {
  return typeof value === "string" && (PROPOSAL_AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function isDetectionKind(value: string): value is GardenerDetectionKind {
  return (GARDENER_DETECTION_KINDS as readonly string[]).includes(value);
}

/**
 * The shipped policy with a project's stored overrides applied — never partial.
 *
 * Takes `unknown` and DROPS what it doesn't recognise rather than throwing: this reads a settings blob
 * a human can hand-edit and a future anton can write kinds into, and a pass is the wrong place to
 * discover that. An entry anton can't read falls back to `propose`, which is the safe direction — the
 * loud rejection belongs at the settings boundary, where an operator is there to see it.
 */
export function resolveProposalAutonomyPolicy(overrides?: unknown): ProposalAutonomyPolicy {
  const policy = { ...DEFAULT_PROPOSAL_AUTONOMY_POLICY };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return policy;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (isDetectionKind(key) && isAutonomy(value)) policy[key] = value;
  }
  return policy;
}

// ── the earned-autonomy floor (anton-m29g) ──

/**
 * What a wrong move COSTS — the reversibility grouping the settings control already presents to the
 * founder (settings-autonomy.ts `AUTONOMY_GROUPS`), reused here because a bar is a price and these are
 * the three prices this board knows how to name:
 *
 *   • `reversible` — the graph moves; one bd write puts it back and nothing is recorded as having
 *     happened.
 *   • `dequeued`   — the bead and its contract survive untouched, but nothing picks it up next. A
 *     wrong one is a week the bead sat still, found only by reading the record.
 *   • `history`    — the write outlives its own undo. A close is a CLAIM about what happened ("this
 *     shipped", "that replaced it"); an approve STARTS a run. Reopening is one write and undoing a
 *     grant is two — the label, then the reservation, since nothing releases a target still shown as
 *     approved — but the claim stays in the board's history and in every report already taken from
 *     it, and the run it released has already spent what it spent.
 */
export type AutonomyTier = "reversible" | "dequeued" | "history";

/** What a kind's record must show before its tier may be armed. */
export interface EarnedAutonomyBar {
  /** Settled proposals required in the window — below this the kind has no record, not a bad one. */
  minSettled: number;
  /** How many of those the founder must have ACCEPTED, as a percentage. */
  minAppliedPct: number;
}

/**
 * How many settled proposals per kind the record is counted over — a ROLLING window, deliberately.
 *
 * A detector gets rewritten (anton-9hpp rewrites `detectParentlessClusters`), and a rewritten
 * detector's old record describes a different algorithm. A window self-heals after a fix and stays
 * responsive to drift, with no manual reset flag for anyone to forget to set. Wider than the dearest
 * bar below, so clearing that bar still means clearing it on recent work rather than on every
 * proposal the kind has ever filed.
 */
export const EARNED_AUTONOMY_WINDOW = 30;

/**
 * The bar each tier clears at — the ONE place these numbers are stated.
 *
 * Tiered rather than uniform for the reason this module already tiers the policy: what a mistake
 * costs is a property of the move, and a re-parent one write undoes is not the same risk as a close
 * that records work as SHIPPED. Both halves matter and neither substitutes for the other —
 * `minSettled` is "has the founder seen enough of these to have an opinion", `minAppliedPct` is
 * "and was the opinion yes".
 */
export const EARNED_AUTONOMY_BARS: Record<AutonomyTier, EarnedAutonomyBar> = {
  reversible: { minSettled: 10, minAppliedPct: 80 },
  dequeued: { minSettled: 15, minAppliedPct: 85 },
  history: { minSettled: 20, minAppliedPct: 90 },
};

/**
 * Which tier a move belongs to. Read off the MOVE and its retirement verb rather than the kind,
 * because that is where the cost lives: `stale` and `shipped-orphan` are both a `retire`, and one
 * parks a bead while the other writes that it shipped.
 */
export function autonomyTierOf(plan: { move: GardenerMove; retireAs?: RetireVerb }): AutonomyTier {
  switch (plan.move) {
    case "reparent":
    case "link":
    case "reprioritize":
      return "reversible";
    case "unapprove":
      return "dequeued";
    case "retire":
      return plan.retireAs === "defer" ? "dequeued" : "history";
    case "approve":
      // The one move that STARTS work, and the dearest thing here to get wrong: what follows the
      // label is a run that spends tokens and opens a PR, and withdrawing the approval afterwards
      // does not un-run it. That outliving of the undo is exactly what this tier prices.
      return "history";
    case "split":
      // No mechanical move at all, so this is never reached through {@link autonomyFor} — the manual
      // floor answers first. Priced at the dearest tier regardless: a move that fell through to the
      // cheapest bar by accident is the one failure this table must not have.
      return "history";
  }
}

/** One kind's settled-proposal record: how many settled in the window, and how many were applied. */
export interface KindTrackRecord {
  settled: number;
  applied: number;
}

/**
 * Every kind's record — total, like the policy, so "this kind has no record" is an explicit zero
 * rather than an absent key some branch reads as "fine".
 */
export type ProposalTrackRecord = Record<GardenerDetectionKind, KindTrackRecord>;

/** A record of nothing: what a board with no settled proposal yields, and what every kind starts at. */
export function emptyTrackRecord(): ProposalTrackRecord {
  return Object.fromEntries(
    GARDENER_DETECTION_KINDS.map((kind) => [kind, { settled: 0, applied: 0 }]),
  ) as ProposalTrackRecord;
}

/** Whether a kind's record clears its tier's bar, and — when it does not — what to tell the founder. */
export interface EarnedAutonomy {
  tier: AutonomyTier;
  bar: EarnedAutonomyBar;
  settled: number;
  applied: number;
  /** May this kind be armed at `apply` at all? */
  eligible: boolean;
  /**
   * Why `apply` is unavailable, with the counts — never a bare "locked". A disabled control an
   * operator cannot account for is the failure this whole floor exists to avoid repeating.
   */
  reason?: string;
}

/**
 * How a record's counts are SAID. The only thing that differs between the two records this floor
 * reads: a gardener kind's proposals are APPLIED or declined, the picker's picks are RELEASED or
 * vetoed, and an operator should meet each in the words of the surface they answered it on.
 */
interface RecordWords {
  /** What a decided item is called in the plural — "settled proposals", "answered picks". */
  decided: string;
  /** The word for a decided item in the bar itself — "settled", "answered". */
  bar: string;
  /** The accepting verb — "applied", "released". */
  accepted: string;
}

const PROPOSAL_WORDS: RecordWords = {
  decided: "settled proposals",
  bar: "settled",
  accepted: "applied",
};

const PICKER_WORDS: RecordWords = {
  decided: "answered picks",
  bar: "answered",
  accepted: "released",
};

/**
 * Does this record clear this bar, and — when it does not — what the counts are, in the record's own
 * words.
 *
 * The ONE place either record is weighed. The gardener's kinds and the picker (anton-vkp9) reach
 * `apply` through this function and the {@link EARNED_AUTONOMY_BARS} table above it, so there is one
 * trust ladder to reason about and no second one to keep in step with it.
 *
 * A reason always carries the counts, never a bare "locked": the evidence for the nine bad
 * re-parents was printed every time and read by nobody, so a floor that refuses without saying what
 * it refused ON is the same failure with a lock on it.
 */
function clearsBar(
  bar: EarnedAutonomyBar,
  counts: { settled: number; accepted: number },
  words: RecordWords,
): { eligible: boolean; reason?: string } {
  const { settled, accepted } = counts;
  const so_far = `${accepted}/${settled} ${words.accepted}`;
  const unlocks = `apply unlocks at ${bar.minSettled} ${words.bar} with ${bar.minAppliedPct}% ${words.accepted}`;

  if (settled < bar.minSettled) {
    const has = settled === 0 ? `no ${words.decided} yet` : so_far;
    return { eligible: false, reason: `${has} — ${unlocks}` };
  }
  const pct = Math.round((accepted / settled) * 100);
  if (pct < bar.minAppliedPct) {
    return { eligible: false, reason: `${so_far} (${pct}%) — ${unlocks}` };
  }
  return { eligible: true };
}

/**
 * Has this kind's own record earned the right to be armed?
 *
 * Pure over (move, record), like everything else here. The counts arrive already windowed by the
 * caller that derived them from the board — this decides only whether they clear the bar, so the
 * settings surface and the pass reach the identical verdict from the identical numbers.
 */
export function earnedAutonomy(
  kind: GardenerDetectionKind,
  plan: { move: GardenerMove; retireAs?: RetireVerb },
  record: ProposalTrackRecord,
): EarnedAutonomy {
  const tier = autonomyTierOf(plan);
  const bar = EARNED_AUTONOMY_BARS[tier];
  const { settled, applied } = record[kind] ?? { settled: 0, applied: 0 };
  return { tier, bar, settled, applied, ...clearsBar(bar, { settled, accepted: applied }, PROPOSAL_WORDS) };
}

/**
 * The same verdict for a KIND rather than a proposal — what the settings control renders, where
 * there is no plan yet. Reads the kind's canonical move off {@link KINDS}, so the row an operator
 * sees is priced by the move that kind actually runs.
 */
export function earnedAutonomyOfKind(
  kind: GardenerDetectionKind,
  record: ProposalTrackRecord,
): EarnedAutonomy {
  return earnedAutonomy(kind, KINDS[kind], record);
}

// ── the same floor, over the picker's record (anton-vkp9) ──

/**
 * What the picker's start COSTS, and therefore which bar it clears.
 *
 * DERIVED from the table above rather than restated: at `apply` the picker writes `approved`, claims
 * the target and enqueues the run — the `approve` move, which {@link autonomyTierOf} already prices
 * at `history` because what follows the label is a run that spends tokens and opens a PR, and
 * withdrawing the approval afterwards does not un-run it. Reading it off the move is what keeps the
 * picker on ONE trust ladder with the gardener's kinds: a re-priced `approve` re-prices this too.
 */
export const PICKER_AUTONOMY_TIER: AutonomyTier = autonomyTierOf({ move: "approve" });

/**
 * The picker's record as the floor reads it: how many of its picks the operator ANSWERED, and how
 * many of those they released.
 *
 * Structural, not imported, for the reason nothing else here reads a store either — the counts are
 * derived from the verdict table by the caller (`picker-veto.ts` `pickerTrackRecord`) exactly as the
 * gardener's are derived from the board, and this module stays pure enough for the floor to be a
 * proven property.
 */
export interface PickerRecordCounts {
  /** Picks answered either way — a release or a veto. Below the bar there is no record, not a bad one. */
  settled: number;
  /** How many of those were RELEASED. A veto is the other half, and it is evidence too. */
  accepted: number;
}

/** Whether the picker's record clears its bar, and — when it does not — what to tell the operator. */
export interface EarnedPickerAutonomy {
  tier: AutonomyTier;
  bar: EarnedAutonomyBar;
  settled: number;
  accepted: number;
  /** May this project's picker be armed at `apply` at all? */
  eligible: boolean;
  /** Why `apply` is unavailable, with the counts — never a bare "locked". Absent exactly when eligible. */
  reason?: string;
}

/**
 * Has this project's picker earned the right to start work unattended?
 *
 * The gardener's floor, asked of the picker's own accept/decline record (anton-vkp9). Shadow mode is
 * the same trap on this side of the house: a plan that ranks a target says the picker could start
 * it, never that starting it was RIGHT — and the only thing that answers the second question is what
 * the operator did when they were offered the pick.
 *
 * Pure over the counts, like {@link earnedAutonomy}, so the settings surface and the pass reach the
 * identical verdict from the identical numbers. The window the counts arrive over is the caller's
 * (`PICKER_RECORD_WINDOW`), and it ROLLS — which is what makes this floor bite AFTER arming too: a
 * project whose recent answers stop supporting `apply` stops clearing this bar on the very next pass.
 */
export function earnedPickerAutonomy(record: PickerRecordCounts): EarnedPickerAutonomy {
  const bar = EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER];
  const { settled, accepted } = record;
  return {
    tier: PICKER_AUTONOMY_TIER,
    bar,
    settled,
    accepted,
    ...clearsBar(bar, { settled, accepted }, PICKER_WORDS),
  };
}

/**
 * How far this proposal may go: the policy's answer for its kind, floored by what the move can
 * actually DO and by what the kind's own proposals have EARNED.
 *
 * Both floors come first and neither is negotiable. A `split` decomposes a ticket into new contracts
 * — `/shape`'s work and a human's call — and a container orphan filed without a target is a question
 * ("which feature?") rather than an instruction; both settle by being DECLINED (see
 * {@link isManualProposal}). Arming them could only mean arming nothing, so an `apply` policy resolves
 * them to `propose` instead of leaving each caller to remember the exception.
 *
 * The record floors `apply` alone (see {@link earnedAutonomy}). `shadow` is how a kind's judgment
 * becomes visible in the first place and writes nothing, so gating it would lock the door and pocket
 * the key. And an unearned `apply` demotes all the way to `propose` rather than to `shadow`: the
 * operator asked for a write, not for commentary, and quietly substituting one for the other would
 * put shadow records in a log nobody asked for while the setting still read `apply`.
 *
 * The kind, the move and the record arrive separately because they answer different halves: the
 * policy is a decision about the KIND, the manual floor a fact about the MOVE, the earned floor a
 * count of what the FOUNDER decided. Both shapes that consult this — a detection about to be filed, a
 * plan read back off a proposal bead — carry the move/target/retireAs triple, so neither has to be
 * converted into the other first.
 */
export function autonomyFor(
  kind: GardenerDetectionKind,
  plan: { move: GardenerMove; target?: string; retireAs?: RetireVerb },
  policy: ProposalAutonomyPolicy,
  record: ProposalTrackRecord,
): ProposalAutonomy {
  if (isManualProposal(plan)) return "propose";
  const level = policy[kind] ?? "propose";
  if (level === "apply" && !earnedAutonomy(kind, plan, record).eligible) return "propose";
  return level;
}
