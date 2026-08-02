/**
 * The single source of truth for turning a raw bead into a board/tickets view model. Stage,
 * approval, agent/risk/size chips, and the created metadata are all *derived* here — never stored
 * (see DESIGN.md §2/§3). Every surface (board, tickets list, epic detail, ticket detail) maps
 * through these helpers so a new view field is added in exactly one place.
 *
 * This module deliberately imports nothing from board.ts/tickets.ts/epic-detail.ts/ticket-detail.ts,
 * so those modules can all consume it without reintroducing a board↔tickets import cycle.
 */
import { LABELS, beads, type Bead } from "./beads/bd";
import {
  acceptanceBody,
  contractStatusOf,
  goalBody,
  isPipelineArtifact,
  isTicketTier,
  type ContractStatus,
} from "./beads/contract";
import type { Epic, EpicCrumb, IssueType, Stage, StandaloneItem, Ticket } from "./types";

/** Derived stage for a bead: closed → done; an `in-review` label or PR ref → in-review; an
 * in-progress status or `implementing` label → implementing; otherwise backlog. The PR pointer is
 * read through the seam (metadata.pr), so a tracker URL in external_ref never reads as in-review. */
export function deriveStage(bead: Bead): Stage {
  if (bead.status === "closed") return "done";
  const labels = bead.labels ?? [];
  if (labels.includes("stage:in-review") || beads.getPrRef(bead)) return "in-review";
  if (bead.status === "in_progress" || labels.includes("stage:implementing")) {
    return "implementing";
  }
  return "backlog";
}

/** The value of a `prefix:<value>` label (e.g. `agent:nextjs` → `nextjs`), or undefined. */
export function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const label = labels?.find((l) => l.startsWith(`${prefix}:`));
  return label ? label.slice(prefix.length + 1) : undefined;
}

/** The claimed-by + created metadata carried straight off the raw bead, null-safe (an unclaimed
 * ticket has no assignee/created_by). Shared by every bead→view mapper. */
export function createdMeta(bead: Bead): {
  assignee: string | null;
  createdAt: string;
  createdBy: string | null;
} {
  return {
    assignee: bead.assignee ?? null,
    createdAt: bead.created_at ?? "",
    createdBy: bead.created_by ?? null,
  };
}

/**
 * The contract sections a view RENDERS, read with the validator's own reader (contract.ts's
 * `goalBody`/`acceptanceBody`) rather than a view-local regex. `bd list --json` carries every home
 * the contract lives in — the description and `acceptance_criteria`, whenever they are non-empty
 * (measured against bd 1.1.2) — so a list-fed view judges and renders the same bead the gate does,
 * no `bd show` hydration needed.
 *
 * The shared reader is the point: a view-local one that only accepted `##` left a `# Goal` bead
 * judged conformant by the gate and rendered blank on every card and detail view — the gate said
 * "fine" and the board showed nothing. Reading the whole BEAD, not just its description, is what
 * keeps that true per tier: an epic may state its outcome as `## Outcome`, which the gate accepts.
 */
export const parseGoal = (bead: Bead): string | undefined => goalBody(bead);

/** Read through the validator's own reader (`acceptanceBody`), so an epic that states its rubric as
 * `## Success Criteria` renders it, and an authored `--acceptance` field wins over a description
 * section still holding the formula's TODO prompt — the two homes the gate already weighs together. */
export const parseAcceptance = (bead: Bead): string | undefined => acceptanceBody(bead);

/** Map a bead to the shared Ticket view model (board cards, epic-detail children, etc.). */
export function toTicket(bead: Bead): Ticket {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    stage: deriveStage(bead),
    agent: labelValue(bead.labels, "agent"),
    risk: labelValue(bead.labels, "risk"),
    size: labelValue(bead.labels, "size"),
    acceptance: parseAcceptance(bead),
    ...createdMeta(bead),
    prRef: beads.getPrRef(bead),
    deferred: beads.isDeferred(bead),
    abandoned: beads.isAbandoned(bead),
  };
}

/**
 * A "self-filed" bug is one anton's own automation created — it carries a `source:<x>` label (e.g.
 * `source:stringer` from scan-triage). A self-filed bug that is still untouched — backlog, unclaimed,
 * not yet approved — is "unread": it wants a human's triage before it runs (auto-run of self-filed
 * bugs is deliberately out of scope). There is no stored read-state, so this is derived each build.
 */
