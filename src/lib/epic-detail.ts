/**
 * Epic detail page: the epic, its full description, its tickets, and the dependency graph
 * among {epic + tickets}. Edges come from `bd dep list` on each ticket, filtered to members
 * of the epic's own graph. See DESIGN.md §2/§3.
 */
import { beads, type BeadPatch } from "./beads/bd";
import { ensureDescription } from "./beads/issues";
import { nudgeSync } from "./beads/sync-nudge";
import { getDb } from "./db";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { findOpenRunForEpic } from "./runs";
import { parseAcceptance, parseGoal, toEpic, toTicket } from "./ticket-view";
import { listAllBeads } from "./tickets";
import type { DepEdge, DepType, EpicDetail, EpicRun, Project } from "./types";

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

export async function getEpicDetail(project: Project, epicId: string): Promise<EpicDetail> {
  const all = await listAllBeads(project); // one call: carries parent + inline dependencies
  const lite = all.find((b) => b.id === epicId);
  if (!lite) {
    throw new Error(`Epic not found: ${epicId}`);
  }
  // Serve the contract off the snapshot bead; only a description the list dropped costs a `bd show`.
  const full = await ensureDescription(project.repoPath, lite);
  const run = await openRunFor(project, epicId);
  const base = await githubBaseUrl(project.repoPath);

  // The board renders orphan (parentless) non-epic beads as single-ticket pseudo-epic cards
  // (board.ts ticketAsEpic). Mirror that here so opening one shows its detail instead of 404ing —
  // it becomes an epic whose only member is itself, with no children and no epic-graph edges.
  if (!beads.isEpic(lite)) {
    const self = toTicket(lite);
    const epic = toEpic(lite, {
      goal: parseGoal(full.description),
      acceptance: parseAcceptance(full),
      tickets: [self],
    });
    attachPrUrl(epic, base);
    attachPrUrl(self, base);
    return { epic, description: full.description, tickets: [self], edges: [], run };
  }

  const childBeads = all.filter(
    (b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId,
  );
  const tickets = childBeads.map(toTicket);

  // The epic-detail header shows the epic's own agent/risk/size chips (like the board card and the
  // single-ticket pseudo-epic) so an epic with risk:/size: labels doesn't silently drop them. See
  // ticket-view.ts; `chips` defaults to true.
  const epic = toEpic(lite, {
    goal: parseGoal(full.description),
    acceptance: parseAcceptance(full),
    tickets,
  });
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
 * Apply a field patch to an epic bead and return the refreshed detail. Mirrors ticket-detail's
 * updateTicket: the bead is read first so label edits diff against its current labels, and the
 * post-write read reflects the write (getEpicDetail blocks on the pending write by default, so it
 * never serves the stale snapshot). Today the only field is priority (see epic-patch.ts); an empty
 * patch writes nothing. Throws on an unknown id, so the API can answer 404.
 */
export async function updateEpic(
  project: Project,
  epicId: string,
  patch: BeadPatch,
): Promise<EpicDetail> {
  const current = await beads.show(project.repoPath, epicId); // 404 guard + current labels
  await beads.update(project.repoPath, epicId, patch, current.labels ?? []);
  // Read-after-write: getEpicDetail reads the board snapshot, which blocks on the pending local write
  // (blockOnPendingWrite defaults true), so the response carries the new priority — not the stale
  // pre-write board. The board/backlog then re-sort on it (priority is already a sort key).
  const detail = await getEpicDetail(project, epicId);
  // The update already landed locally; propagate without blocking the response. nudgeSync fires the
  // immediate push AND enqueues the durable sync-push backstop (anton-nowq), like deleteEpic.
  nudgeSync(project, "epic-detail");
  return detail;
}

/**
 * Permanently delete an epic and all of its child tickets (`bd delete --cascade`). Cascade is
 * required because the children depend on the epic via parent-child edges — a plain delete would
 * fail. Throws if the id doesn't resolve, so the API can answer 404.
 */
export async function deleteEpic(project: Project, epicId: string): Promise<void> {
  await beads.show(project.repoPath, epicId); // 404 guard — bd throws on an unknown id
  await beads.delete(project.repoPath, epicId, { cascade: true });
  // The delete already landed locally; propagate without blocking the response. nudgeSync fires the
  // immediate push AND enqueues the durable sync-push backstop (anton-nowq).
  nudgeSync(project, "epic-detail");
}
