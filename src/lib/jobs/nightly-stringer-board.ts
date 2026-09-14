/**
 * The nightly scan pass's two board legs (anton-ol1l): the section triage routes signals against,
 * and the push that lands the beads it filed. Split out of the job handler so each is exercisable
 * on its own — a board read is the step most likely to degrade in the field, and the one whose
 * degradation must stay legible.
 */
import { beads } from "../beads/bd";
import {
  buildBoardContext,
  formatBoardContext,
  formatBoardContextUnavailable,
} from "../board-context";
import { appendSessionLog } from "../sessions";

/**
 * The board section of the triage prompt (anton-ol1l). Read from the whole board — `--status all`,
 * because a feature's children and an epic's tier are only legible with closed beads in the read,
 * and a closed EPIC is itself a placement candidate (§4.1 reopens one rather than duplicating it).
 *
 * A failed read degrades to an explicit UNAVAILABLE notice rather than an omitted section: triage
 * still has `bd` and can read the board itself, whereas silence would read as an empty board and
 * every signal would mint a fresh orphan cluster.
 *
 * Pulled first, as the gardener does before any board-derived write: this checkout's local Dolt
 * state can be a sync heartbeat behind another machine's push, and a bead invisible here is a
 * fingerprint and a touch surface triage will not dedupe against. Best-effort — an unreachable
 * remote costs freshness, not the section, and every verdict below is still correct against the
 * local board.
 */
export async function readBoardContext(
  repoPath: string,
  logPath: string,
  slug: string,
): Promise<string> {
  try {
    await appendSessionLog(logPath, `[stringer] board pull before read\n`);
    await beads.pull(repoPath).catch(async (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      await appendSessionLog(logPath, `[stringer] WARNING: board pull failed — ${reason}\n`);
      console.warn(`[nightly-stringer] ${slug}: board pull failed — ${reason}`);
    });
    const board = await beads.list(repoPath, ["--status", "all"]);
    const ctx = buildBoardContext(board);
    await appendSessionLog(
      logPath,
      `[stringer] board context: ${ctx.features.length} open feature(s), ${ctx.epics.length} epic(s), ` +
        `${ctx.producers.length} producer-filed bead(s)\n`,
    );
    return formatBoardContext(ctx);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await appendSessionLog(logPath, `[stringer] WARNING: board context unavailable — ${reason}\n`);
    console.warn(`[nightly-stringer] ${slug}: board context unavailable — ${reason}`);
    return formatBoardContextUnavailable(reason);
  }
}

/**
 * Push the beads the triage session wrote via `bd` to the Dolt remote. Best-effort: the beads are
 * already on the local board, so an unreachable remote costs a sync, not the pass.
 */
export async function syncBoard(repoPath: string): Promise<void> {
  await beads
    .sync(repoPath)
    .catch((e) => console.error("[nightly-stringer] beads dolt sync failed", e));
}
