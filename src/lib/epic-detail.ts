/**
 * Epic detail page: the epic, its full description, its tickets, and the dependency graph
 * among {epic + tickets}. Edges come from `bd dep list` on each ticket, filtered to members
 * of the epic's own graph. See DESIGN.md §2/§3.
 */
import { beads, type Bead } from "./beads/bd";
import { deriveStage } from "./board";
import { labelValue, listAllBeads, parseAcceptance, parseGoal } from "./tickets";
import type { DepEdge, DepType, Epic, EpicDetail, Project, Ticket } from "./types";

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
      prRef: lite.external_ref,
      tickets: [self],
    };
    return { epic, description: full.description, tickets: [self], edges: [] };
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
    prRef: lite.external_ref,
    tickets,
  };

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

  return { epic, description: full.description, tickets, edges };
}
