/**
 * The tier taxonomy, as a check rather than a paragraph (anton-tier-invariants).
 *
 * `epic → feature → task|bug|chore` is stated in `skills/bd/SKILL.md` and restated in
 * `skills/shape/SKILL.md`, and shaping still gets it wrong — the observed failure is a board of
 * features with no tickets under them and tickets hung straight off an epic. Prose can't catch that:
 * `/shape`'s own verification step prints `bd children <epic-id>`, which shows titles, not tiers, so
 * a malformed tree renders as a healthy one. This module is the missing half — the same taxonomy
 * expressed as violations a command can print and a gate can refuse on, exactly the way
 * `contract.ts` does for the bead CONTRACT (the sections inside a bead) while this does the bead
 * GRAPH (how beads hang off each other).
 *
 * Severity follows one question, and only one: **can this bead ever run?**
 *
 * - `blocking` — no. It is a dead bead: `beads.isRunTarget` refuses it and no run target's ticket
 *   sweep reaches it, so it sits on the board forever looking like queued work. Nothing but an
 *   author moving it can change that, which is why the approve route refuses rather than warns.
 * - `advisory` — yes, but the shape is wrong in a way that costs later: a feature nobody's roadmap
 *   shows, or one PR carrying nine tickets' worth of diff. Reported, never enforced; gating the
 *   board on shape judgement would strand honest work over taste.
 *
 * The rule that is deliberately NOT here: "a feature with no tickets is invalid". anton's runtime
 * says the opposite — `beads.groupsChildren` reads a childless feature as *its own single ticket*,
 * a legitimate one-PR run. So a zero-ticket feature is advisory (in bulk it is the signature of
 * leaves mistyped as features), never blocking. Encoding it as an error would refuse runs the
 * runtime executes happily.
 *
 * Every rule is keyed on the CONTAINER-ness of an epic rather than on its type, for the same reason
 * `isRunTarget` is: a pre-tier board of epics with task children keeps running byte-identically, so
 * a ticket under such an epic is healthy and must not be faulted. Only once a `feature` lands under
 * an epic do that epic's loose tickets become unreachable.
 *
 * Pure — no bd calls, no IO — so the whole rule set is unit-tested off literal boards, and the CLI
 * shell (`scripts/board-structure.ts`), the approve gate, and `/shape` all judge through this one
 * function instead of three approximations of it.
 */
import { beads, type Bead } from "./bd";
import { isPipelineArtifact } from "./contract";

/** Ticket-tier issue types — the working layer, executed inside a run target's run. */
const TICKET_TYPES = new Set(["task", "bug", "chore"]);

/**
 * How many tickets one feature carries before the split is worth a second look. A feature is one
 * worktree and one PR; past this the diff stops being reviewable in one sitting, which is the only
 * thing the number is measuring. Advisory — some features genuinely are seven small steps.
 */
export const FEATURE_TICKET_BUDGET = 6;

export type StructureSeverity = "blocking" | "advisory";

/** Which tier rule a bead breaks. Stable strings — the CLI groups by them and tests assert on them. */
export type StructureRule =
  | "ticket-under-container-epic"
  | "feature-under-non-epic"
  | "parentless-chore"
  | "feature-without-epic"
  | "feature-without-tickets"
  | "feature-over-ticket-budget";

export interface StructureViolation {
  /** The offending bead — the one an author has to move or re-type. */
  id: string;
  rule: StructureRule;
  severity: StructureSeverity;
  /** What is wrong, why it can't run (or why it will cost), and the `bd` command that fixes it. */
  message: string;
}

/** A bead is judged only while it is live work: closed is history, abandoned is a won't-do. */
function isJudged(bead: Bead): boolean {
  return bead.status !== "closed" && !beads.isAbandoned(bead) && !isPipelineArtifact(bead);
}

const isTicketType = (bead: Bead): boolean => TICKET_TYPES.has(bead.issue_type ?? "");
const isFeature = (bead: Bead): boolean => bead.issue_type === "feature";

/**
 * Every way this board departs from `epic → feature → ticket`, in board order.
 *
 * Takes the WHOLE board, closed beads included — container-ness is read off the parent graph, and an
 * epic whose only feature child is closed is still a container, so its loose tickets are still dead.
 * Only the *offender* has to be live ({@link isJudged}); its context does not.
 */
