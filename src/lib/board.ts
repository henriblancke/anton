/**
 * Assembles the Board from beads. Stage/approval/PR are derived — never stored. See DESIGN.md §2/§3.
 */
import { beads, getSyncStatus, getSyncStatusToken, type Bead } from "./beads/bd";
import { allIssues } from "./beads/issues";
import { issueSnapshotVersion } from "./beads/snapshot";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { parseAcceptance, parseGoal, toEpic, toTicket } from "./ticket-view";
import { STAGES, type Board, type Epic, type Project, type Stage } from "./types";

// deriveStage lives in ticket-view.ts now; re-exported here for existing importers/tests.
export { deriveStage } from "./ticket-view";

export function getBoardVersion(repoPath: string): string {
  return `${issueSnapshotVersion(repoPath)}:${getSyncStatusToken(repoPath)}`;
}

/** A parentless non-epic bead, rendered on the board as a single-ticket pseudo-epic card. The
 * PR link rides on the wrapped ticket, so the epic wrapper itself carries no prRef. */
function ticketAsEpic(bead: Bead): Epic {
  return toEpic(bead, { tickets: [toTicket(bead)], prRef: false });
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

  for (const epic of epicBeads) {
    const children = childrenByEpic.get(epic.id) ?? [];
    const tickets = children.map(toTicket);
    const built = toEpic(epic, {
      goal: parseGoal(epic.description),
      acceptance: parseAcceptance(epic),
      tickets,
    });
    columns[built.stage].push(built);
  }

  const orphanTasks = taskBeads.filter((t) => !claimedTaskIds.has(t.id));
  for (const task of orphanTasks) {
    const wrapped = ticketAsEpic(task);
    columns[wrapped.stage].push(wrapped);
  }

  for (const stage of STAGES) {
    if (!columns[stage]) columns[stage] = [];
  }

  // Resolve PR links from the repo's origin remote (once) so `gh-<n>` refs become clickable.
  const base = await githubBaseUrl(project.repoPath);
  for (const stage of STAGES) {
    for (const epic of columns[stage]) {
      attachPrUrl(epic, base);
      for (const ticket of epic.tickets) attachPrUrl(ticket, base);
    }
  }

  return {
    projectSlug: project.slug,
    version: getBoardVersion(project.repoPath),
    columns,
    // Read from the globalThis-anchored registry, so the API bundle sees passes run by the
    // instrumentation-started sync engine (see bd.ts).
    sync: getSyncStatus(project.repoPath),
  };
}