export function isUnreadBug(bead: Bead): boolean {
  if (bead.issue_type !== "bug") return false;
  const selfFiled = (bead.labels ?? []).some((l) => l.startsWith("source:"));
  return selfFiled && deriveStage(bead) === "backlog" && !bead.assignee && !beads.isApproved(bead);
}

/** Map a parentless task/bug to the shared StandaloneItem view model (a board chip). Carries the
 * bead's real issue_type so the type language can tint it; approval + unread drive the chip UI.
 * `blockedBy` is the item's open blockers (standaloneBlockers, computed in board.ts) — the chip
 * gates its Approve & run affordance on `ready` the same way the epic card does. */
export function toStandaloneItem(bead: Bead, blockedBy: string[] = []): StandaloneItem {
  return {
    id: bead.id,
    title: bead.title,
    type: (bead.issue_type === "bug" ? "bug" : "task") as Exclude<IssueType, "epic">,
    status: bead.status,
    stage: deriveStage(bead),
    approved: beads.isApproved(bead),
    agent: labelValue(bead.labels, "agent"),
    risk: labelValue(bead.labels, "risk"),
    size: labelValue(bead.labels, "size"),
    ...createdMeta(bead),
    prRef: beads.getPrRef(bead),
    blockedBy,
    ready: blockedBy.length === 0,
    // Judged over the RUN, not the bead alone (runContractStatus, same as toEpic): a standalone
    // already in review dispatches no agent, so a legacy one missing Acceptance carries no gap —
    // the chip keeps offering the closed-PR Force run the approve gate permits on exactly it.
    contract: runContractStatus(bead, []),
    unread: isUnreadBug(bead),
    deferred: beads.isDeferred(bead),
    abandoned: beads.isAbandoned(bead),
  };
}

/**
 * The product epic directly above this bead. One hop, and only to an `epic`: a run target's parent
 * is its product outcome, while a working-layer bead's parent is another run target — which is
 * orientation an epic badge would misrepresent. Undefined when there is no such parent, so callers
 * render no crumb (and the board collects the card in its "No epic" lane) rather than an empty one.
 */
export function parentEpicOf(bead: Bead, all: Bead[]): EpicCrumb | undefined {
  const parentId = beads.parentOf(bead);
  if (!parentId) return undefined;
  const parent = all.find((b) => b.id === parentId);
  if (!parent || !beads.isEpic(parent)) return undefined;
  return { id: parent.id, title: parent.title, area: labelValue(parent.labels, "area") };
}

/**
 * A board CARD — a bead that owns a run and therefore gets its own column card: a `feature` (one
 * worktree, one PR) or a legacy `epic` with no feature children. A container epic is deliberately
 * NOT a card: it can't be approved or run (the approve/claim routes 422 it via the same
 * `isRunTarget` gate), so a card for it would advertise a run that never happens — it surfaces as
 * the epic badge/swimlane key instead. A parentless task/bug is a run target too, but the board
 * renders it as a standalone chip rather than a card.
 */
export function isBoardCard(bead: Bead, all: Bead[]): boolean {
  return (beads.isEpic(bead) || bead.issue_type === "feature") && beads.isRunTarget(bead, all);
}

export interface BoardCards {
  /** Every bead id that renders as a card. */
  ids: Set<string>;
  /** The card a working-layer bead rides on, or undefined when no ancestor is a card. */
  cardOf: (bead: Bead) => string | undefined;
}

/**
 * The board's card index, built once per board build: which beads are cards, and which card each
 * working-layer bead belongs to. `cardOf` walks the WHOLE parent chain to the nearest card
 * ancestor, so in a three-level tree (epic → feature → task) the task lands under its FEATURE —
 * the single hop it used to take attributed it to nothing and dropped it off the board entirely.
 * Returns undefined when no ancestor is a card (a task directly under a container epic — work no
 * run ships; it stays visible on the epic detail page and the Tickets list). Guards against a
 * malformed parent cycle.
 *
 * The walk STOPS at pipeline plumbing (anton-ve2r): a poured molecule's steps ride on that molecule,
 * whose gates bd sequences — so if the molecule root is parented under a feature, they are still not
 * that feature's tickets. Walking through it would dispatch a gated step in the feature's worktree
 * before its gate ever resolved, and would make the runner (which resolves cards over the raw list)
 * dispatch tickets the board (which filters plumbing out first) never showed.
 */
