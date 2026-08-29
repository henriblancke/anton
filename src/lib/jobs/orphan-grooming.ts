/**
 * orphan-grooming job (anton-3t2.4). Loose tickets — open, non-epic beads with no parent epic —
 * accumulate on the board and never get executed (the executor only runs approved epics). This job
 * periodically buckets them under a single grooming epic so they become schedulable work a human
 * can approve. See DESIGN §4/§6.
 *
 * Deterministic (no LLM): it groups every current orphan under ONE grooming epic, reusing the same
 * epic across runs (found by its `source:orphan-grooming` label) so repeated runs don't spawn a new
 * epic each time. Idempotent — a ticket already parented is no longer an orphan, so re-runs are safe.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { isTicketTier, SUCCESS_HEADING } from "../beads/contract";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobEffect, JobHandler } from "./runner";

export interface OrphanGroomingPayload {
  projectId: string;
  scheduleId?: string;
}

export interface OrphanGroomingDeps {
  db: AntonDb;
  clock?: Clock;
}

/** Marks the epic this job creates/reuses to bucket orphans (so runs are idempotent). */
export const ORPHAN_EPIC_LABEL = LABELS.source("orphan-grooming");

export const ORPHAN_EPIC_TITLE = "Loose tickets — needs triage";

/**
 * The grooming epic's body. anton writes this bead for itself, so it must satisfy the same epic
 * contract anton enforces on everyone else — `## Goal` plus the epic tier's `## Success Criteria`
 * ({@link SUCCESS_HEADING}). Spelled `## Acceptance` it is an epic bd's own validator refuses, and
 * gardener's lint sweep would file a permanent hygiene finding against it on every run.
 */
export const ORPHAN_EPIC_DESCRIPTION = [
  "## Goal",
  "Bucket for orphaned tickets (no parent epic) collected by anton's orphan-grooming job.",
  "Review, split into real epics, and approve — or close what isn't worth doing.",
  "",
  `## ${SUCCESS_HEADING}`,
  "- [ ] Every ticket here is triaged: moved to a real epic or closed.",
].join("\n");

/** Set of bead ids that are the child in a parent-child edge (i.e. have a parent). */
function parentedIds(all: Bead[]): Set<string> {
  const parented = new Set<string>();
  for (const b of all) {
    // `bd list --json` also carries the parent inline on the child.
    const p = (b.parent ?? b.parent_id) as string | undefined;
    if (p) parented.add(b.id);
  }
  for (const e of beads.edgesOf(all)) {
    if (e.type === "parent-child") parented.add(e.from);
  }
  return parented;
}

/**
 * Open, non-epic beads with no parent that anton CAN'T already run standalone — the loose tickets to
 * bucket. Pure, for unit testing.
 *
 * A parentless task/bug is a runnable standalone target (`beads.isRunTarget`): the board renders it
 * as an "Approve & run" chip and the approve route/runner execute it as an epic-of-one. Grooming
 * MUST NOT touch those — parenting one under the grooming epic turns it into a child ticket, which
 * `isRunTarget` then rejects, so its standalone chip disappears and the approve route redirects users
 * to run the whole grooming epic instead (anton-cmz review). We only bucket orphans that are NOT
 * independently runnable — in practice parentless chores.
 *
 * Only TICKET-TIER types are bucketed (`isTicketTier` — the same taxonomy dispatch and the contract
 * gate share). An exempt type (`learning`, `molecule`, a custom type) rides on NO run: parenting one
 * here would give the grooming epic a child `runTickets` never dispatches, so the epic's run would
 * complete and close around it — the orphan stranded open under a done epic. Exempt beads stay
 * loose instead, visible on the Tickets list for a human to retype or close.
 */
export function findOrphans(all: Bead[]): Bead[] {
  const parented = parentedIds(all);
  return all.filter(
    (b) =>
      isTicketTier(b) &&
      !beads.isRunTarget(b, all) &&
      b.status !== "closed" &&
      !parented.has(b.id) &&
      !(b.labels?.includes(ORPHAN_EPIC_LABEL) ?? false),
  );
}

/** Build the runner handler bound to a db/clock. Register it as the "orphan-grooming" handler. */
export function makeOrphanGroomingHandler(deps: OrphanGroomingDeps): JobHandler {
  const db = deps.db;
  void (deps.clock ?? systemClock); // reserved for future time-based grooming (e.g. age threshold)

  return async function orphanGrooming(ctx: JobContext): Promise<JobEffect> {
    const { projectId } = ctx.payload as OrphanGroomingPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;

    const all = await beads.list(repo, ["--status", "all"]);
    const orphans = findOrphans(all);
    if (orphans.length === 0) return { changed: false, note: "no loose tickets" };

    await ctx.heartbeat();

    // Reuse an open grooming epic if one exists, else create one.
    let epicId = all.find(
      (b) => beads.isEpic(b) && b.status !== "closed" && b.labels?.includes(ORPHAN_EPIC_LABEL),
    )?.id;

    if (!epicId) {
      epicId = await beads.create(repo, {
        title: ORPHAN_EPIC_TITLE,
        type: "epic",
        description: ORPHAN_EPIC_DESCRIPTION,
      });
      await beads.tag(repo, epicId, [ORPHAN_EPIC_LABEL]);
    }

    // Link each orphan under the epic (child → parent). Best-effort per ticket so one bad id
    // doesn't strand the rest — but a persistent failure is logged (not silently dropped) so a
    // ticket that never gets grouped is visible.
    let linked = 0;
    const failed: string[] = [];
    for (const orphan of orphans) {
      if (orphan.id === epicId) continue;
      try {
        await beads.link(repo, orphan.id, epicId, "parent-child");
        linked += 1;
      } catch (e) {
        failed.push(orphan.id);
        console.error(`[orphan-grooming] failed to link ${orphan.id} under ${epicId}:`, e);
      }
    }

    const noteBody = failed.length
      ? `orphan-grooming: bucketed ${linked} loose ticket(s); ${failed.length} failed to link (${failed.join(", ")}).`
      : `orphan-grooming: bucketed ${linked} loose ticket(s).`;
    await safe(() => beads.note(repo, epicId!, noteBody));

    await beads
      .sync(repo)
      .catch((e) => console.error("[orphan-grooming] beads dolt sync failed", e));

    // `linked`, not `orphans.length`: a ticket bd refused to link was not bucketed, and the row must
    // not claim it was.
    return { changed: linked > 0, note: `bucketed ${linked} loose ticket(s)` };
  };
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
