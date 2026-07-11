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

async function getChildren(project: Project, epicId: string): Promise<Bead[]> {
  try {
    const children = await beads.children(project.repoPath, epicId);
    if (children.length > 0) return children;
  } catch {
    // fall through to the parent_id scan below
  }
  const all = await listAllBeads(project);
  return all.filter((b) => b.parent_id === epicId);
}

export async function getEpicDetail(project: Project, epicId: string): Promise<EpicDetail> {
  const epicBead = await beads.show(project.repoPath, epicId);
  if (!epicBead || !beads.isEpic(epicBead)) {
    throw new Error(`Epic not found: ${epicId}`);
  }

  const childBeads = await getChildren(project, epicId);
  const tickets = childBeads.map(toTicket);

  const epic: Epic = {
    id: epicBead.id,
    title: epicBead.title,
    goal: parseGoal(epicBead.description),
    acceptance: parseAcceptance(epicBead),
    approved: beads.isApproved(epicBead),
    stage: deriveStage(epicBead),
    prRef: epicBead.external_ref,
    tickets,
  };

  const memberIds = new Set<string>([epic.id, ...tickets.map((t) => t.id)]);

  const depLists = await Promise.all(
    tickets.map((ticket) =>
      beads.depList(project.repoPath, ticket.id).catch(() => [] as Bead[]),
    ),
  );

  const seen = new Set<string>();
  const edges: DepEdge[] = [];
  tickets.forEach((ticket, i) => {
    for (const related of depLists[i]) {
      if (!memberIds.has(related.id)) continue;
      const type = related.dependency_type;
      if (!type || !DEP_TYPES.has(type as DepType)) continue;
      const key = `${ticket.id}->${related.id}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: ticket.id, to: related.id, type: type as DepType });
    }
  });

  return {
    epic,
    description: epicBead.description,
    tickets,
    edges,
  };
}
