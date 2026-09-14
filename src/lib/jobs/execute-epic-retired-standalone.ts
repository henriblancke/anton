import { beads, type Bead } from "../beads/bd";
import { readCurrentClosureVersion } from "../beads/closure-cycle";
import { isServerMode } from "../beads/board-mode";
import { runTickets } from "../ticket-view";
import { priorRepair } from "../gardener/repair";
import { mustReadBoard } from "./execute-epic-persist";

/** Evidence that a standalone target remains the retirement anton verified. */
export interface VerifiedStandaloneRetirement {
  survivor: string;
  closure: string;
}

/**
 * Read the durable evidence for an already-shipped standalone retirement. The in-memory retirement
 * ledger is enough to identify the uninterrupted path, but only this evidence survives a retry.
 */
export async function readVerifiedStandaloneRetirement(
  repo: string,
  targetId: string,
  leaseTarget?: Bead,
): Promise<VerifiedStandaloneRetirement | undefined> {
  const candidate = leaseTarget ?? (await beads.show(repo, targetId).catch(() => undefined));
  if (!candidate) return undefined;
  const survivor = beads.supersededBy(candidate);
  if (!survivor) return undefined;
  const stamped = await beads.show(repo, targetId).catch(() => undefined);
  if (!stamped || beads.supersededBy(stamped) !== survivor) return undefined;
  const repair = priorRepair(stamped, "already-shipped");
  if (!repair?.closure || repair.survivor !== survivor) return undefined;
  const closure = await readCurrentClosureVersion(repo, targetId).catch(() => undefined);
  return closure === repair.closure ? { survivor, closure: repair.closure } : undefined;
}

/**
 * Re-read the complete board immediately around terminal settlement. Embedded boards must pull
 * first; otherwise another machine's child, reopen, or re-supersede is invisible to this fence.
 */
export async function verifiedStandaloneRetirementStillHeld(
  repo: string,
  targetId: string,
  retirement: VerifiedStandaloneRetirement,
): Promise<boolean> {
  if (!isServerMode(repo)) {
    try {
      await beads.pull(repo);
    } catch {
      return false;
    }
  }
  const current = await mustReadBoard(repo);
  const currentTarget = current?.find((bead) => bead.id === targetId);
  if (!current || !currentTarget || beads.groupsChildren(currentTarget, runTickets(current, targetId))) {
    return false;
  }
  if (
    currentTarget.status !== "closed" ||
    beads.supersededBy(currentTarget) !== retirement.survivor
  ) {
    return false;
  }
  const repair = priorRepair(currentTarget, "already-shipped");
  if (repair?.survivor !== retirement.survivor || repair.closure !== retirement.closure) {
    return false;
  }
  return (await readCurrentClosureVersion(repo, targetId).catch(() => undefined)) === retirement.closure;
}
