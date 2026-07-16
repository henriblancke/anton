/**
 * Assembles the Board from beads. Stage/approval/PR are derived — never stored. See DESIGN.md §2/§3.
 */
import { compareBacklogEpics } from "@/components/board/board-utils";
import { beads, getSyncStatus, getSyncStatusToken, type Bead } from "./beads/bd";
import { allIssues } from "./beads/issues";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "./epic-graph";
import { issueSnapshotVersion } from "./beads/snapshot";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { parseAcceptance, parseGoal, toEpic, toStandaloneItem, toTicket } from "./ticket-view";
import {
  STAGES,
  type Board,
  type Epic,
  type Project,
  type Stage,
  type StandaloneItem,
} from "./types";

// deriveStage lives in ticket-view.ts now; re-exported here for existing importers/tests.
export { deriveStage } from "./ticket-view";

export function getBoardVersion(repoPath: string): string {
  return `${issueSnapshotVersion(repoPath)}:${getSyncStatusToken(repoPath)}`;
}

/** Standalone chips read newest-first within a stage, but a self-filed unread bug jumps ahead of
 * its read siblings so triage-worthy work surfaces above the "+N more" cap. */
function compareStandalone(a: StandaloneItem, b: StandaloneItem): number {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export async function getBoard(project: Project): Promise<Board> {
  let allBeads = await allIssues(project.repoPath);

  // Only work items land on the board. `molecule` (swarm coordination) and similar artifacts
  // are excluded; features/tasks/bugs are tickets.
  const NON_WORK = new Set(["molecule"]);
  allBeads = allBeads.filter((b) => !NON_WORK.has(b.issue_type ?? ""));

  const epicBeads = allBeads.filter((b) => beads.isEpic(b));
  const taskBeads = allBeads.filter((b) => !beads.isEpic(b));

  // Group tickets under epics from the inline `parent` field — no per-epic bd calls.
  const childrenByEpic = new Map<string, Bead[]>();
  for (const epic of epicBeads) childrenByEpic.set(epic.id, []);
  for (const task of taskBeads) {
    const parent = (task.parent ?? task.parent_id) as string | undefined;
    if (parent && childrenByEpic.has(parent)) childrenByEpic.get(parent)!.push(task);
  }

  const claimedTaskIds = new Set<string>();
  for (const children of childrenByEpic.values()) {
    for (const child of children) claimedTaskIds.add(child.id);
  }

  const columns: Record<Stage, Epic[]> = {
    backlog: [],
    implementing: [],
    "in-review": [],
    done: [],
  };
  const standalone: Record<Stage, StandaloneItem[]> = {
    backlog: [],
    implementing: [],
    "in-review": [],
    done: [],
  };

  // Derive epic→epic dependency rollup once (blockedBy/ready/rank), so the board reflects the
  // readiness the runtime's bd-ready enforces. Degrades to a stable order on a cycle (epic-graph.ts).
  const graphNodes = new Map(computeEpicGraph(allBeads).epics.map((n) => [n.id, n]));

  for (const epic of epicBeads) {
    const children = childrenByEpic.get(epic.id) ?? [];
    const tickets = children.map(toTicket);
    const node = graphNodes.get(epic.id);
    // The epic-graph rollup DROPS any blocks edge whose blocker is a parentless standalone task/bug
    // (epicOf can't attribute it to an epic). Fold those back in — the same set the approve route
    // gates on — so the board's blockedBy/ready match what approval will actually enforce and the
    // card doesn't show a not-ready epic as approvable.
    const blockedBy = [...(node?.blockedBy ?? []), ...epicStandaloneBlockers(allBeads, epic.id)];
    const built = toEpic(epic, {
      goal: parseGoal(epic.description),
      acceptance: parseAcceptance(epic),
      tickets,
      blockedBy,
      ready: blockedBy.length === 0,
      rank: node?.rank ?? 0,
    });
    columns[built.stage].push(built);
  }

  // Parentless tasks/bugs are standalone run targets (epic-of-one), not fake epics: they land as
  // typed chips at the foot of their stage column, carrying their real issue_type. Only RUNNABLE
  // parentless beads become chips (beads.isRunTarget — task/bug only): a parentless `learning`/
  // `chore`/etc. is not a run target, so a chip for it would advertise `Approve & run` yet the
  // approve route + runner reject it via the same isRunTarget gate — a permanent 422/park. Gate
  // here so the board never surfaces an item it can't actually run.
  const orphanTasks = taskBeads.filter((t) => !claimedTaskIds.has(t.id) && beads.isRunTarget(t));
  for (const task of orphanTasks) {
    // A standalone target never appears in the epic-graph rollup, so derive its blockers from its
    // own `blocks` edges — the same set the approve route + runner gate on. Feeds the chip's
    // ready/blockedBy so it can hide Approve & run and show a blocked chip while a prerequisite is open.
    const item = toStandaloneItem(task, standaloneBlockers(allBeads, task.id));
    standalone[item.stage].push(item);
  }

  for (const stage of STAGES) {
    if (!columns[stage]) columns[stage] = [];
    if (!standalone[stage]) standalone[stage] = [];
  }

  // Only the backlog is dependency-aware ordered (ready-first → rank → priority → createdAt); the
  // other columns are stage-based, so deps can't reorder across them — they keep insertion order.
  columns.backlog.sort(compareBacklogEpics);
  // Chips read the same way in every column (unread-first, then newest), independent of epic order.
  for (const stage of STAGES) standalone[stage].sort(compareStandalone);

  // Resolve PR links from the repo's origin remote (once) so `gh-<n>` refs become clickable.
  const base = await githubBaseUrl(project.repoPath);
  for (const stage of STAGES) {
    for (const epic of columns[stage]) {
      attachPrUrl(epic, base);
      for (const ticket of epic.tickets) attachPrUrl(ticket, base);
    }
    for (const item of standalone[stage]) attachPrUrl(item, base);
  }

  return {
    projectSlug: project.slug,
    version: getBoardVersion(project.repoPath),
    columns,
    standalone,
    // Read from the globalThis-anchored registry, so the API bundle sees passes run by the
    // instrumentation-started sync engine (see bd.ts).
    sync: getSyncStatus(project.repoPath),
  };
}
