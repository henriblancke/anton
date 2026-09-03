/**
 * Repair autonomy (R5.3): how far anton may go fixing a block a run declared, per class.
 *
 * The proposal control's twin ({@link AUTONOMY_LEVELS} in settings-autonomy.ts) and deliberately a
 * SEPARATE one, for the reason the server keeps two policies: a repair never files a bead, so a
 * founder never accepts or declines one, so it can never build the settled-proposal record the
 * earned-autonomy floor weighs. There is no bar to clear here and none is faked — the only floor is
 * a class anton has no repair FOR.
 *
 * The levels also mean something slightly different on this side, which is why the hints are written
 * out rather than reused: at `propose` a repair is not filed anywhere, it is ESCALATED — the run
 * parks and asks a human.
 *
 * Mirrored from src/lib/gardener/repair-autonomy.ts rather than imported: this module tree is
 * client-side, and importing the pass's code to get four strings would drag the board reader,
 * `bd` and node's `crypto` into the bundle. Keep in sync with REPAIR_CLASSES and
 * DEFAULT_REPAIR_AUTONOMY_POLICY.
 */
import { AUTONOMY_LEVELS, type ProposalAutonomy } from "@/components/settings/settings-autonomy";

export type RepairAutonomy = ProposalAutonomy;

/** What each level means for a REPAIR — not for a proposal. See the module header. */
export const REPAIR_LEVEL_HINT: Record<RepairAutonomy, string> = {
  propose: "escalates · the run parks and a human is asked",
  shadow: "works the fix out and notes what it WOULD have written · the board is untouched",
  apply: "writes the fix to the bead unattended and the run carries on",
};

/** One block class as the founder meets it: what a repair for it writes, and whether it exists yet. */
export interface RepairClassSpec {
  /** A RepairClass (src/lib/gardener/repair.ts). */
  id: string;
  /** The block, in the founder's terms — what the agent stopped on. */
  block: string;
  /** What the repair WRITES when it is armed. */
  does: string;
  /** Why this class can never be armed. Set only where anton has no repair for it at all. */
  blocked?: string;
}

/**
 * The block classes, cheapest mistake first.
 *
 * The FACTUAL pair invent nothing — one rewrites a pointer to what it already meant, the other
 * records an ordering that already exists — which is why they are armable at all. The INVENTIVE
 * pair have no repair behind them: arming them would be a setting the run silently ignores, so they
 * are pinned and say so rather than being left off the page.
 */
export const REPAIR_CLASSES: RepairClassSpec[] = [
  {
    id: "ref-stale",
    block: "the bead cites a file that has since moved",
    does: "rewrites the `## Context` pointer to where git records the file going",
  },
  {
    id: "dep-missing",
    block: "the agent needs work that has to land first, and no edge said so",
    does: "draws the `blocks` edge and parks the bead behind the prerequisite",
  },
  {
    id: "acceptance-missing",
    block: "the bead states no definition of done the agent could work to",
    does: "nothing — criteria are authored, never derived",
    blocked: "writing acceptance criteria is /shape's work, and your call",
  },
  {
    id: "oversized",
    block: "the bead is more work than one run can carry",
    does: "nothing — a split writes new contracts",
    blocked: "a split writes new contracts — /shape's work, and your call",
  },
];

/**
 * The shipped level per class, mirrored from DEFAULT_REPAIR_AUTONOMY_POLICY. The factual pair ship
 * at `shadow`: they are safe to COMPUTE, which is not the same as armed to write, and a week of
 * shadow notes is what makes arming them an informed act.
 */
const SHIPPED: Record<string, RepairAutonomy> = {
  "ref-stale": "shadow",
  "dep-missing": "shadow",
  "acceptance-missing": "propose",
  oversized: "propose",
};

/** The shipped level for a class this build renders — `propose` for anything it does not know. */
export function shippedRepairLevel(classId: string): RepairAutonomy {
  return SHIPPED[classId] ?? "propose";
}

/**
 * The stored overrides as a full per-class policy — the same "never partial" shape
 * `resolveRepairAutonomyPolicy` produces on the server, so the form and the run agree on what an
 * absent entry means.
 *
 * The one floor is re-applied here, because the lie this control cannot tell is showing a level the
 * run would ignore: an unreadable entry falls back to the class's SHIPPED level (not to `propose` —
 * that would draw the factual pair as disarmed when they are not), and a class with no repair behind
 * it ({@link RepairClassSpec.blocked}) reads back pinned.
 */
export function resolveRepairAutonomy(
  stored: Record<string, string> | undefined,
): Record<string, RepairAutonomy> {
  return Object.fromEntries(
    REPAIR_CLASSES.map((klass) => {
      const value = stored?.[klass.id];
      const armable =
        !klass.blocked && (AUTONOMY_LEVELS as readonly string[]).includes(value ?? "");
      return [klass.id, armable ? (value as RepairAutonomy) : shippedRepairLevel(klass.id)];
    }),
  );
}