export function boardCards(all: Bead[]): BoardCards {
  const byId = new Map(all.map((b) => [b.id, b]));
  const ids = new Set(all.filter((b) => isBoardCard(b, all)).map((b) => b.id));
  return {
    ids,
    cardOf: (bead: Bead) => {
      const seen = new Set<string>([bead.id]);
      let parentId = beads.parentOf(bead);
      while (parentId && !seen.has(parentId)) {
        if (ids.has(parentId)) return parentId;
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (parent && isPipelineArtifact(parent)) return undefined;
        parentId = parent ? beads.parentOf(parent) : undefined;
      }
      return undefined;
    },
  };
}

/**
 * A working-layer bead: a ticket-tier type (task/bug/chore/feature — the contract's own
 * `isTicketTier`) that is not itself a card. These are the beads that ride on a run target as its
 * tickets, and the tier gate is what keeps dispatch and contract one taxonomy: an exempt-type
 * descendant (`learning`, a custom type) rides on NO run — dispatching it would hand an agent a
 * bead whose spec `contractGaps` never judges, and closing it on merge would retire an artifact that
 * was never work. A container epic falls out the same way (`epic` is not ticket tier); a
 * non-container epic and every feature are already cards.
 *
 * Pipeline plumbing (`molecule`/`gate`) is refused explicitly ahead of the tier gate (anton-ve2r),
 * so a gate parented ANYWHERE in a run target's subtree — `bd mol pour` hangs one off the molecule
 * root, and `bd gate create` can hang one off the gated bead — can never be dispatched, counted, or
 * rendered as one of that run's tickets.
 */
export function isRunTicket(bead: Bead, cards: BoardCards): boolean {
  return !cards.ids.has(bead.id) && !isPipelineArtifact(bead) && isTicketTier(bead);
}

/**
 * The tickets a run target actually contains: every working-layer DESCENDANT whose nearest card
 * ancestor is this target (boardCards.cardOf), in board order — not just its direct children.
 * Depth matters because bd nesting is arbitrary-depth: under `feature → task → subtask` the subtask
 * ships in the same worktree and the same PR as the task above it, so the board card, the detail
 * page and the run must all count it. A direct-children-only run would open and merge the feature's
 * PR while leaving the subtask open under a completed run target — stranded, with no run path left
 * to reach it. Descent stops at a nested card (it owns its own subtree and its own PR).
 *
 * Pure over a bead list, so every consumer — board, epic detail, execute-epic, merge finalization —
 * derives the same set from one read.
 */
export function runTickets(all: Bead[], targetId: string): Bead[] {
  const cards = boardCards(all);
  return all.filter((b) => isRunTicket(b, cards) && cards.cardOf(b) === targetId);
}

/**
 * Whether a run SKIPS this bead instead of dispatching an agent for it: it is closed (its work is
 * done), or — on a standalone run — it already carries `stage:in-review`, meaning its commit exists
 * and only the agent-free PR step is left. Nothing re-reads a skipped bead's spec, so no contract
 * gate may refuse on it: this is what keeps Force-run recovery of a closed/failed PR reachable on a
 * legacy standalone written before the contract. execute-epic, the approve route and the board card
 * all ask this one predicate so they can't disagree about what a run will actually dispatch.
 *
 * Optimistic on purpose. "Won't re-run" holds only while the commit is on THIS branch, which no
 * caller here can prove; the runner re-applies the gate in its ticket loop for the cross-machine
 * case where the commit is missing and the ticket really does run again.
 */
export function resumeSkipped(bead: Bead, standaloneRun: boolean): boolean {
  return (
    bead.status === "closed" ||
    (standaloneRun && (bead.labels?.includes(LABELS.stage("in-review")) ?? false))
  );
}

