/**
 * Ticket detail popup: a single ticket with its full contract (goal/acceptance/description),
 * managed labels, and its parent epic — plus the write-back that maps an edit to ONE bd update.
 * Mirrors the read/parse patterns in epic-detail.ts and tickets.ts. See DESIGN.md §2/§3.
 */
import { beads, type BeadPatch } from "./beads/bd";
import { allIssues, ensureDescription } from "./beads/issues";
import { formatHumanNote, parseTicketNotes, type TicketNote } from "./beads/notes";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { createdMeta, deriveStage, labelValue, parseAcceptance, parseGoal } from "./ticket-view";
import { listAllBeads } from "./tickets";
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
    ...createdMeta(lite),
    prRef: beads.getPrRef(lite),
    deferred: beads.isDeferred(lite),
    abandoned: beads.isAbandoned(lite),
    type: lite.issue_type ?? "task",
    priority: lite.priority,
    goal: parseGoal(full.description),
    description: full.description,
    epicId: epic?.id,
    epicTitle: epic?.title,
    epicAssignee: epic ? (epic.assignee ?? null) : undefined,
    approved: beads.isApproved(lite),
    // Only the full bead read carries `notes` reliably; `bd list` omits it for beads with none.
    notes: parseTicketNotes(full.notes),
  };
}

const parentOf = (bead: Bead): string | undefined =>
  (bead.parent ?? bead.parent_id) as string | undefined;

/** Finish a detail: the PR link needs the repo's GitHub base, cached per repo in git/remote. */
async function withPrUrl(
  project: Project,
  lite: Bead,
  full: Bead,
  epic: Bead | undefined,
): Promise<TicketDetail> {
  const base = await githubBaseUrl(project.repoPath);
  return attachPrUrl(toTicketDetail(lite, full, epic), base);
}

/** Read a ticket's full detail off the board snapshot (stale-but-retained, so a GET never blocks). */
export async function getTicketDetail(project: Project, id: string): Promise<TicketDetail> {
  // one call: carries parent + inline dependencies
  const all = await listAllBeads(project);
  const lite = all.find((b) => b.id === id);
  if (!lite) {
    throw new Error(`Ticket not found: ${id}`);
  }
  // Serve the contract off the snapshot bead; only a description the list dropped costs a `bd show`.
  const full = await ensureDescription(project.repoPath, lite);

  const parentId = parentOf(lite);
  const epic = parentId ? all.find((b) => b.id === parentId) : undefined;
  return withPrUrl(project, lite, full, epic);
}

/**
 * Detail built from a bead just read by `bd show` — the read-after-write half of updateTicket. That
 * bead is authoritative for the ticket itself (`bd show` carries everything `bd list` does, plus the
 * description), so the board is consulted only for the parent epic's title/assignee, and only when
 * the ticket has a parent.
 *
 * That board read must NOT force a cold `bd list`: the write already bumped the snapshot version, so
 * the client's next poll reloads the board regardless, and blocking here would put a `bd list` —
 * queued behind the Dolt lock — on the save request's critical path for two header fields that the
 * write cannot have changed. `blockOnPendingWrite: false` serves the retained board and kicks the
 * post-write refresh in the background, which is the very load that next poll then shares.
 */
