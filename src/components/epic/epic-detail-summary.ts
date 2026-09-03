import type { ContractViolation, EpicDetail } from "@/lib/types";
// The predicate itself, not a page-local copy: approve, the runner, and the board card ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { ticketProgress, typeWord } from "@/components/board/board-utils";

export type AcceptanceItem = { text: string; checked: boolean };

/** Split an acceptance blob into checklist items, honoring `- [x]` / `- [ ]` markers. */
export function parseAcceptance(acceptance: string): AcceptanceItem[] {
  return acceptance
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), checked: m[1].toLowerCase() === "x" };
      return { text: line.replace(/^[-*]\s*/, ""), checked: false };
    });
}

/** Everything the detail page derives from one read, so its sections render off a settled shape. */
export interface EpicDetailSummary {
  done: number;
  total: number;
  pct: number;
  inProgress: number;
  inProgressPct: number;
  todo: number;
  abandoned: number;
  acceptance: AcceptanceItem[];
  /**
   * The bead's real type, lowercased. The page serves every run target, and a feature is the tier
   * anton runs — so the id line and the actions name it instead of calling everything an epic.
   */
  word: string;
  /**
   * Every run action posts to the approve route, which refuses a blocking contract gap on the target
   * or any open ticket under it (anton-j9zs). Gate the buttons on the same judgement the board card
   * uses, so the action reads as inert-and-explained rather than 422ing on click.
   */
  contractBlocked: boolean;
  blocking: ContractViolation[];
  /**
   * Rework acts on work a run has already produced and reviewed, so it is offered exactly once the
   * target has left backlog — that covers the run that parked on its own self-review (the case this
   * exists for) as well as one waiting at the merge gate. An abandoned target has no work to redo.
   */
  canRework: boolean;
}

export function summarizeEpicDetail({ epic, tickets }: EpicDetail): EpicDetailSummary {
  const { done, total, pct } = ticketProgress({ tickets });
  // Abandoned tickets leave every count, not just the denominator ticketProgress trims — mixing the
  // two populations would inflate inProgressPct and floor `todo` to zero.
  const inProgress = tickets.filter((t) => t.stage === "implementing" && !t.abandoned).length;

  return {
    done,
    total,
    pct,
    inProgress,
    inProgressPct: total === 0 ? 0 : Math.round((inProgress / total) * 100),
    todo: Math.max(0, total - done - inProgress),
    abandoned: tickets.filter((t) => t.abandoned).length,
    acceptance: epic.acceptance ? parseAcceptance(epic.acceptance) : [],
    word: typeWord(epic.type),
    contractBlocked: contractBlocks(epic.contract),
    blocking: epic.contract?.blocking ?? [],
    canRework: !epic.abandoned && epic.stage !== "backlog" && tickets.length > 0,
  };
}