/**
 * The beads a run's contract is judged on: the target plus every ticket the run will actually
 * dispatch an agent for. The one set the approve route refuses on, the runner parks on, and the
 * card renders (approve/route.ts, execute-epic.ts, {@link runContractStatus}) — shared so the
 * three can't disagree about what a run reads.
 *
 * EMPTY when the run dispatches nothing, and that is the whole point. Force run on a target whose
 * PR was closed without merging recovers it by re-opening the PR (execute-epic step 5) and running
 * no agent — the standalone shape reaches that through `resumeSkipped(target, true)`, and a grouped
 * one reaches it here when every child is already closed. Gating either on a spec no agent will
 * read would strand exactly the recovery the runner supports, on precisely the legacy targets
 * (written before the contract) that need it.
 *
 * The grouped branch keeps the target alongside its open tickets: its criteria are the rubric the
 * run's self-review scores that work against, so a thin target degrades a run that IS dispatching.
 */
export function contractGatedBeads(target: Bead, children: Bead[]): Bead[] {
  if (!beads.groupsChildren(target, children)) {
    return resumeSkipped(target, true) ? [] : [target];
  }
  const open = children.filter((t) => !resumeSkipped(t, false));
  return open.length === 0 ? [] : [target, ...open];
}

/**
 * Every bead on a board the contract is actually gated on: {@link contractGatedBeads} rolled up over
 * every run target, deduped. The board-wide answer to "which specs can strand a run", for the
 * conformance report (`src/lib/beads/contract-report.ts`).
 *
 * Only run TARGETS seed the roll-up, which is the whole point. A container epic can't be approved or
 * run (`beads.isRunTarget` refuses it) and no feature's gate reads its parent, so faulting its
 * missing Success Criteria would report stranded work where the gate strands none — and the same for
 * every other judged-but-unreachable bead, such as a parentless chore. Beads a run skips (closed, or
 * a standalone already in review) drop out through `contractGatedBeads` for the same reason.
 *
 * Needs the WHOLE board, closed beads included: container-ness and the ticket roll-up are read off
 * the parent graph, and an epic whose only feature child is closed is still a container.
 */
export function contractGatedBoard(all: Bead[]): Bead[] {
  const cards = boardCards(all);
  const ticketsOf = new Map<string, Bead[]>();
  for (const bead of all) {
    const card = isRunTicket(bead, cards) ? cards.cardOf(bead) : undefined;
    if (!card) continue;
    const tickets = ticketsOf.get(card);
    if (tickets) tickets.push(bead);
    else ticketsOf.set(card, [bead]);
  }

  const gated = new Map<string, Bead>();
  for (const target of all) {
    if (!beads.isRunTarget(target, all)) continue;
    for (const bead of contractGatedBeads(target, ticketsOf.get(target.id) ?? [])) {
      gated.set(bead.id, bead);
    }
  }
  return [...gated.values()];
}

/** A child's gaps, named with its id — the card's own bead isn't the one missing the section. */
const attributeTo = (id: string, status: ContractStatus): ContractStatus => {
  const name = (v: ContractStatus["blocking"][number]) => ({ ...v, message: `${id} → ${v.message}` });
  return { blocking: status.blocking.map(name), advisory: status.advisory.map(name) };
};

/**
 * The contract status a RUN TARGET carries: its own gaps plus those of every open ticket its run
 * would dispatch — the SAME set the approve route refuses on and the runner parks on
 * (approve/route.ts, execute-epic.ts). Judging the target alone let a feature with Acceptance and
 * one unshaped open child render no marker and keep Approve enabled, then 422 on click.
 *
 * The set comes from {@link contractGatedBeads}, so the card can't advertise (or withhold) an
 * action the gates behind it would decide differently. A run that dispatches nothing — a standalone
 * target already in review, a grouped one whose children are all closed — carries no gaps at all:
 * its commit is on the branch and only the PR step is left, so a card that surfaced a gap there
 * would withhold exactly the closed-PR recovery the gates allow.
 * Undefined only when NOTHING in the set was judged (no bd read behind any of it) — "not judged" is
 * not conformance.
 */
