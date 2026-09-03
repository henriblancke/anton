/**
 * The `dep-missing` repair (anton-qg4h / R5.4) — the agent stopped because something else has to
 * land first, and nothing on the board said so. anton draws that edge, parks the target behind it,
 * and leaves the prerequisite free to be picked up.
 *
 * WHY THIS IS ON THE SAFE SIDE OF THE LINE. Recording an ordering that already exists in reality is
 * a board FACT, not a judgement: the work the agent needs either exists on the board or it does not,
 * and the edge only writes down which of the two runs first. Creating the missing work would be the
 * opposite — an invention — so it is out of scope by construction: every prerequisite is resolved
 * against a board read, and one that resolves to nothing escalates rather than being filed.
 *
 * WHAT IT REFUSES, and each refusal is one way "draw the edge" would be a guess or an error:
 *
 *   • prose that names NO bead this board holds — the agent named an artifact, not work;
 *   • prose that names SEVERAL — which one it is waiting on is not something the reason answers;
 *   • a prerequisite already CLOSED — it is not what stopped this run, and parking behind it would
 *     park forever;
 *   • an ordering the board ALREADY records — then the block is something else;
 *   • an edge bd would reject: a cycle, or a `discovered-from` edge already on the same directed
 *     pair (anton-wsap — bd holds one edge per pair and answers `bd link --type blocks` with
 *     "already exists with type discovered-from … remove it first"), which is why the pair is
 *     checked HERE rather than discovered as a write failure;
 *   • a parent/ancestor pair, which sequences through the hierarchy rather than through `blocks`.
 *
 * The loop guard is repair.ts's, unchanged: one repair per bead per class, and a second
 * `dep-missing` block on a bead anton already drew an edge for escalates (R5.6).
 */
import { beads, type Bead } from "../beads/bd";
import { indexBoard, isOpenWork, type BoardIndex } from "./board-index";
import {
  decideRepair,
  recordRepair,
  refusalNote as refusal,
  type RepairAttempt,
  type RepairedBead,
} from "./repair";

/** The class this module repairs. Named once so the guard, the stamp and the prose cannot drift. */
const KLASS = "dep-missing" as const;

/**
 * bd ids as they appear in prose (`anton-qg4h`, `anton-287p.1`). Deliberately loose — MEMBERSHIP in
 * the board decides what is real (see {@link resolvePrereq}), so the pattern only has to be wide
 * enough not to miss one. The dotted suffix is part of the id: bd mints child ids that carry it, and
 * a pattern that stopped at the dot would resolve `anton-287p.1` to its parent.
 */
const ID_PATTERN = /\b[a-z][a-z0-9]*-[a-z0-9]{2,12}(?:\.[a-z0-9]+)*\b/gi;

/**
 * Every bead id the agent's reason mentions, lower-cased and de-duplicated in the order written.
 *
 * Order matters only for how a refusal reports them; which one is the prerequisite is never decided
 * by position — a reason naming two ids is ambiguous, not "the first one".
 */
export function namedPrereqs(reason: string | undefined): string[] {
  if (!reason) return [];
  const seen = new Set<string>();
  for (const match of reason.matchAll(ID_PATTERN)) seen.add(match[0].toLowerCase());
  return [...seen];
}

/** What the board answers for the prerequisite the agent named. */
export type PrereqVerdict =
  | { state: "resolved"; id: string }
  | { state: "unresolved"; why: string };

/**
 * Resolve the prerequisite the agent named against the board, and refuse every reading that is not
 * exactly one open bead this edge can legally point at.
 *
 * All of it is read off the board, never off the reason's confidence: the prose is only how anton
 * learns WHICH bead to look for. That is the whole difference between recording an ordering and
 * inventing one.
 */
