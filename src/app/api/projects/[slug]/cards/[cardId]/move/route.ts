import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { moveCard } from "@/lib/board-move";
import { refreshAllIssues } from "@/lib/beads/issues";
import { STAGES } from "@/lib/types";
import type { MoveRequest } from "@/lib/types";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; cardId: string }> },
) {
  const { slug, cardId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const body = (await request.json().catch(() => null)) as MoveRequest | null;
  if (!body || !STAGES.includes(body.toStage)) {
    return NextResponse.json({ error: "Invalid toStage" }, { status: 400 });
  }

  try {
    await moveCard(project, cardId, body.toStage);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Card not found";
    return NextResponse.json({ error: message }, { status: 404 });
  }

  // Answer with the post-move board, not a bare `{ ok: true }` — the write bumped the snapshot
  // version and RETAINED the pre-move beads (invalidateIssueSnapshot only marks them stale). If the
  // client can't advance its version token off this response, its next poll sends the stale version,
  // the non-blocking poll path (blockOnPendingWrite:false) serves the retained pre-move snapshot
  // stamped with the already-advanced version, and the client wholesale-reverts the just-moved card
  // until a background refresh lands ~30s later (anton-4g35). So mirror the GET forced-reload path:
  // await a fresh read so the board reflects the move (falling back to last-good on a transient bd
  // failure rather than 500 the move), build it blocking on the pending write, and return it. The
  // client advances versionRef off `board.version` and its next poll 304s instead of reverting.
  //
  // Both post-write reads are fail-soft: the move already persisted, so a refresh/build failure
  // (cold route with no retained snapshot, `bd list` timeout) must not 500 — the client would roll
  // back a card whose move landed. Fall back to a boardless `{ ok: true }`; the client keeps its
  // optimistic board (it guards on `data?.board`) and reconciles on a later refresh — the anton-4g35
  // transient revert is the lesser evil vs. a hard rollback of a persisted move.
  await refreshAllIssues(project.repoPath).catch(() => {});
  try {
    const board = await getBoard(project);
    return NextResponse.json({ ok: true, board });
  } catch (err) {
    console.error(`[move] board rebuild failed after moving ${cardId}`, err);
    return NextResponse.json({ ok: true });
  }
}
