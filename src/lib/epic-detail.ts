/**
 * Epic detail page: the epic, its full description, its tickets, and the dependency graph
 * among {epic + tickets}. Edges come from `bd dep list` on each ticket, filtered to members
 * of the epic's own graph. See DESIGN.md §2/§3.
 */
import { beads, type Bead, type BeadPatch } from "./beads/bd";
import { withBeadWriteLocks } from "./beads/claim-lock";
import { isPipelineArtifact } from "./beads/contract";
import { ensureDescription } from "./beads/issues";
import { descendantsOf } from "./beads/subtree";
import { nudgeSync } from "./beads/sync-nudge";
import { getDb } from "./db";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import { findOpenRunForEpic } from "./runs";
import { parentEpicOf, parseAcceptance, parseGoal, runTickets, toEpic, toTicket } from "./ticket-view";
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
  const parentEpic = parentEpicOf(lite, all);

  // A RUN TARGET reports the whole working-layer subtree it ships (runTickets) rather than one
  // parent hop — the same set the board card counts and the run executes, so the page never shows
  // fewer tickets than the PR will contain. A container epic owns no run: its members are the
  // feature cards directly beneath it, each shipping its own PR, so it still reads one hop down.
  // Either way, pipeline plumbing is not a member: `runTickets` refuses it, and the one-hop read
  // must too — a poured molecule or a gate hung under a container epic is coordination, not a
  // deliverable this page may count (anton-ve2r).
  const childBeads = beads.isRunTarget(lite, all)
    ? runTickets(all, epicId)
    : all.filter((b) => beads.parentOf(b) === epicId && !isPipelineArtifact(b));

  // A LEAF target — a parentless task/bug chip, or a feature shaped as one unit of work — is its
  // own single ticket, so it renders as an epic whose only member is itself, with no children and
  // no epic-graph edges. Mirrors what the run does (beads.groupsChildren, shared with execute-epic):
  // a feature WITH shaped tickets under it is a grouping target, and must show those tickets and
  // their dependency graph — reporting the feature itself would hide the work the run acts on.
  if (!beads.groupsChildren(lite, childBeads)) {
    const self = toTicket(lite);
    // `full`, not `lite`: the contract is judged off the description, and the list bead may have
    // dropped it — judging the projection would fault a bead for sections nothing read.
    const epic = toEpic(full, {
      goal: parseGoal(full),
      acceptance: parseAcceptance(full),
      tickets: [self],
    });
    attachPrUrl(epic, base);
    attachPrUrl(self, base);
    return { epic, description: full.description, tickets: [self], edges: [], run, parentEpic };
  }

  const tickets = childBeads.map(toTicket);

  // The epic-detail header shows the epic's own agent/risk/size chips (like the board card and the
  // single-ticket pseudo-epic) so an epic with risk:/size: labels doesn't silently drop them. See
  // ticket-view.ts; `chips` defaults to true.
  // `children` carries the raw beads so the header's contract status covers the whole run — the
  // same target-plus-open-tickets set the approve route this page's actions post to gates on.
  const epic = toEpic(full, {
    goal: parseGoal(full),
    acceptance: parseAcceptance(full),
    tickets,
    children: childBeads,
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

  return { epic, description: full.description, tickets, edges, run, parentEpic };
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

/** Thrown when the subtree a delete would destroy moved while the delete was landing (route → 409). */
export class DeleteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteConflictError";
  }
}

/** The beads `bd delete --cascade` destroys: the epic plus its WHOLE subtree, settled ones included. */
const cascadeIds = (epicId: string, subtree: Bead[]): string[] => [
  epicId,
  ...subtree.map((b) => b.id),
];

/**
 * The subtree this delete would erase, or a refusal naming the read it needed. A board we could not
 * read says nothing, and a delete is permanent — so refusing costs a retry, while deleting blind
 * cannot be taken back.
 */
