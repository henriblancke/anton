/**
 * Board drag-and-drop: moving a card to a target Stage is a set of bead label/status ops.
 * `planMove` is pure (unit-testable); `moveCard` reads the bead then executes the plan via
 * the `beads` wrapper, under the card's own write lock. See DESIGN.md §2/§3.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { nudgeSync } from "./beads/sync-nudge";
import type { Project, Stage } from "./types";

export type MoveOp =
  | { kind: "reopen" }
  | { kind: "close" }
  | { kind: "tag"; labels: string[] }
  | { kind: "untag"; labels: string[] };

export function planMove(fromBead: Bead, toStage: Stage): MoveOp[] {
  const ops: MoveOp[] = [];
  const isClosed = fromBead.status === "closed";

  switch (toStage) {
    case "backlog":
      if (isClosed) ops.push({ kind: "reopen" });
      ops.push({
        kind: "untag",
        labels: [LABELS.stage("implementing"), LABELS.stage("in-review")],
      });
      break;
    case "implementing":
      if (isClosed) ops.push({ kind: "reopen" });
      ops.push({ kind: "tag", labels: [LABELS.stage("implementing")] });
      ops.push({ kind: "untag", labels: [LABELS.stage("in-review")] });
      break;
    case "in-review":
      ops.push({ kind: "tag", labels: [LABELS.stage("in-review")] });
      ops.push({ kind: "untag", labels: [LABELS.stage("implementing")] });
      break;
    case "done":
      ops.push({ kind: "close" });
      break;
  }

  return ops;
}

/**
 * A drag is a read-decide-write sequence like any other, so it runs under the card's own bead write
 * lock (anton-e42l) — the same chain a run's claim and the gardener's apply take.
 *
 * Dragging to Done closes the card, and `gardener/apply.ts` `applyStep` decides whether it may hang
 * work under that card from a read taken inside that lock (`homeUnusable`,
 * `assertHomeFitsSubject`), then yields before its write. Outside the lock, this close lands in
 * exactly that gap: the re-parent passes every check and attaches open work beneath a card that is
 * closed by the time it writes, settling as successfully applied. Holding the lock across the read
 * and the ops makes the two orders — either the close lands first and the apply's own locked
 * re-read refuses it, or the re-parent lands first and this close is planned against a board that
 * already holds it.
 */
export async function moveCard(project: Project, cardId: string, toStage: Stage): Promise<void> {
  const ops = await withBeadWriteLock(project.repoPath, cardId, async () => {
    // Read INSIDE the lock: the plan turns on the card's current status, and a status this decided
    // against before waiting for the lock is a status whoever held it may have changed.
    const fromBead = await beads.show(project.repoPath, cardId);
    const planned = planMove(fromBead, toStage);

    for (const op of planned) {
      switch (op.kind) {
        case "reopen":
          await beads.reopen(project.repoPath, cardId);
          break;
        case "close":
          await beads.close(project.repoPath, cardId);
          break;
        case "tag":
          await beads.tag(project.repoPath, cardId, op.labels);
          break;
        case "untag":
          await beads.untag(project.repoPath, cardId, op.labels);
          break;
      }
    }
    return planned;
  });

  if (ops.length > 0) {
    // The label/status ops already landed locally; propagate without blocking the drag response.
    // nudgeSync fires the immediate push AND enqueues the durable sync-push backstop (anton-nowq).
    nudgeSync(project, "board-move");
  }
}
