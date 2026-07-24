/**
 * The Tickets page: a flat, filterable view over every work bead — epics included (each epic
 * row is followed by its child tickets), excluding only `molecule` coordination artifacts.
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

export async function getTickets(project: Project, filters: TicketFilters): Promise<TicketRow[]> {
  const allBeads = (await listAllBeads(project)).filter((b) => !NON_WORK.has(b.issue_type ?? ""));

  const epicBeads = allBeads.filter((b) => beads.isEpic(b));
  const workBeads = allBeads.filter((b) => !beads.isEpic(b));

  // Resolve each ticket's epic from its inline `parent` field — no per-epic bd calls.
  const epicById = new Map(epicBeads.map((e) => [e.id, e]));
  const epicByTicketId = new Map<string, Bead>();
  for (const t of workBeads) {
    const parent = (t.parent ?? t.parent_id) as string | undefined;
    const epic = parent ? epicById.get(parent) : undefined;
    if (epic) epicByTicketId.set(t.id, epic);
  }

  // Group each epic row with its children; orphan tickets trail after. Epics themselves are
  // rows too (type "epic", no parent epic of their own).
  const childrenByEpic = new Map<string, Bead[]>();
  for (const t of workBeads) {
    const epic = epicByTicketId.get(t.id);
    if (!epic) continue;
    const list = childrenByEpic.get(epic.id) ?? [];
    list.push(t);
    childrenByEpic.set(epic.id, list);
  }

  const rows: TicketRow[] = [];
  for (const epic of epicBeads) {
    rows.push(toTicketRow(epic, undefined));
    for (const child of childrenByEpic.get(epic.id) ?? []) {
      rows.push(toTicketRow(child, epic));
    }
  }
  for (const t of workBeads) {
    if (!epicByTicketId.has(t.id)) rows.push(toTicketRow(t, undefined));
  }

  const base = await githubBaseUrl(project.repoPath);
  for (const row of rows) attachPrUrl(row, base);

  return applyFilters(rows, filters);
}