export function validateBoardStructure(board: Bead[]): StructureViolation[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  const openTicketChildren = new Map<string, number>();
  for (const bead of board) {
    if (!isTicketType(bead) || !isJudged(bead)) continue;
    const parentId = beads.parentOf(bead);
    if (parentId) openTicketChildren.set(parentId, (openTicketChildren.get(parentId) ?? 0) + 1);
  }

  const violations: StructureViolation[] = [];
  const fault = (id: string, rule: StructureRule, severity: StructureSeverity, message: string) =>
    violations.push({ id, rule, severity, message });

  for (const bead of board) {
    if (!isJudged(bead)) continue;
    const parentId = beads.parentOf(bead);
    const parent = parentId ? byId.get(parentId) : undefined;

    if (isTicketType(bead)) {
      // A ticket under a CONTAINER epic is unreachable: it is not a run target (it has a parent),
      // and the epic's features each run their own children, never their parent's strays.
      if (parent && beads.isEpic(parent) && beads.isContainer(parent, board)) {
        fault(
          bead.id,
          "ticket-under-container-epic",
          "blocking",
          `parented to container epic ${parent.id} — a dead bead: it is not a run target and no ` +
            `feature's run covers it. Move it under the feature that delivers it ` +
            `(\`bd update ${bead.id} --parent <feature-id>\`), or make it its own feature.`,
        );
      }
      // `isRunTarget` admits a parentless task/bug as a run of one; a chore never qualifies, so a
      // parentless one has no run that will ever reach it.
      if (!parentId && bead.issue_type === "chore") {
        fault(
          bead.id,
          "parentless-chore",
          "blocking",
          "a parentless `chore` is a dead bead — only `task`/`bug` run standalone. Give it a " +
            `feature parent (\`bd update ${bead.id} --parent <feature-id>\`) or re-type it ` +
            `(\`bd update ${bead.id} --type task\`).`,
        );
      }
      continue;
    }

    if (!isFeature(bead)) continue;

    if (parent && !beads.isEpic(parent)) {
      // Both are run targets, so both get claimed, worktree'd and shipped — the same work twice.
      fault(
        bead.id,
        "feature-under-non-epic",
        "blocking",
        `parented to ${parent.id} (${parent.issue_type ?? "unknown"}), not an epic — a feature ` +
          `hangs off an epic and nothing else. Both are run targets, so this ships the same work ` +
          `twice. Re-parent it (\`bd update ${bead.id} --parent <epic-id>\`) or make it a ticket.`,
      );
    } else if (!parentId) {
      fault(
        bead.id,
        "feature-without-epic",
        "advisory",
        "no epic parent — it runs, but no roadmap shows it. Attach it to the outcome it advances " +
          `(\`bd update ${bead.id} --parent <epic-id>\`), or ask which epic owns it.`,
      );
    }

    const tickets = openTicketChildren.get(bead.id) ?? 0;
    if (tickets === 0) {
      fault(
        bead.id,
        "feature-without-tickets",
        "advisory",
        "no tickets — it runs as a single-ticket run, which is right for a genuinely atomic PR " +
          "and wrong in bulk (leaves mistyped as features). Shape its steps under it, or make it " +
          "a `task` under the feature that delivers it.",
      );
    } else if (tickets > FEATURE_TICKET_BUDGET) {
      fault(
        bead.id,
        "feature-over-ticket-budget",
        "advisory",
        `${tickets} tickets (budget ${FEATURE_TICKET_BUDGET}) — one feature is one reviewable PR, ` +
          "and this is likely two. Split it into features under the same epic.",
      );
    }
  }

  return violations;
}

/**
 * The violations a single run target owns: its own, plus every descendant's.
 *
 * The approve route's unit of refusal. Board-wide judgement would strand an honest feature over a
 * stray chore three branches away, which is the failure mode of every lint that gates on the repo
 * instead of the change.
 */
export function structureGaps(
  targetId: string,
  board: Bead[],
  severity: StructureSeverity,
): StructureViolation[] {
  const subtree = descendantsOf(targetId, board);
  return validateBoardStructure(board).filter(
    (v) => v.severity === severity && subtree.has(v.id),
  );
}

/** `targetId` and every bead reachable from it through `parent-child`, cycle-safe. */
function descendantsOf(targetId: string, board: Bead[]): Set<string> {
  const childrenOf = new Map<string, Bead[]>();
  for (const bead of board) {
    const parentId = beads.parentOf(bead);
    if (!parentId) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(bead);
    else childrenOf.set(parentId, [bead]);
  }
  const seen = new Set([targetId]);
  const queue = [targetId];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.pop() as string) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
    }
  }
  return seen;
}

/**
 * Violations as one line naming every offender and what is wrong — the body of a 422 or of a park
 * note. Each message already carries the remedy, so the operator reads the fault and the fix
 * together.
 */
export function formatStructureViolations(violations: StructureViolation[]): string {
  return violations.map((v) => `${v.id} → ${v.message}`).join("; ");
}

export interface StructureReport {
  /** Live beads the tier rules apply to — the honest denominator for a conformance rate. */
  judged: number;
  blocking: number;
  advisory: number;
  violations: StructureViolation[];
}

/** The board's tier conformance, for `scripts/board-structure.ts` and `/shape`'s Phase 5 audit. */
export function buildStructureReport(board: Bead[]): StructureReport {
  const violations = validateBoardStructure(board);
  return {
    judged: board.filter(isJudged).length,
    blocking: violations.filter((v) => v.severity === "blocking").length,
    advisory: violations.filter((v) => v.severity === "advisory").length,
    violations,
  };
}

/** The report as text: a headline, then one line per violation, worst severity first. */
export function formatStructureReport(report: StructureReport, label = ""): string {
  const head = `${label ? `${label}: ` : ""}${report.judged} live beads — ${report.blocking} blocking, ${report.advisory} advisory`;
  if (report.violations.length === 0) return `${head}\n  ✓ epic → feature → ticket holds`;
  const order: StructureSeverity[] = ["blocking", "advisory"];
  const lines = order.flatMap((severity) =>
    report.violations
      .filter((v) => v.severity === severity)
      .map((v) => `  ${severity === "blocking" ? "✗" : "!"} ${v.id} [${v.rule}] ${v.message}`),
  );
  return [head, ...lines].join("\n");
}