async function cascadeSubtree(repo: string, epicId: string): Promise<Bead[]> {
  try {
    // --skip-labels (bd 1.1.0): the walk reads parent and id only, so label hydration is dead weight.
    return descendantsOf(await beads.list(repo, ["--status", "all", "--skip-labels"]), epicId);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new DeleteConflictError(
      `the work under ${epicId} could not be read (${why}) — nothing was deleted; try again`,
    );
  }
}

/**
 * Permanently delete an epic and all of its child tickets (`bd delete --cascade`). Cascade is
 * required because the children depend on the epic via parent-child edges — a plain delete would
 * fail. Throws if the id doesn't resolve, so the API can answer 404.
 *
 * Taken under the write lock of the epic AND every bead the cascade destroys, with the 404 guard
 * re-read inside them — the same serialization `abandonEpic` settles under, and for a strictly
 * stronger reason: abandon closes the subtree, this erases it (anton-e42l). A gardener approval
 * attaching work anywhere beneath this epic takes the write lock of the bead it moves AND of the
 * card it moves it under (gardener/apply.ts `applyStep`), so an unlocked delete could land between
 * that step's locked re-read and its write — destroying the home mid-move, while the step still
 * reported success and its proposal closed as applied over a subject that no longer exists.
 * Serialized, the delete either lands first — and the step's own locked home re-check refuses
 * (`assertHomeFitsSubject`: a deleted bead is no home at all) — or it waits behind the move and
 * then sees the newcomer in the re-derived subtree below.
 *
 * The subtree is re-derived inside the locks and a CHANGED one refuses, because the lock set was
 * chosen from a snapshot: `bd delete --cascade` erases whatever hangs beneath the epic at write
 * time, so a bead attached after that snapshot would be destroyed while this call holds no lock on
 * it — the one bead a concurrent gardener step could still be writing. Refusing (rather than
 * re-locking the fresh set) keeps the destructive act to work the operator actually saw; nothing has
 * been written yet, so a retry re-plans against the board it just read.
 */
export async function deleteEpic(project: Project, epicId: string): Promise<void> {
  const repo = project.repoPath;
  await beads.show(repo, epicId); // 404 guard — bd throws on an unknown id
  const subtree = await cascadeSubtree(repo, epicId);

  await withBeadWriteLocks(repo, cascadeIds(epicId, subtree), async () => {
    await beads.show(repo, epicId); // re-read under the locks: the guard above judged a pre-lock board
    assertSubtreeUnchanged(epicId, subtree, await cascadeSubtree(repo, epicId));
    await beads.delete(repo, epicId, { cascade: true });
  });
  // The delete already landed locally; propagate without blocking the response. nudgeSync fires the
  // immediate push AND enqueues the durable sync-push backstop (anton-nowq).
  nudgeSync(project, "epic-detail");
}

/**
 * Refuse a delete whose subtree moved between the snapshot its locks were chosen from and the locks
 * it now holds — the gardener re-parent race {@link deleteEpic} serializes against, seen from the
 * side where the move won: the approval attached a bead this delete never locked and would silently
 * erase, while its proposal closes as applied. Naming the ids is the point — the operator retries
 * against a board that now shows the newcomer, and decides again.
 */
function assertSubtreeUnchanged(epicId: string, before: Bead[], after: Bead[]): void {
  const beforeIds = new Set(before.map((b) => b.id));
  const afterIds = new Set(after.map((b) => b.id));
  const attached = [...afterIds].filter((id) => !beforeIds.has(id));
  const detached = [...beforeIds].filter((id) => !afterIds.has(id));
  if (attached.length === 0 && detached.length === 0) return;
  const moved = [
    attached.length > 0 ? `attached ${attached.join(", ")}` : "",
    detached.length > 0 ? `detached ${detached.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new DeleteConflictError(
    `the work under ${epicId} changed while this delete was landing (${moved}) — nothing was ` +
      `deleted; try again so the delete destroys the work the board actually holds`,
  );
}
