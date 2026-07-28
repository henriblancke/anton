/**
 * Board drag-and-drop: moving a card to a target Stage is a set of bead label/status ops.
 * `planMove` is pure (unit-testable); `moveCard` reads the bead then executes the plan via
 * the `beads` wrapper. See DESIGN.md §2/§3.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
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

export async function moveCard(project: Project, cardId: string, toStage: Stage): Promise<void> {
  const fromBead = await beads.show(project.repoPath, cardId);
  const ops = planMove(fromBead, toStage);

  for (const op of ops) {
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

  if (ops.length > 0) {
    // The label/status ops already landed locally; propagate without blocking the drag response.
    // nudgeSync fires the immediate push AND enqueues the durable sync-push backstop (anton-nowq).
    nudgeSync(project, "board-move");
  }
}
