/**
 * The Tickets page: a flat, filterable view over every work bead (excludes epics and
 * `molecule` coordination artifacts). Mirrors board.ts's read + section-parsing patterns —
 * see DESIGN.md §2/§3.
 */
import { beads, type Bead } from "./beads/bd";
import { deriveStage } from "./board";
import type { Project, TicketFilters, TicketRow } from "./types";

const NON_WORK = new Set(["molecule"]);

function parseSection(description: string | undefined, name: string): string | undefined {
  if (!description) return undefined;
  const lines = description.split("\n");
  const re = new RegExp(`^##\\s*${name}\\b`, "i");
  const startIdx = lines.findIndex((l) => re.test(l.trim()));
  if (startIdx === -1) return undefined;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^##\s+/.test(l.trim()));
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
  const text = body.join("\n").trim();
  return text || undefined;
}

export const parseGoal = (d: string | undefined): string | undefined => parseSection(d, "Goal");

export const parseAcceptance = (bead: Bead): string | undefined =>
  parseSection(bead.description, "Acceptance") ?? bead.acceptance_criteria ?? bead.acceptance;

export function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const label = labels?.find((l) => l.startsWith(`${prefix}:`));
  return label ? label.slice(prefix.length + 1) : undefined;
}

export async function listAllBeads(project: Project): Promise<Bead[]> {
  try {
    return await beads.list(project.repoPath, ["--status", "all"]);
  } catch {
    const [open, closed] = await Promise.all([
      beads.list(project.repoPath),
      beads.list(project.repoPath, ["--status", "closed"]),
    ]);
    const seen = new Set<string>();
    return [...open, ...closed].filter((b) => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
  }
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
    prRef: bead.external_ref,
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
    if (q && !row.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

export async function getTickets(project: Project, filters: TicketFilters): Promise<TicketRow[]> {
  const allBeads = (await listAllBeads(project)).filter((b) => !NON_WORK.has(b.issue_type ?? ""));

  const epicBeads = allBeads.filter((b) => beads.isEpic(b));
  const workBeads = allBeads.filter((b) => !beads.isEpic(b));

  const epicByTicketId = new Map<string, Bead>();
  for (const epic of epicBeads) {
    let children: Bead[] = [];
    try {
      children = await beads.children(project.repoPath, epic.id);
    } catch {
      children = workBeads.filter((t) => t.parent_id === epic.id);
    }
    if (children.length === 0) {
      children = workBeads.filter((t) => t.parent_id === epic.id);
    }
    for (const child of children) epicByTicketId.set(child.id, epic);
  }

  const rows = workBeads.map((bead) => toTicketRow(bead, epicByTicketId.get(bead.id)));
  return applyFilters(rows, filters);
}
