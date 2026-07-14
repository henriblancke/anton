/**
 * Ticket detail popup: a single ticket with its full contract (goal/acceptance/description),
 * managed labels, and its parent epic — plus the write-back that maps an edit to ONE bd update.
 * Mirrors the read/parse patterns in epic-detail.ts and tickets.ts. See DESIGN.md §2/§3.
 */
import { beads, type BeadPatch } from "./beads/bd";
import { deriveStage } from "./board";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { labelValue, listAllBeads, parseAcceptance, parseGoal } from "./tickets";
import type { Bead } from "./beads/bd";
import type { Project, TicketDetail } from "./types";

function toTicketDetail(lite: Bead, full: Bead, epic: Bead | undefined): TicketDetail {
  return {
    id: lite.id,
    title: lite.title,
    status: lite.status,
    stage: deriveStage(lite),
    agent: labelValue(lite.labels, "agent"),
    risk: labelValue(lite.labels, "risk"),
    size: labelValue(lite.labels, "size"),
    domain: labelValue(lite.labels, "domain"),
    acceptance: parseAcceptance(full),
    prRef: lite.external_ref,
    type: lite.issue_type ?? "task",
    priority: lite.priority,
    goal: parseGoal(full.description),
    description: full.description,
    epicId: epic?.id,
    epicTitle: epic?.title,
  };
}

export async function getTicketDetail(project: Project, id: string): Promise<TicketDetail> {
  const all = await listAllBeads(project); // one call: carries parent + inline dependencies
  const lite = all.find((b) => b.id === id);
  if (!lite) {
    throw new Error(`Ticket not found: ${id}`);
  }
  // `bd list` omits the description, so fetch the bead once for its goal/acceptance markdown.
  const full = await beads.show(project.repoPath, id).catch(() => lite);

  const parentId = (lite.parent ?? lite.parent_id) as string | undefined;
  const epic = parentId ? all.find((b) => b.id === parentId) : undefined;

  const base = await githubBaseUrl(project.repoPath);
  return attachPrUrl(toTicketDetail(lite, full, epic), base);
}

/**
 * Apply a field patch to the bead and return the refreshed detail. The bead is read first so
 * label edits diff against its current labels (preserving the approved, stage, and source
 * control labels); an empty patch writes nothing.
 */
export async function updateTicket(
  project: Project,
  id: string,
  patch: BeadPatch,
): Promise<TicketDetail> {
  const current = await beads.show(project.repoPath, id);
  await beads.update(project.repoPath, id, patch, current.labels ?? []);
  await beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after updating ${id}`, e));
  return getTicketDetail(project, id);
}

/**
 * Permanently delete a ticket bead. Throws if the id doesn't resolve to a bead, so the API can
 * answer 404 instead of silently succeeding. A ticket may have dependents (e.g. a sibling that
 * `blocks`-links it); `bd delete --force` orphans those links rather than failing.
 */
export async function deleteTicket(project: Project, id: string): Promise<void> {
  await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  await beads.delete(project.repoPath, id);
  await beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after deleting ${id}`, e));
}
