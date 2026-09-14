"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import type { Board } from "@/lib/types";
import {
  reorderPriority,
  reorderUpNextEntries,
  type UpNextCard,
} from "@/components/board/board-utils";
import { PRIORITY_LABELS } from "@/components/ticket/ticket-dialog-utils";
import type { BoardPoll } from "@/components/board/use-board-poll";

/** The lane's reorder, as the drag layer and the lane itself need it. */
export interface UpNextReorder {
  /** A reorder is being written; the lane closes its handles for the round-trip. */
  reordering: boolean;
  /** Move `beadId` to where `overBeadId` sits in the ranking. */
  reorder: (beadId: string, overBeadId: string) => Promise<void>;
}

/**
 * Reorder inside the Up Next lane (anton-7bzg / R3.8). The drop is persisted as the target's bead
 * `priority` — the same channel product-master writes on — so there is no override state to
 * reconcile and the correction reaches the next picker pass as ordinary board state.
 *
 * A drop the priority channel cannot express — a reorder inside one band, or a slot the picker's own
 * tiebreak would take back — writes nothing and says so. Silently accepting it would teach the
 * operator the lane holds an order it does not.
 */
export function useUpNextReorder(slug: string, state: BoardPoll, cards: UpNextCard[]): UpNextReorder {
  const { board, setBoard, versionRef, startWrite, endWrite, reload } = state;
  // One lane reorder at a time (PR #212 review). Suppressing polls is not enough: a second drop
  // applied optimistically while the first PATCH is out is erased by the first's rollback, and its
  // own success reconciles nothing — the lane would show an order neither write asked for. The ref
  // refuses the second drop synchronously; the state disables the lane's handles so it can't start.
  const reorderingRef = useRef(false);
  const [reordering, setReordering] = useState(false);

  async function reorder(beadId: string, overBeadId: string) {
    if (!board) return;
    // Serialized, not interleaved: this rollback restores the pre-drag ORDER, so a second reorder
    // applied while the first is out would be undone by the first's failure even though its own
    // write succeeded. The lane withdraws itself after a successful reorder anyway, so refusing the
    // second drop costs a beat — where accepting it costs the operator an order nobody asked for.
    if (reorderingRef.current) {
      toast.message("One reorder at a time", {
        description: "The last drop is still being written. Try again once it settles.",
      });
      return;
    }
    const card = cards.find((c) => c.entry.beadId === beadId);
    if (!card) return;

    const verdict = reorderPriority(
      cards.map((c) => c.entry),
      beadId,
      overBeadId,
    );
    if (verdict.kind !== "write") {
      toast.message(
        verdict.kind === "settled" ? "Nothing to change" : "That order can't be written",
        {
          description:
            verdict.kind === "settled"
              ? "The plan already ranks this target where you dropped it."
              : "Priority is the only channel a drag has, and no priority holds that slot — inside one band the picker ranks by how much open work each target unblocks, then by age.",
        },
      );
      return;
    }
    const { priority } = verdict;

    const title = card.kind === "epic" ? card.epic.title : card.item.title;
    // Only the lane moves, and it moves on the LATEST board: a poll can land during the PATCH, and
    // both writing and reverting a whole pre-drag snapshot would throw that poll's result away.
    const previousUpNext = board.upNext;
    reorderingRef.current = true;
    setReordering(true);
    startWrite();
    setBoard((prev) => (prev ? withUpNext(prev, reorderUpNextEntries(prev.upNext ?? [], beadId, overBeadId, priority)) : prev));

    // A standalone chip is a bead in its own right, so it patches through the ticket route; both
    // routes validate the priority server-side (parseEpicPatch / parseTicketPatch).
    const resource = card.kind === "epic" ? "epics" : "tickets";
    let withdrew = false;
    try {
      const res = await fetch(`/api/projects/${slug}/${resource}/${beadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Reorder failed (${res.status})`);
      }
      // The write advanced the snapshot version while RETAINING the pre-write beads, so a poll
      // carrying the pre-write token would take the non-blocking path and serve that retained
      // snapshot — re-showing the very order this drag just corrected (anton-4g35, for the
      // stage-move path). Unlike the move endpoint, a priority PATCH answers with the epic/ticket
      // detail rather than a board, so there is no authoritative version to adopt: drop the token
      // instead, and the next poll asks versionlessly and takes the blocking, post-write path.
      versionRef.current = undefined;
      // A reprioritized bead is one the recorded plan no longer describes (isPlanStale), so the
      // post-write board withholds the lane AND drops the live policy mark `[Release]` reads
      // (isPickerPick). Both are re-read the moment this write settles (`withdrew` below) rather
      // than at the next poll: for that whole beat the lane would otherwise go on offering Release
      // against a plan the server has already invalidated, and that click starts an ordinary
      // approval with none of the picker accept the button promises. Dropping the lane client-side
      // is not enough — its cards would fall back into Backlog still carrying a live mark only the
      // server can retire.
      withdrew = true;
      // Say what the withdrawal is, or it reads as the drag having failed.
      toast.success(`Set "${title}" to ${PRIORITY_LABELS[priority]}`, {
        description: "The lane re-ranks from it on the next board-picker pass.",
      });
    } catch (err) {
      setBoard((prev) => {
        if (!prev) return prev;
        // Restore the pre-drag ORDER, not the pre-drag lane. A veto can land between the drop and
        // this rollback and it drops its target from the lane; writing `previousUpNext` back whole
        // would re-offer the pick the operator just declined until the next poll. Keep only what
        // the current lane still ranks, so both updates stand.
        const stillRanked = new Set((prev.upNext ?? []).map((entry) => entry.beadId));
        return withUpNext(prev, (previousUpNext ?? []).filter((e) => stillRanked.has(e.beadId)));
      });
      toast.error(err instanceof Error ? err.message : "Failed to reorder");
    } finally {
      endWrite();
      reorderingRef.current = false;
      setReordering(false);
    }

    // After the sequence bump, never inside the write: a read issued before it would answer on the
    // superseded write sequence and be discarded by the poll — which is exactly the read this
    // replaces.
    if (withdrew) await reload();
  }

  return { reordering, reorder };
}

/** The board with its lane replaced — ABSENT, never empty (types.ts), so no heading sits over nothing. */
function withUpNext(board: Board, entries: Board["upNext"]): Board {
  const next = { ...board };
  if (entries?.length) next.upNext = entries;
  else delete next.upNext;
  return next;
}