export async function freshDetail(project: Project, bead: Bead): Promise<TicketDetail> {
  const parentId = parentOf(bead);
  const epic = parentId
    ? (await allIssues(project.repoPath, { blockOnPendingWrite: false })).find(
        (b) => b.id === parentId,
      )
    : undefined;
  return withPrUrl(project, bead, bead, epic);
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
  // Read-after-write: the response must reflect the write, not the stale board the snapshot serves,
  // or the edit form resets to pre-write title/labels/approval. One `bd show` is the whole read —
  // it goes straight to bd, so unlike a snapshot refresh it can't be discarded by the sync below
  // bumping the snapshot generation.
  const detail = await freshDetail(project, await beads.show(project.repoPath, id));
  // Fire-and-forget (like the claim route's nudgeSync): the update already landed locally, so don't
  // block the save response on a `bd dolt pull/commit/push` a slow/unreachable remote could stall. A
  // failed push is recorded as "failing"/unpushed in the sync-status registry inside beads.sync and
  // retried by the E1 heartbeat backstop — this catch only keeps the rejection from floating.
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after updating ${id}`, e));
  return detail;
}

/**
 * Cap on one human note. The dispatch prompt inlines notes verbatim, so an unbounded note is an
 * unbounded prompt; anything longer belongs in the ticket's contract fields, not a steer.
 */
export const MAX_NOTE_CHARS = 2000;

/**
 * Append a human note to a ticket and return the refreshed note history (anton-bfy4). This is the
 * steering channel: the note lands on the bead's append-only notes blob, which the dispatch prompt
 * builder reads when the executor picks the ticket up — no new gate, no status change.
 *
 * Throws on an unknown id (bd's own error, so the route can 404) or an empty/oversized note.
 */
export async function addTicketNote(
  project: Project,
  id: string,
  text: string,
  author: string,
): Promise<TicketNote[]> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Note is empty");
  if (trimmed.length > MAX_NOTE_CHARS) {
    throw new Error(`Note is too long (${trimmed.length} > ${MAX_NOTE_CHARS} characters)`);
  }
  await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  await beads.note(
    project.repoPath,
    id,
    formatHumanNote(trimmed, author, new Date()),
    author || undefined,
  );
  // Read-after-write so the response carries the note just appended, not a stale blob.
  const fresh = await beads.show(project.repoPath, id);
  // Fire-and-forget, like every other bd write here: the note already landed locally and the
  // heartbeat backstop retries a failed push — never block the response on a slow remote.
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after noting ${id}`, e));
  return parseTicketNotes(fresh.notes);
}

/**
 * Snooze a ticket out of the ready queue, or restore it (anton-ywi8). Deferring is the "not now,
 * but not dead" move: the bead keeps its contract and history, but `bd ready` skips it so the
 * runtime never dispatches it until a human un-snoozes. Nothing else about the ticket changes.
 *
 * Throws on an unknown id (bd's own error, so the route can 404).
 */
export async function setTicketDeferred(
  project: Project,
  id: string,
  deferred: boolean,
): Promise<TicketDetail> {
  await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  if (deferred) await beads.defer(project.repoPath, id);
  else await beads.undefer(project.repoPath, id);
  // Read-after-write, like updateTicket: the `bd show` bead is authoritative for the snoozed state
  // it just set, so the response never reflects the board's stale snapshot.
  const detail = await freshDetail(project, await beads.show(project.repoPath, id));
  // Fire-and-forget, like every other bd write here: the write already landed locally and the
  // heartbeat backstop retries a failed push — never block the response on a slow remote.
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after deferring ${id}`, e));
  return detail;
}

/**
 * Permanently delete a ticket bead. Throws if the id doesn't resolve to a bead, so the API can
 * answer 404 instead of silently succeeding. A ticket may have dependents (e.g. a sibling that
 * `blocks`-links it); `bd delete --force` orphans those links rather than failing.
 */
export async function deleteTicket(project: Project, id: string): Promise<void> {
  await beads.show(project.repoPath, id); // 404 guard — bd throws on an unknown id
  await beads.delete(project.repoPath, id);
  // Fire-and-forget (like the claim route's nudgeSync): the delete already landed locally, so don't
  // block the response on a `bd dolt pull/commit/push` a slow/unreachable remote could stall. A
  // failed push is recorded as "failing"/unpushed in the sync-status registry inside beads.sync and
  // retried by the E1 heartbeat backstop — this catch only keeps the rejection from floating.
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[ticket-detail] beads dolt sync failed after deleting ${id}`, e));
}
