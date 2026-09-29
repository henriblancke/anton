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
import { extractOutcomeIdsSection } from "../backlog";
import { beads, LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLock } from "../beads/claim-lock";
import { isTicketTier } from "../beads/contract";
import { beadSkeleton } from "../beads/formula";
import { unterminatedCloser } from "../beads/markdown";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobEffect, JobHandler } from "./runner";
import { safe } from "./safe";

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
 * The grooming epic's content vars. anton writes this bead for itself, so it must satisfy the
 * same epic contract every other producer renders through — `beadSkeleton` (src/prompts/BEADS.md)
 * — rather than a hand-rolled description the contract gate never sees drift from it.
 *
 * `codebase-health` is the outcome id every project has whether or not `.product/PRODUCT.md`
 * lists it ({@link BUILT_IN_OUTCOME} in outcomes.ts) — triaging loose tickets is board hygiene,
 * not any one feature's outcome, so it's the only id that's always a valid, safe choice here.
 */
export const ORPHAN_EPIC_VARS = {
  outcome:
    "Bucket for orphaned tickets (no parent epic) collected by anton's orphan-grooming job. " +
    "Review, split into real epics, and approve — or close what isn't worth doing.",
  success_criteria: "- [ ] Every ticket here is triaged: moved to a real epic or closed.",
  outcome_ids: "outcome:codebase-health",
};

/** Render the grooming epic's contract markdown through the project's own bead formula. */
export async function orphanEpicSkeleton(repo: string) {
  return beadSkeleton(repo, "epic", ORPHAN_EPIC_VARS);
}

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
    const existing = all.find(
      (b) => beads.isEpic(b) && b.status !== "closed" && b.labels?.includes(ORPHAN_EPIC_LABEL),
    );

    let epicId: string;
    let createdEpic = false;
    if (existing) {
      epicId = existing.id;
      // Locked, and re-read inside the lock: `existing` is a snapshot from the `all` read above, and
      // a founder editing this epic's description between that read and this patch must not have
      // their edit silently discarded by `beads.update` replacing the whole field with the stale one.
      await withBeadWriteLock(repo, epicId, async () => {
        const fresh = await beads.show(repo, epicId);
        if (extractOutcomeIdsSection(fresh.description ?? "").present) return;
        // An epic from before outcome ids landed (anton-cdeki) is reused as-is on every subsequent
        // sweep — it's found by its `source:orphan-grooming` label, never by contract shape, so its
        // description would otherwise stay stuck missing `## Outcome IDs` forever. Patch it in
        // place rather than leaving the gap for the next contract-gap sweep to flag.
        const kept = (fresh.description ?? "").trimEnd();
        const closer = unterminatedCloser(kept);
        const description = [
          kept,
          ...(closer ? [closer] : []),
          ``,
          `## Outcome IDs`,
          ``,
          ORPHAN_EPIC_VARS.outcome_ids,
        ].join("\n");
        const patched = await safe(() => beads.update(repo, epicId, { description }, fresh.labels ?? []));
        // Thrown BEFORE any linking below: once an orphan is parented here it stops being an orphan,
        // so a sweep with nothing left to bucket returns early (`orphans.length === 0`) and never
        // revisits this epic — a swallowed failure here would leave it missing `## Outcome IDs`
        // permanently. Failing now keeps every orphan loose so the next sweep retries the patch.
        if (!patched) {
          throw new Error(`orphan-grooming: failed to add Outcome IDs to reused epic ${epicId}`);
        }
      });
    } else {
      const skeleton = await orphanEpicSkeleton(repo);
      epicId = await beads.create(repo, {
        title: ORPHAN_EPIC_TITLE,
        type: "epic",
        description: skeleton.description,
      });
      await beads.tag(repo, epicId, [ORPHAN_EPIC_LABEL]);
      createdEpic = true;
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

    // A pass that bucketed NOTHING because bd refused every link is a failed pass, not a quiet one:
    // every loose ticket is still loose, and `changed: false` would file it as "nothing to do" —
    // indistinguishable, on the Automation row, from a board that simply had no orphans. Thrown
    // (not returned) so it retries and then parks for a human, and thrown only AFTER the note and
    // sync above, so the evidence lands on the epic either way (anton-znoz review).
    if (linked === 0 && failed.length > 0) {
      throw new Error(`orphan-grooming: bd refused every link (${failed.join(", ")})`);
    }

    // `linked`, not `orphans.length`: a ticket bd refused to link was not bucketed, and the row must
    // not claim it was. The failures ride out in the note too, so a partly-failed pass reports the
    // work it did without passing itself off as clean.
    const note = failed.length
      ? `bucketed ${linked} loose ticket(s); ${failed.length} failed to link`
      : `bucketed ${linked} loose ticket(s)`;
    return { changed: linked > 0 || createdEpic, note };
  };
}
