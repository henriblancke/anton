/**
 * The single source of truth for turning a raw bead into a board/tickets view model. Stage,
 * approval, agent/risk/size chips, and the created metadata are all *derived* here — never stored
 * (see DESIGN.md §2/§3). Every surface (board, tickets list, epic detail, ticket detail) maps
 * through these helpers so a new view field is added in exactly one place.
 *
 * This module deliberately imports nothing from board.ts/tickets.ts/epic-detail.ts/ticket-detail.ts,
 * so those modules can all consume it without reintroducing a board↔tickets import cycle.
 */
import { beads, type Bead } from "./beads/bd";
import type { Epic, IssueType, Stage, StandaloneItem, Ticket } from "./types";

/** Derived stage for a bead: closed → done; an `in-review` label or PR ref → in-review; an
 * in-progress status or `implementing` label → implementing; otherwise backlog. */
export function deriveStage(bead: Bead): Stage {
  if (bead.status === "closed") return "done";
  const labels = bead.labels ?? [];
  if (labels.includes("stage:in-review") || bead.external_ref) return "in-review";
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

/** Extract a "## <name>" section from a bead description. `bd list --json` returns the
 * description but not the acceptance/context fields, so views read the contract here. */
function parseSection(description: string | undefined, name: string): string | undefined {
  if (!description) return undefined;
  const lines = description.split("\n");
  const re = new RegExp(`^##\\s*${name}\\b`, "i");
  const startIdx = lines.findIndex((l) => re.test(l.trim()));
  if (startIdx === -1) return undefined;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^##\s+/.test(l.trim()));
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
  const text = body.join("\n").trim();
  return text || undefined;
}

export const parseGoal = (d: string | undefined): string | undefined => parseSection(d, "Goal");

export const parseAcceptance = (bead: Bead): string | undefined =>
  parseSection(bead.description, "Acceptance") ?? bead.acceptance_criteria ?? bead.acceptance;

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
    prRef: bead.external_ref,
    deferred: beads.isDeferred(bead),
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
    prRef: bead.external_ref,
    blockedBy,
    ready: blockedBy.length === 0,
    unread: isUnreadBug(bead),
    deferred: beads.isDeferred(bead),
  };
}

export interface ToEpicOptions {
  /** The epic's tickets, already mapped (an orphan/pseudo-epic passes `[toTicket(bead)]`). */
  tickets: Ticket[];
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
   * Carry the PR ref off `external_ref`. board.ts's single-ticket pseudo-epic omits it (the
   * wrapped ticket already carries its own PR link). Defaults to true.
   */
  prRef?: boolean;
  /** Epic ids that currently block this epic, from computeEpicGraph. Defaults to none. */
  blockedBy?: string[];
  /** No open blockers. Defaults to ready (true) when the caller has no graph (e.g. epic-detail). */
  ready?: boolean;
  /** Topological rank from the epic graph (0 = no blockers). Defaults to 0. */
  rank?: number;
}

/** Missing bead priority sorts after every explicit priority (bd uses 0=critical … 4=lowest). */
const DEFAULT_PRIORITY = 4;

/** Map a bead to the shared Epic view model. `approved` and the chips/prRef are derived from the
 * bead; goal/acceptance are passed in because their source (the lite list bead vs. a `bd show`
 * fetch) differs per caller. */
export function toEpic(bead: Bead, opts: ToEpicOptions): Epic {
  const withChips = opts.chips ?? true;
  const withPrRef = opts.prRef ?? true;
  return {
    id: bead.id,
    title: bead.title,
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
    ...(withPrRef ? { prRef: bead.external_ref } : {}),
    blockedBy: opts.blockedBy ?? [],
    ready: opts.ready ?? true,
    rank: opts.rank ?? 0,
    priority: bead.priority ?? DEFAULT_PRIORITY,
    tickets: opts.tickets,
  };
}
