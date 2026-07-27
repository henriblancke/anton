/**
 * The Tickets page: a flat, filterable view over every work bead — epics included (each epic row is
 * followed by its subtree, features and their tickets), excluding only `molecule` coordination
 * artifacts.
 * Mirrors board.ts's read + section-parsing patterns — see DESIGN.md §2/§3.
 */
import { beads, type Bead } from "./beads/bd";
import { allIssues } from "./beads/issues";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { createdMeta, deriveStage, labelValue, parseAcceptance } from "./ticket-view";
import type { Project, TicketFilters, TicketRow } from "./types";

const NON_WORK = new Set(["molecule"]);

// Re-exported for callers/tests that read the ticket contract off a bead; the implementations
// live in ticket-view.ts (the single source of truth).
export { parseAcceptance, parseGoal } from "./ticket-view";

export async function listAllBeads(project: Project): Promise<Bead[]> {
  return allIssues(project.repoPath);
}

function toTicketRow(bead: Bead, epic: Bead | undefined): TicketRow {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    stage: deriveStage(bead),
    agent: labelValue(bead.labels, "agent"),
    risk: labelValue(bead.labels, "risk"),
    size: labelValue(bead.labels, "size"),
    domain: labelValue(bead.labels, "domain"),
    acceptance: parseAcceptance(bead),
    ...createdMeta(bead),
    prRef: beads.getPrRef(bead),
    deferred: beads.isDeferred(bead),
    abandoned: beads.isAbandoned(bead),
    type: bead.issue_type ?? "task",
    epicId: epic?.id,
    epicTitle: epic?.title,
  };
}

export function applyFilters(rows: TicketRow[], filters: TicketFilters): TicketRow[] {
  const q = filters.q?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.agent && row.agent !== filters.agent) return false;
    if (filters.risk && row.risk !== filters.risk) return false;
    if (filters.size && row.size !== filters.size) return false;
    if (filters.domain && row.domain !== filters.domain) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.type && row.type !== filters.type) return false;
    if (filters.epic && row.epicId !== filters.epic) return false;
    // Abandoned work stays in the list by default — the outcome is part of the record — but it is
    // one select away from being hidden, or isolated for a review of what was dropped.
    if (filters.outcome === "active" && row.abandoned) return false;
    if (filters.outcome === "abandoned" && !row.abandoned) return false;
    if (q && !row.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * The Tickets page's rows, in reading order: each epic, followed by its whole subtree depth-first
 * (a feature, then the tickets shaped under it), with beads that have no epic ancestor trailing
 * after. Every row carries its NEAREST epic ancestor, not its immediate parent — under the
 * three-tier shape (epic → feature → task) a ticket's parent is its feature, so a single hop would
 * emit it as an orphan: no Epic value and invisible to the Epic filter. Pure over a bead list, so
 * it costs no bd call and is testable from a fixture board.
 */
export function buildTicketRows(allBeads: Bead[]): TicketRow[] {
  const epicBeads = allBeads.filter((b) => beads.isEpic(b));
  const workBeads = allBeads.filter((b) => !beads.isEpic(b));

  // Children keyed by parent, over the work beads only — so a descent from an epic stops at a
  // nested epic, which gets its own row and its own subtree.
  const childrenByParent = new Map<string, Bead[]>();
  for (const t of workBeads) {
    const parent = beads.parentOf(t);
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(t);
    else childrenByParent.set(parent, [t]);
  }

  const rows: TicketRow[] = [];
  const grouped = new Set<string>();
  for (const epic of epicBeads) {
    rows.push(toTicketRow(epic, undefined));
    // Depth-first from the epic; `grouped` doubles as the cycle guard on a malformed parent chain.
    const stack = [...(childrenByParent.get(epic.id) ?? [])].reverse();
    while (stack.length > 0) {
      const bead = stack.pop()!;
      if (grouped.has(bead.id)) continue;
      grouped.add(bead.id);
      rows.push(toTicketRow(bead, epic));
      const children = childrenByParent.get(bead.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  for (const t of workBeads) {
    if (!grouped.has(t.id)) rows.push(toTicketRow(t, undefined));
  }
  return rows;
}

export async function getTickets(project: Project, filters: TicketFilters): Promise<TicketRow[]> {
  const allBeads = (await listAllBeads(project)).filter((b) => !NON_WORK.has(b.issue_type ?? ""));
  const rows = buildTicketRows(allBeads);

  const base = await githubBaseUrl(project.repoPath);
  for (const row of rows) attachPrUrl(row, base);

  return applyFilters(rows, filters);
}