export function resolvePrereq(
  index: BoardIndex,
  targetId: string,
  reason: string | undefined,
): PrereqVerdict {
  const named = namedPrereqs(reason).filter((id) => id !== targetId);
  if (named.length === 0) {
    return {
      state: "unresolved",
      why: reason
        ? `the reason names no bead id anton can resolve ("${reason.trim()}") — anton records an ` +
          `ordering between beads that exist, it does not create the work`
        : `the agent named no prerequisite at all`,
    };
  }
  const onBoard = named.filter((id) => index.byId.has(id));
  if (onBoard.length === 0) {
    return {
      state: "unresolved",
      why:
        `${named.map((id) => `\`${id}\``).join(", ")} is named as the prerequisite but the board ` +
        `holds no such bead — the repair records ordering only, so there is nothing to point at`,
    };
  }
  if (onBoard.length > 1) {
    return {
      state: "unresolved",
      why:
        `the reason names ${onBoard.length} beads on the board ` +
        `(${onBoard.map((id) => `\`${id}\``).join(", ")}) — which one the work is waiting on is not ` +
        `something it answers, and anton will not pick one`,
    };
  }
  const id = onBoard[0]!;
  const prereq = index.byId.get(id)!;
  if (!isOpenWork(prereq)) {
    return {
      state: "unresolved",
      why:
        `\`${id}\` is named as the prerequisite but it is already settled (${prereq.status}) — it is ` +
        `not what stopped this run, and parking behind it would park for good`,
    };
  }
  if (index.recordsBlocker(targetId, id)) {
    return {
      state: "unresolved",
      why: `the board already records \`${id}\` as a blocker of ${targetId}, so this block is something else`,
    };
  }
  if (index.isBlockedBy(id, targetId)) {
    return {
      state: "unresolved",
      why:
        `\`${id}\` already waits on ${targetId}, directly or through other beads — the edge would ` +
        `close a dependency cycle, which bd rejects at every write path`,
    };
  }
  if (index.recordsDiscovery(targetId, id)) {
    return {
      state: "unresolved",
      why:
        `${targetId} is already recorded as discovered from \`${id}\`, and bd holds one edge per ` +
        `directed pair — it refuses a \`blocks\` edge over the provenance one (anton-wsap), so the ` +
        `ordering cannot be written without dropping how the work was found`,
    };
  }
  if (index.isAncestor(id, targetId) || index.isAncestor(targetId, id)) {
    return {
      state: "unresolved",
      why:
        `\`${id}\` and ${targetId} are on one parent chain — that pair sequences through the ` +
        `hierarchy, not through a \`blocks\` edge`,
    };
  }
  return { state: "resolved", id };
}

/**
 * What the repair decided.
 *
 * `parked` rather than `repaired` on purpose: the caller must NOT treat this like a `ref-stale`
 * rewrite. That one corrects the bead and earns a retry; this one records that the work cannot start
 * yet, so retrying it now would burn an attempt proving the edge anton just drew.
 */
export type DepMissingOutcome =
  | {
      action: "parked";
      /** The repair stamp written on the target. */
      label: string;
      /** The prerequisite the edge now points at. */
      blockerId: string;
      attempted: string;
    }
  | { action: "escalate"; why: string; evidence: string[]; prior?: RepairAttempt };

/**
 * Draw the edge, park the target, record the repair — or refuse.
 *
 * ORDER, and it is the opposite of `ref-stale`'s. There, staleness is checked before the loop guard
 * because the worktree is what establishes the class at all. Here the CLASS is the agent's own
 * classified report (`ANTON-RESULT: blocked — dep-missing — …`) and nothing about the bead asserts
 * it, so the guard is asked first: a bead anton already drew an edge for and which blocked this way
 * again is a diagnosis that has been disproved, and that answer costs no board read to give (R5.6).
 *
 * The WRITE order is the edge, then the stamp, then the note — and a stamp that fails takes the edge
 * back ({@link revertPrereqEdge}). Unlike a rewritten pointer, an edge is board state OTHER runs
 * read: an unrecorded one would hold work back with nothing on the board saying who drew it or why,
 * and no fingerprint to stop anton drawing it again. Better no edge and a human reading the block.
 */