export function runContractStatus(target: Bead, children: Bead[]): ContractStatus | undefined {
  const gated = contractGatedBeads(target, children);
  if (gated.length === 0) return { blocking: [], advisory: [] };
  const statuses: ContractStatus[] = [];
  for (const bead of gated) {
    const status = contractStatusOf(bead);
    if (!status) continue;
    statuses.push(bead.id === target.id ? status : attributeTo(bead.id, status));
  }
  if (statuses.length === 0) return undefined;
  return {
    blocking: statuses.flatMap((s) => s.blocking),
    advisory: statuses.flatMap((s) => s.advisory),
  };
}

export interface ToEpicOptions {
  /** The epic's tickets, already mapped (an orphan/pseudo-epic passes `[toTicket(bead)]`). */
  tickets: Ticket[];
  /**
   * The raw child beads behind `tickets`, so the card's contract status covers the whole run (see
   * {@link runContractStatus}). Omitted by callers that hold only the target — the status then
   * reports the target's own gaps, as it did before.
   */
  children?: Bead[];
  /** Parsed "## Goal" text, if the caller has the bead's description. */
  goal?: string;
  /** Parsed "## Acceptance" text, if available. */
  acceptance?: string;
  /**
   * Carry the epic's own agent/risk/size chips off its labels. The board card, the board's
   * single-ticket pseudo-epic, and the epic-detail header all show them. Defaults to true; kept as
   * an opt-out for any surface that renders agent/risk/size elsewhere (e.g. per-ticket in a graph).
   */
  chips?: boolean;
  /**
   * Carry the PR ref off the seam (metadata.pr). board.ts's single-ticket pseudo-epic omits it (the
   * wrapped ticket already carries its own PR link). Defaults to true.
   */
  prRef?: boolean;
  /** Epic ids that currently block this epic, from computeEpicGraph. Defaults to none. */
  blockedBy?: string[];
  /** No open blockers. Defaults to ready (true) when the caller has no graph (e.g. epic-detail). */
  ready?: boolean;
  /** Topological rank from the epic graph (0 = no blockers). Defaults to 0. */
  rank?: number;
  /** The product epic above this run target (parentEpicOf), for the swimlane grouping. */
  epic?: EpicCrumb;
}

/** Missing bead priority sorts after every explicit priority (bd uses 0=critical … 4=lowest). */
const DEFAULT_PRIORITY = 4;

const ISSUE_TYPES = new Set<string>(["epic", "feature", "task", "bug", "chore"]);

/** The bead's work type, narrowed to the types the UI has language for. A bead with a missing or
 * unknown type falls back to `epic` — the pre-tier default every card was rendered as. */
export function issueTypeOf(bead: Bead): IssueType {
  const type = bead.issue_type ?? "";
  return ISSUE_TYPES.has(type) ? (type as IssueType) : "epic";
}

/** Map a bead to the shared Epic view model. `approved` and the chips/prRef are derived from the
 * bead; goal/acceptance are passed in because their source (the lite list bead vs. a `bd show`
 * fetch) differs per caller. */
export function toEpic(bead: Bead, opts: ToEpicOptions): Epic {
  const withChips = opts.chips ?? true;
  const withPrRef = opts.prRef ?? true;
  return {
    id: bead.id,
    title: bead.title,
    type: issueTypeOf(bead),
    goal: opts.goal,
    acceptance: opts.acceptance,
    approved: beads.isApproved(bead),
    stage: deriveStage(bead),
    ...(withChips
      ? {
          agent: labelValue(bead.labels, "agent"),
          risk: labelValue(bead.labels, "risk"),
          size: labelValue(bead.labels, "size"),
        }
      : {}),
    ...createdMeta(bead),
    ...(withPrRef ? { prRef: beads.getPrRef(bead) } : {}),
    blockedBy: opts.blockedBy ?? [],
    ready: opts.ready ?? true,
    // Derived here, not passed in: contract conformance is a pure read of the beads, so every
    // surface that maps a run target gets the same judgement the approve route and the runner apply
    // — over the same set, target plus open tickets, not the target alone.
    contract: runContractStatus(bead, opts.children ?? []),
    rank: opts.rank ?? 0,
    priority: bead.priority ?? DEFAULT_PRIORITY,
    abandoned: beads.isAbandoned(bead),
    ...(opts.epic ? { epic: opts.epic } : {}),
    tickets: opts.tickets,
  };
}
