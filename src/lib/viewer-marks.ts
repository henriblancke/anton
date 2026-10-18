/**
 * THE WATERMARK (anton-z8j4q): when each viewer last looked at a project's timeline.
 *
 * The since-you-looked timeline is a fold over rows anton already writes, so the only state it needs
 * of its own is a line in the sand — read up to here. That single value is what turns "everything
 * that ever happened" into "what happened since you looked", and it has to outlive a reload, a tab,
 * and a restart, which is why it is a row rather than client storage.
 *
 * ## It only ever moves forward
 *
 * A mark is posted from whichever tab the operator clicked in, and tabs go stale. A board left open
 * since this morning still holds this morning's watermark; letting its POST win would un-see every
 * event of the afternoon and resurface work the operator already read — the exact noise the feature
 * exists to remove. So an earlier mark is a NO-OP, not a rewind, and the guard lives in the upsert's
 * own `WHERE` rather than in a read-then-write: two tabs posting at once would both read the old
 * value and the later writer would win on wall-clock order, which is not the same as the greater
 * mark. SQLite settles it atomically instead.
 *
 * Moving a mark BACK is a legitimate thing to want — "show me yesterday again" — and it is a
 * different operation from marking seen, not a special case of it. The read side already takes an
 * explicit `since` for exactly that, so a viewer can look further back without disturbing the
 * watermark they will return to.
 *
 * db-injectable like the other per-project stores (`picker-veto`, `run-health`): the API routes go
 * through the shared anton.db and the tests through their own connection.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { toEpoch } from "./db/epoch";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * The viewer every mark is written under until accounts exist (feature anton-8ubg3 scopes identity
 * out). Stored as data in `viewer_id` rather than assumed by a single-row table, so landing real
 * viewers is a write of a different string and not a migration plus a rewrite of every read.
 */
export const DEFAULT_VIEWER_ID = "default";

/** A viewer's watermark on one project. Epoch SECONDS, the convention every view model here uses. */
export interface ViewerMark {
  viewerId: string;
  /** The instant read up to. */
  seenAt: number;
  /** When that instant was last moved — a different question, and the one "you last looked" asks. */
  updatedAt: number;
}

export interface MarkSeenInput {
  projectId: string;
  /** Epoch seconds to mark read up to. */
  seenAt: number;
  viewerId?: string;
}

/** What a mark-seen did. `moved: false` is the stale-tab no-op, and is a success, not a rejection. */
export interface MarkSeenResult {
  mark: ViewerMark;
  moved: boolean;
}

/** Whole seconds, matching the column's storage — a fractional mark would compare inconsistently. */
function toSeconds(epochSeconds: number): number {
  return Math.floor(epochSeconds);
}

function rowToMark(row: typeof schema.viewerMarks.$inferSelect): ViewerMark {
  return {
    viewerId: row.viewerId,
    seenAt: toEpoch(row.seenAt) ?? 0,
    updatedAt: toEpoch(row.updatedAt) ?? 0,
  };
}

/** This viewer's watermark, or undefined when they have never looked at this project. */
export async function getViewerMark(
  db: AntonDb,
  projectId: string,
  viewerId: string = DEFAULT_VIEWER_ID,
): Promise<ViewerMark | undefined> {
  const [row] = await db
    .select()
    .from(schema.viewerMarks)
    .where(
      and(eq(schema.viewerMarks.viewerId, viewerId), eq(schema.viewerMarks.projectId, projectId)),
    )
    .limit(1);
  return row ? rowToMark(row) : undefined;
}

/**
 * Move a viewer's watermark forward to `seenAt`, or leave it where it is.
 *
 * One statement: insert the mark, and on the (viewer, project) conflict update it only when the
 * incoming instant is strictly greater than the stored one. `setWhere` is what makes that atomic —
 * the comparison happens inside the conflict resolution, against the row as it stands at that
 * instant, so concurrent posts cannot interleave a stale value past a fresh one.
 *
 * Strictly greater, so re-posting the SAME instant reports `moved: false`. Idempotent either way:
 * the stored watermark is identical, and a caller distinguishing "I advanced it" from "someone
 * already had" is the one that needs the flag.
 */
export async function markSeen(
  db: AntonDb,
  clock: Clock,
  input: MarkSeenInput,
): Promise<MarkSeenResult> {
  const viewerId = input.viewerId ?? DEFAULT_VIEWER_ID;
  const seenAt = toSeconds(input.seenAt);
  const updatedAt = toSeconds(clock.now() / 1000);

  const written = await db
    .insert(schema.viewerMarks)
    .values({
      viewerId,
      projectId: input.projectId,
      seenAt: new Date(seenAt * 1000),
      updatedAt: new Date(updatedAt * 1000),
    })
    .onConflictDoUpdate({
      target: [schema.viewerMarks.viewerId, schema.viewerMarks.projectId],
      set: { seenAt: new Date(seenAt * 1000), updatedAt: new Date(updatedAt * 1000) },
      setWhere: sql`${schema.viewerMarks.seenAt} < ${seenAt}`,
    })
    .returning();

  // The refused update returns no row — the mark that stands is the stored one, which the caller
  // still needs, so it is read back rather than echoed from the input it did not become.
  if (written.length > 0) return { mark: rowToMark(written[0]), moved: true };
  const existing = await getViewerMark(db, input.projectId, viewerId);
  // Only reachable if the row vanished between the refused upsert and this read (a project
  // teardown); reporting the input as stored would invent a mark nothing holds.
  if (!existing) throw new Error(`markSeen(${input.projectId}): mark disappeared mid-write`);
  return { mark: existing, moved: false };
}

/** The shared-anton.db read the API routes use. */
export async function getViewerMarkForProject(
  projectId: string,
  viewerId: string = DEFAULT_VIEWER_ID,
): Promise<ViewerMark | undefined> {
  return getViewerMark(getDb(), projectId, viewerId);
}