export async function repairDepMissing(args: {
  /** Where bd writes go — the project's beads workspace. */
  repoPath: string;
  bead: RepairedBead;
  /** The block being repaired — its reason names the prerequisite and rides into the record. */
  block: { reason?: string };
  /** Unix milliseconds, stamped on the repair label so the breaker can order failures against it. */
  now: number;
  /**
   * The board the prerequisite is resolved against. Read fresh from bd when absent: the snapshot the
   * run dispatched from predates the session, and a prerequisite that closed meanwhile must not be
   * parked behind.
   */
  board?: Bead[];
}): Promise<DepMissingOutcome> {
  const { repoPath, bead, block, now } = args;
  const decision = decideRepair(bead, KLASS, block);
  if (decision.action === "escalate") return { ...decision };

  const board = args.board ?? (await beads.list(repoPath, ["--status", "all"]));
  const verdict = resolvePrereq(indexBoard(board), bead.id, block.reason);
  if (verdict.state === "unresolved") {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but anton could not resolve the prerequisite it names ` +
        `to a bead on the board — it records orderings, it does not create work, so this needs a human.`,
      evidence: [verdict.why],
    };
  }

  const blockerId = verdict.id;
  const attempted =
    `recorded \`${blockerId}\` as a blocker of ${bead.id} (bd link ${bead.id} ${blockerId} ` +
    `--type blocks), parking it until that lands — the agent reported: ` +
    `${block.reason?.trim() || "(no reason given)"}`;
  await beads.link(repoPath, bead.id, blockerId, "blocks");
  let label: string;
  try {
    label = await recordRepair(repoPath, bead, KLASS, attempted, now);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const reverted = await revertPrereqEdge(repoPath, bead.id, blockerId).then(
      () => true,
      () => false,
    );
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\` and anton could not record the repair, so it did not ` +
        `keep the edge — an ordering nothing on the board explains is worse than none.`,
      evidence: [
        `the \`blocks\` edge ${bead.id} → ${blockerId} could not be stamped (${detail})`,
        reverted
          ? `the edge was taken back, so the board is as it was`
          : `taking the edge back FAILED too — ${bead.id} is still recorded as blocked by ` +
            `${blockerId}; remove it with \`bd dep remove ${bead.id} ${blockerId}\` if that ordering is wrong`,
      ],
    };
  }
  return { action: "parked", label, blockerId, attempted };
}

/**
 * Take an anton-drawn ordering back — the undo that makes the edge reversible.
 *
 * The repair STAMP is deliberately left in place. It is the loop guard, and a reversal means the
 * ordering was wrong: dropping the stamp would let the next `dep-missing` block on that bead draw
 * the very edge someone just removed. The reversal is noted instead, so the bead carries both halves
 * of the story.
 */
export async function revertPrereqEdge(
  repoPath: string,
  targetId: string,
  blockerId: string,
  /** Why it was taken back. Noted on the target when given; omitted by the write-failure path,
   * whose note write is the thing that just failed. */
  why?: string,
): Promise<void> {
  await beads.unlink(repoPath, targetId, blockerId);
  if (why !== undefined) await beads.note(repoPath, targetId, reversalNote(blockerId, why));
}

/** The note a reversal leaves — one line, like every other machine note on the blob. */
export function reversalNote(blockerId: string, why: string): string {
  return `anton: removed the \`${KLASS}\` repair's blocks edge to ${blockerId} — ${why
    .replace(/\s+/g, " ")
    .trim()}`;
}

/**
 * The note anton leaves when it REFUSED a `dep-missing` repair — the class bound to the shared
 * formatter, so every repair's refusal reads the same way on a bead.
 */
export function refusalNote(outcome: Extract<DepMissingOutcome, { action: "escalate" }>): string {
  return refusal(KLASS, outcome);
}
