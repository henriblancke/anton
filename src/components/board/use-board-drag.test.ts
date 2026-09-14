// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";

import { STAGES, type Board, type Epic, type Stage } from "@/lib/types";
import { makeEpicRow } from "@/components/board/epic.fixture";
import { dropTarget, findEpic } from "@/components/board/use-board-drag";

/** A board holding `anton-1` in the backlog and `anton-2` in review. */
function board(): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  columns.backlog = [makeEpicRow("anton-1")];
  columns["in-review"] = [makeEpicRow("anton-2", { stage: "in-review" })];
  return {
    projectSlug: "tmp",
    version: "1:sync",
    columns,
    standalone: Object.fromEntries(STAGES.map((s) => [s, []])) as unknown as Board["standalone"],
    operatorQueue: [],
    sync: {
      state: "synced",
      lastSyncedAt: 1,
      lastPushedAt: 1,
      unpushedCount: 0,
      lastError: null,
      stalledForMs: null,
    },
  };
}

/** A drop of `id` (dragged out of `from`) onto the droppable `over`. */
function drop(id: string, from: Stage | undefined, over: string | null): DragEndEvent {
  return {
    active: { id, data: { current: from ? { stage: from } : {} } },
    over: over === null ? null : { id: over },
  } as unknown as DragEndEvent;
}

describe("dropTarget", () => {
  it("reads the moved card and its destination out of a cross-column drop", () => {
    const target = dropTarget(board(), drop("anton-1", "backlog", "implementing"));
    expect(target?.epic.id).toBe("anton-1");
    expect(target?.toStage).toBe("implementing");
  });

  it("declines a drop back into the column the card came from", () => {
    // Committing this would POST a move to the stage the card already sits in.
    expect(dropTarget(board(), drop("anton-1", "backlog", "backlog"))).toBeNull();
  });

  it("declines a release over no droppable at all", () => {
    expect(dropTarget(board(), drop("anton-1", "backlog", null))).toBeNull();
  });

  it("declines a card the board no longer holds", () => {
    // A poll can retire a card mid-drag; moving one the board has dropped would 404 the route.
    expect(dropTarget(board(), drop("anton-gone", "backlog", "done"))).toBeNull();
  });

  it("declines a drop onto a lane card — an Up Next row is not a stage named after a bead", () => {
    // The Up Next lane's cards are droppables of their own, so `over` is only a column when it says
    // it is. Reading a bead id as a stage would POST a move to a stage that does not exist.
    expect(dropTarget(board(), drop("anton-1", "backlog", "anton-2"))).toBeNull();
  });

  it("declines a drag that carries no source stage", () => {
    expect(dropTarget(board(), drop("anton-1", undefined, "done"))).toBeNull();
  });
});

describe("findEpic", () => {
  it("finds the overlay's card in whichever column holds it", () => {
    expect(findEpic(board(), "anton-2")?.stage).toBe("in-review");
  });

  it("is null with no board or nothing being dragged", () => {
    expect(findEpic(null, "anton-1")).toBeNull();
    expect(findEpic(board(), null)).toBeNull();
    expect(findEpic(board(), "anton-gone")).toBeNull();
  });
});
