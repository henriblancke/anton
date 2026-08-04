/**
 * The tier taxonomy — `epic → feature → task|bug|chore` — as a check rather than a paragraph
 * (anton-i4al).
 *
 * The rule is stated in `skills/bd/SKILL.md` and restated in `skills/shape/SKILL.md`, and shaping
 * still gets it wrong: the observed failure is a board of features with no tickets under them and
 * tickets hung straight off an epic. Prose can't catch that — `/shape`'s verification step prints
 * `bd children <epic-id>`, which shows titles, not tiers, so a malformed tree renders there as a
 * healthy one. This module is the missing half: the same taxonomy as violations a command prints and
 * a gate refuses on, exactly the way `contract.ts` does for the bead CONTRACT (what is INSIDE a
 * bead) while this does the bead GRAPH (where the bead HANGS).
 *
 * **Why `.mjs` and not `.ts`.** `anton board-check` has to run wherever anton is installed — inside
 * the user's own repo, from a release bundle that ships no TypeScript and no build step. The bundle
 * carries `bin/anton.mjs` plus a short list of `.mjs` siblings (`scripts/build-bundle.mjs`), so
 * plain JS here is what lets the launcher and the Next app share ONE definition of the rules instead
 * of the launcher re-deriving them. Same seam `config.mjs` already uses. `structure.ts` is the typed
 * face of this file; nothing re-implements it.
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
 * says the opposite — `beads.groupsChildren` reads a childless feature as *its own single ticket*, a
 * legitimate one-PR run. So a zero-ticket feature is advisory (in bulk it is the signature of leaves
 * mistyped as features), never blocking. Encoding it as an error would refuse runs the runtime
 * executes happily.
 *
 * Every rule is keyed on the CONTAINER-ness of an epic rather than on its type, for the same reason
 * `isRunTarget` is: a pre-tier board of epics with task children keeps running byte-identically, so
 * a ticket under such an epic is healthy and must not be faulted. Only once a `feature` lands under
 * an epic do that epic's loose tickets become unreachable.
 *
 * Pure — no bd calls, no IO — so the whole rule set is unit-tested off literal boards.
 */

/** Ticket-tier issue types — the working layer, executed inside a run target's run. */
const TICKET_TYPES = new Set(["task", "bug", "chore"]);

/** Pipeline plumbing, never work: judged by no tier rule. Mirrors contract.ts's PIPELINE_TYPES. */
const PIPELINE_TYPES = new Set(["molecule", "gate"]);

/** The label anton marks a won't-do bead with. Mirrors bd.ts's LABELS.abandoned. */
const ABANDONED_LABEL = "abandoned";

/**
 * How many tickets one feature carries before the split is worth a second look. A feature is one
 * worktree and one PR; past this the diff stops being reviewable in one sitting, which is the only
 * thing the number is measuring. Advisory — some features genuinely are seven small steps.
 */
export const FEATURE_TICKET_BUDGET = 6;

/**
 * The bead's parent id, from whichever field the bd read populated (`list` vs `show`). Mirrors
 * `beads.parentOf`; `tiers-parity.test.ts` fails if the two ever disagree.
 */
export const parentOf = (bead) => bead.parent ?? bead.parent_id;

const isEpic = (bead) => bead.issue_type === "epic";
const isTicketType = (bead) => TICKET_TYPES.has(bead.issue_type ?? "");
const isFeature = (bead) => bead.issue_type === "feature";

/** An epic that GROUPS run targets rather than being one: it has at least one `feature` child. */
export const isContainer = (bead, board) =>
  isEpic(bead) && board.some((c) => c.issue_type === "feature" && parentOf(c) === bead.id);

/** A bead is judged only while it is live work: closed is history, abandoned is a won't-do. */
function isJudged(bead) {
  return (
    bead.status !== "closed" &&
    !(bead.labels ?? []).includes(ABANDONED_LABEL) &&
    !PIPELINE_TYPES.has(bead.issue_type ?? "")
  );
}

/**
 * Every way this board departs from `epic → feature → ticket`, in board order. Each violation is
 * `{ id, rule, severity, message }`, the message naming the fault and the `bd` command that fixes it.
 *
 * Takes the WHOLE board, closed beads included — container-ness is read off the parent graph, and an
 * epic whose only feature child is closed is still a container, so its loose tickets are still dead.
 * Only the *offender* has to be live ({@link isJudged}); its context does not.
 */
export function validateBoardStructure(board) {
  const byId = new Map(board.map((b) => [b.id, b]));
  const openTicketChildren = new Map();
  for (const bead of board) {
    if (!isTicketType(bead) || !isJudged(bead)) continue;
    const parentId = parentOf(bead);
    if (parentId) openTicketChildren.set(parentId, (openTicketChildren.get(parentId) ?? 0) + 1);
  }

  const violations = [];
  const fault = (id, rule, severity, message) => violations.push({ id, rule, severity, message });

  for (const bead of board) {
    if (!isJudged(bead)) continue;
    const parentId = parentOf(bead);
    const parent = parentId ? byId.get(parentId) : undefined;

    if (isTicketType(bead)) {
      // A ticket under a CONTAINER epic is unreachable: it is not a run target (it has a parent),
      // and the epic's features each run their own children, never their parent's strays.
      if (parent && isContainer(parent, board)) {
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

    if (parent && !isEpic(parent)) {
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
export function structureGaps(targetId, board, severity) {
  const subtree = descendantsOf(targetId, board);
  return validateBoardStructure(board).filter((v) => v.severity === severity && subtree.has(v.id));
}

/** `targetId` and every bead reachable from it through `parent-child`, cycle-safe. */
function descendantsOf(targetId, board) {
  const childrenOf = new Map();
  for (const bead of board) {
    const parentId = parentOf(bead);
    if (!parentId) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(bead);
    else childrenOf.set(parentId, [bead]);
  }
  const seen = new Set([targetId]);
  const queue = [targetId];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.pop()) ?? []) {
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
export function formatStructureViolations(violations) {
  return violations.map((v) => `${v.id} → ${v.message}`).join("; ");
}

/** The board's tier conformance, for `anton board-check` and `/shape`'s Phase 5 audit. */
export function buildStructureReport(board) {
  const violations = validateBoardStructure(board);
  return {
    judged: board.filter(isJudged).length,
    blocking: violations.filter((v) => v.severity === "blocking").length,
    advisory: violations.filter((v) => v.severity === "advisory").length,
    violations,
  };
}

/** The report as text: a headline, then one line per violation, worst severity first. */
export function formatStructureReport(report, label = "") {
  const head = `${label ? `${label}: ` : ""}${report.judged} live beads — ${report.blocking} blocking, ${report.advisory} advisory`;
  if (report.violations.length === 0) return `${head}\n  ✓ epic → feature → ticket holds`;
  const lines = ["blocking", "advisory"].flatMap((severity) =>
    report.violations
      .filter((v) => v.severity === severity)
      .map((v) => `  ${severity === "blocking" ? "✗" : "!"} ${v.id} [${v.rule}] ${v.message}`),
  );
  return [head, ...lines].join("\n");
}
