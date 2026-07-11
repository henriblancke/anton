/**
 * Assembles the Board from beads. Stage/approval/PR are derived — never stored. See DESIGN.md §2/§3.
 */
import { beads, type Bead } from "./beads/bd";
import { STAGES, type Board, type Epic, type Project, type Stage, type Ticket } from "./types";

export function deriveStage(bead: Bead): Stage {
  if (bead.status === "closed") return "done";
  const labels = bead.labels ?? [];
  if (labels.includes("stage:in-review") || bead.external_ref) return "in-review";
  if (bead.status === "in_progress" || labels.includes("stage:implementing")) {
    return "implementing";
  }
  return "backlog";
}

/** Extract a "## <name>" section from a bead description. `bd list --json` returns the
 * description but not the acceptance/context fields, so the board reads the contract here. */
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
const parseGoal = (d: string | undefined) => parseSection(d, "Goal");
const parseAcceptance = (bead: Bead) =>
  parseSection(bead.description, "Acceptance") ?? bead.acceptance_criteria ?? bead.acceptance;

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const label = labels?.find((l) => l.startsWith(`${prefix}:`));
  return label ? label.slice(prefix.length + 1) : undefined;
}

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

function ticketAsEpic(bead: Bead): Epic {
  const ticket = toTicket(bead);
  return {
    id: bead.id,
    title: bead.title,
    approved: beads.isApproved(bead),
    stage: ticket.stage,
    agent: ticket.agent,
    risk: ticket.risk,
    size: ticket.size,
    tickets: [ticket],
  };
}

export async function getBoard(project: Project): Promise<Board> {
  let allBeads: Bead[];
  try {
    allBeads = await beads.list(project.repoPath, ["--status", "all"]);
  } catch {
    const [open, closed] = await Promise.all([
      beads.list(project.repoPath),
      beads.list(project.repoPath, ["--status", "closed"]),
    ]);
    const seen = new Set<string>();
    allBeads = [...open, ...closed].filter((b) => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
  }

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
    const built: Epic = {
      id: epic.id,
      title: epic.title,
      goal: parseGoal(epic.description),
      acceptance: parseAcceptance(epic),
      approved: beads.isApproved(epic),
      stage: deriveStage(epic),
      agent: labelValue(epic.labels, "agent"),
      risk: labelValue(epic.labels, "risk"),
      size: labelValue(epic.labels, "size"),
      prRef: epic.external_ref,
      tickets,
    };
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

  return {
    projectSlug: project.slug,
    columns,
  };
}
