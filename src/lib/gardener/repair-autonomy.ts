/**
 * How far a REPAIR may go, per block class (R5.3) — the same trust dial every other autonomous
 * board write already sits behind, over the repair classes instead of the detection kinds.
 *
 * The levels are the proposal policy's, imported rather than restated (`propose`, `shadow`,
 * `apply`), because they mean the identical thing here and an operator should meet one vocabulary:
 * `propose` files nothing and escalates, `shadow` works the repair out and records what it WOULD
 * have written, `apply` writes it. What a mistake costs is a property of the class — a rewritten
 * pointer and a `blocks` edge are not the same risk as inventing an acceptance criterion — so the
 * decision is per class, like {@link DEFAULT_PROPOSAL_AUTONOMY_POLICY}'s is per kind.
 *
 * A SEPARATE policy from the gardener's, and the separation is deliberate. A repair is not a
 * proposal: it never files a bead, so a founder never accepts or declines one, so it can never build
 * the settled-proposal record the earned-autonomy floor (autonomy.ts `earnedAutonomy`) weighs. Route
 * the classes through `autonomyFor` and every one of them would resolve to `propose` forever — a
 * dial that can never be turned on, and a settings row promising an `apply` that unlocks at ten
 * settled proposals the class cannot file. The classes carry the same levels, and the floor that
 * cannot apply to them is left off rather than faked.
 *
 * Pure values, like autonomy.ts: nothing here reads a board, a settings store, or a bead. The
 * project's stored overrides arrive as `unknown` from settings and the pass consults the resolved
 * result — see `resolveRepairAutonomy` (lib/projects.ts) and {@link decideRepair}.
 */
import { PROPOSAL_AUTONOMY_LEVELS, type ProposalAutonomy } from "./autonomy";
import { REPAIR_CLASSES, type RepairClass } from "./repair";

/**
 * The resolved policy: every class decided, never partial — a total `Record` for the reason
 * {@link ProposalAutonomyPolicy} is one, so adding a repair class without deciding what it defaults
 * to is a type error here rather than a class that silently inherits someone's fallback branch.
 */
export type RepairAutonomyPolicy = Record<RepairClass, ProposalAutonomy>;

/** What a project STORES: only the classes an operator moved off the default. */
export type RepairAutonomyOverrides = Partial<RepairAutonomyPolicy>;

/**
 * The shipped policy.
 *
 * The two FACTUAL repairs (R5.4) ship at `shadow`: they invent nothing — one rewrites a pointer to
 * what it already meant, the other records an ordering that already exists — but "safe to compute"
 * is not "armed to write", and a project that upgrades into this feature must not wake up to anton
 * having rewritten its beads. Shadow is what makes arming them an informed act rather than a leap:
 * a week of records says what `apply` would have done, on this board, in the repair's own words.
 * Those records are a note on the ticket and a line in the run's log: the dial gates the FIX, never
 * anton's account of it — a repair files no bead, so there is nowhere else that account could live.
 *
 * The INVENTIVE pair (R5.5) ships at `propose` — anton has no repair for them yet, and a class with
 * no implementation must not read as merely unarmed.
 */
export const DEFAULT_REPAIR_AUTONOMY_POLICY: RepairAutonomyPolicy = {
  "ref-stale": "shadow",
  "dep-missing": "shadow",
  "acceptance-missing": "propose",
  oversized: "propose",
};

/**
 * The classes anton actually HAS a repair for — the factual pair, and the only two
 * `repairBlockedTicket` (jobs/execute-epic-ticket.ts) dispatches. The inventive pair have no
 * implementation behind them, so no level above `propose` could ever be honoured for them.
 *
 * Named here rather than inferred from {@link DEFAULT_REPAIR_AUTONOMY_POLICY}: that the two sets
 * coincide today is a property of the shipped defaults, not the fact being asserted. Mirrored
 * client-side as `RepairClassSpec.blocked` (components/settings/settings-repair.ts) — keep in sync.
 */
export const ARMABLE_REPAIR_CLASSES = [
  "ref-stale",
  "dep-missing",
] as const satisfies readonly RepairClass[];

/**
 * May this class be armed above `propose` at all? Asked at the SETTINGS boundary (projects.ts
 * `repairAutonomySchema`), where an operator is present to see the rejection: storing
 * `acceptance-missing: "apply"` would otherwise succeed, be ignored by every run, and read back as
 * `propose` — a policy the board can never honour (PR #223 review).
 */
export function isArmableRepairClass(klass: RepairClass): boolean {
  return (ARMABLE_REPAIR_CLASSES as readonly string[]).includes(klass);
}

function isAutonomy(value: unknown): value is ProposalAutonomy {
  return typeof value === "string" && (PROPOSAL_AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function isRepairClassKey(value: string): value is RepairClass {
  return (REPAIR_CLASSES as readonly string[]).includes(value);
}

/**
 * The shipped policy with a project's stored overrides applied — never partial.
 *
 * Takes `unknown` and DROPS what it doesn't recognise rather than throwing, exactly as
 * `resolveProposalAutonomyPolicy` does: this reads a settings blob a human can hand-edit, and a run
 * settling a blocked ticket is the wrong place to discover a typo. An entry anton can't read falls
 * back to the SHIPPED default for that class, which is the safe direction — the loud rejection
 * belongs at the settings boundary, where an operator is there to see it.
 */
export function resolveRepairAutonomyPolicy(overrides?: unknown): RepairAutonomyPolicy {
  const policy = { ...DEFAULT_REPAIR_AUTONOMY_POLICY };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return policy;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (isRepairClassKey(key) && isAutonomy(value)) policy[key] = value;
  }
  return policy;
}
