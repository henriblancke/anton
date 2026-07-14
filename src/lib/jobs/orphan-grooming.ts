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
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

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

/** Open, non-epic beads with no parent — the loose tickets to bucket. Pure, for unit testing. */
export function findOrphans(all: Bead[]): Bead[] {
  const parented = parentedIds(all);
  return all.filter(
    (b) =>
      !beads.isEpic(b) &&
      b.status !== "closed" &&
      !parented.has(b.id) &&
      !(b.labels?.includes(ORPHAN_EPIC_LABEL) ?? false),
  );
}

/** Build the runner handler bound to a db/clock. Register it as the "orphan-grooming" handler. */
export function makeOrphanGroomingHandler(deps: OrphanGroomingDeps): JobHandler {
  const db = deps.db;
  void (deps.clock ?? systemClock); // reserved for future time-based grooming (e.g. age threshold)

  return async function orphanGrooming(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as OrphanGroomingPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;

    const all = await beads.list(repo, ["--status", "all"]);
    const orphans = findOrphans(all);
    if (orphans.length === 0) return; // nothing loose — done.

    await ctx.heartbeat();

    // Reuse an open grooming epic if one exists, else create one.
    let epicId = all.find(
      (b) => beads.isEpic(b) && b.status !== "closed" && b.labels?.includes(ORPHAN_EPIC_LABEL),
    )?.id;

    if (!epicId) {
      epicId = await beads.create(repo, {
        title: "Loose tickets — needs triage",
        type: "epic",
        description: [
          "## Goal",
          "Bucket for orphaned tickets (no parent epic) collected by anton's orphan-grooming job.",
          "Review, split into real epics, and approve — or close what isn't worth doing.",
          "",
          "## Acceptance",
          "- [ ] Every ticket here is triaged: moved to a real epic or closed.",
        ].join("\n"),
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
  };
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
