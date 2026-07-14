/**
 * Epic detail page: the epic, its full description, its tickets, and the dependency graph
 * among {epic + tickets}. Edges come from `bd dep list` on each ticket, filtered to members
 * of the epic's own graph. See DESIGN.md §2/§3.
 */
import { beads, type Bead } from "./beads/bd";
import { deriveStage } from "./board";
import { getDb } from "./db";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { findOpenRunForEpic } from "./runs";
import { createdMeta, labelValue, listAllBeads, parseAcceptance, parseGoal } from "./tickets";
import type { DepEdge, DepType, Epic, EpicDetail, EpicRun, Project, Ticket } from "./types";

/** The open run backing this epic (if any), for the "View run" / worktree affordances. */
async function openRunFor(project: Project, epicId: string): Promise<EpicRun | undefined> {
  try {
    const row = await findOpenRunForEpic(getDb(), project.id, epicId);
    if (!row) return undefined;
    return { id: row.id, status: row.status, worktreePath: row.worktreePath ?? undefined };
  } catch {
    // Run lookup is best-effort: never fail the epic view over the runs table.
    return undefined;
  }
}

const DEP_TYPES = new Set<DepType>(["parent-child", "blocks", "related", "discovered-from"]);

function toTicket(bead: Bead): Ticket {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    stage: deriveStage(bead),
    agent: labelValue(bead.labels, "agent"),
    risk: labelValue(bead.labels, "risk"),
    size: labelValue(bead.labels, "size"),
    acceptance: parseAcceptance(bead),
    ...createdMeta(bead),
    prRef: bead.external_ref,
  };
}

export async function getEpicDetail(project: Project, epicId: string): Promise<EpicDetail> {
  const all = await listAllBeads(project); // one call: carries parent + inline dependencies
  const lite = all.find((b) => b.id === epicId);
  if (!lite) {
    throw new Error(`Epic not found: ${epicId}`);
  }
  // `bd list` omits the description, so fetch the bead once for its goal/acceptance.
  const full = await beads.show(project.repoPath, epicId).catch(() => lite);
  const run = await openRunFor(project, epicId);
  const base = await githubBaseUrl(project.repoPath);

  // The board renders orphan (parentless) non-epic beads as single-ticket pseudo-epic cards
  // (board.ts ticketAsEpic). Mirror that here so opening one shows its detail instead of 404ing —
  // it becomes an epic whose only member is itself, with no children and no epic-graph edges.
  if (!beads.isEpic(lite)) {
    const self = toTicket(lite);
    const epic: Epic = {
      id: lite.id,
      title: lite.title,
      goal: parseGoal(full.description),
      acceptance: parseAcceptance(full),
      approved: beads.isApproved(lite),
      stage: deriveStage(lite),
      agent: labelValue(lite.labels, "agent"),
      risk: labelValue(lite.labels, "risk"),
      size: labelValue(lite.labels, "size"),
      ...createdMeta(lite),
      prRef: lite.external_ref,
      tickets: [self],
    };
    attachPrUrl(epic, base);
    attachPrUrl(self, base);
    return { epic, description: full.description, tickets: [self], edges: [], run };
  }

  const childBeads = all.filter(
    (b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId,
  );
  const tickets = childBeads.map(toTicket);

  const epic: Epic = {
    id: lite.id,
    title: lite.title,
    goal: parseGoal(full.description),
    acceptance: parseAcceptance(full),
    approved: beads.isApproved(lite),
    stage: deriveStage(lite),
    ...createdMeta(lite),
    prRef: lite.external_ref,
    tickets,
  };
  attachPrUrl(epic, base);
  for (const t of tickets) attachPrUrl(t, base);

  const memberIds = new Set<string>([epic.id, ...tickets.map((t) => t.id)]);
  const seen = new Set<string>();
  const edges: DepEdge[] = [];
  for (const e of beads.edgesOf(all.filter((b) => memberIds.has(b.id)))) {
    if (!memberIds.has(e.from) || !memberIds.has(e.to)) continue;
    if (!DEP_TYPES.has(e.type as DepType)) continue;
    const key = `${e.from}->${e.to}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.from, to: e.to, type: e.type as DepType });
  }

  return { epic, description: full.description, tickets, edges, run };
}

/**
 * Permanently delete an epic and all of its child tickets (`bd delete --cascade`). Cascade is
 * required because the children depend on the epic via parent-child edges — a plain delete would
 * fail. Throws if the id doesn't resolve, so the API can answer 404.
 */
export async function deleteEpic(project: Project, epicId: string): Promise<void> {
  await beads.show(project.repoPath, epicId); // 404 guard — bd throws on an unknown id
  await beads.delete(project.repoPath, epicId, { cascade: true });
}
