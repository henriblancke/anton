/**
 * Shared contract for the anton board slice. The API layer and the UI both build to this.
 * Stages/approval/PR are derived from beads (see DESIGN.md §2/§3), not stored in anton.db.
 */
import type { TicketNote } from "./beads/notes";

export type { TicketNote };

export type Stage = "backlog" | "implementing" | "in-review" | "done";
export const STAGES: Stage[] = ["backlog", "implementing", "in-review", "done"];

/** The board's shared type language. An epic renders as a card; a standalone task/bug as a chip.
 * Every other bead issue_type is not board work. */
export type IssueType = "epic" | "task" | "bug";

export interface Project {
  id: string;
  slug: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  hasBeads: boolean;
  createdAt: number; // unix seconds
}

export interface Ticket {
  id: string;
  title: string;
  status: string; // raw bead status
  stage: Stage;
  agent?: string; // from an agent:<x> label
  risk?: string; // from risk:<x>
  size?: string; // from size:<x>
  acceptance?: string;
  assignee: string | null; // who claimed the bead; null when unclaimed
  createdAt: string; // ISO timestamp, from the raw bead's created_at
  createdBy: string | null; // who created the bead
  prRef?: string; // bead external_ref, if any
  prUrl?: string; // browser URL for the PR, resolved from prRef + the repo's origin remote
  /** Snoozed (`bd defer`) — kept off the ready queue until a human restores it. */
  deferred: boolean;
  /** Abandoned (closed + `abandoned` label, anton-6xj0) — a won't-do outcome, never a delivery. */
  abandoned: boolean;
}

export interface Epic {
  id: string;
  title: string;
  goal?: string; // parsed from the bead description "## Goal" section
  acceptance?: string;
  approved: boolean; // has the `approved` label
  stage: Stage;
  agent?: string; // from an agent:<x> label on the epic bead
  risk?: string; // from risk:<x>
  size?: string; // from size:<x>
  assignee: string | null; // who claimed the epic bead; null when unclaimed
  createdAt: string; // ISO timestamp, from the raw bead's created_at
  createdBy: string | null; // who created the epic bead
  prRef?: string;
  prUrl?: string; // browser URL for the PR, resolved from prRef + the repo's origin remote
  // Epic→epic dependency rollup from computeEpicGraph (epic-graph.ts), attached in board.ts.
  blockedBy: string[]; // epic ids that currently block this epic (open blockers); empty when ready
  ready: boolean; // no open blockers — mirrors what the runtime's bd-ready would actually pick up
  rank: number; // topological rank (0 = no blockers); drives dependency-aware backlog order
  priority: number; // bead priority (0=critical … 4=lowest); backlog tiebreak after rank
  tickets: Ticket[];
}

/**
 * A parentless task/bug — an "epic-of-one" run target that renders on the board as a standalone
 * chip (not a fake epic card). Carries its real `issue_type` so the board's type language can tint
 * it, plus the approval/run state a chip needs. Built by toStandaloneItem (ticket-view.ts).
 */
export interface StandaloneItem {
  id: string;
  title: string;
  type: Exclude<IssueType, "epic">; // "task" | "bug" — a standalone item is never an epic
  status: string; // raw bead status
  stage: Stage;
  approved: boolean; // has the `approved` label — hides the Approve & run affordance once set
  agent?: string; // from an agent:<x> label
  risk?: string; // from risk:<x>
  size?: string; // from size:<x>
  assignee: string | null; // who claimed the bead; null when unclaimed
  createdAt: string; // ISO timestamp, from the raw bead's created_at
  createdBy: string | null; // who created the bead
  prRef?: string; // bead external_ref, if any
  prUrl?: string; // browser URL for the PR, resolved from prRef + the repo's origin remote
  // Open blockers from the standalone target's own `blocks` edges (standaloneBlockers), attached in
  // board.ts. A standalone item never appears in the epic-graph rollup, so its readiness is derived
  // directly — mirroring the epic card's blockedBy/ready so the chip can gate approval the same way.
  blockedBy: string[]; // blocker ids that currently block this item (open blockers); empty when ready
  ready: boolean; // no open blockers — mirrors what the approve route enforces
  /** A self-filed bug (source:<x> label) still untouched (backlog, unclaimed, not approved) — it
   * wants a human's triage before it runs. Derived each build; there is no stored read-state. */
  unread: boolean;
  /** Snoozed (`bd defer`) — kept off the ready queue until a human restores it. */
  deferred: boolean;
  /** Abandoned (closed + `abandoned` label, anton-6xj0) — a won't-do outcome, never a delivery. */
  abandoned: boolean;
}

/** Per-project beads↔Dolt sync health, read from the sync-status registry (bd.ts). Mirrors
 * SyncStatus there — kept as a separate declaration so client components import types without the
 * server-only bd module. */
export interface SyncStatusView {
  state: "unknown" | "not-wired" | "syncing" | "synced" | "failing";
  /** ms epoch of the last successful pass (pull or push); null when never synced. */
  lastSyncedAt: number | null;
  /** ms epoch of the last successful push; null when nothing has been pushed yet. */
  lastPushedAt: number | null;
  /** Local commits committed but not yet pushed to the remote; 0 when caught up. */
  unpushedCount: number;
  lastError: string | null;
}

export interface Board {
  projectSlug: string;
  /** Monotonic issue-snapshot version used for change-aware refreshes. */
  version: string;
  /** Epics grouped by stage — the board above the fold is epics-only. */
  columns: Record<Stage, Epic[]>;
  /** Standalone (parentless) tasks/bugs grouped by stage, rendered as chips at each column's foot. */
  standalone: Record<Stage, StandaloneItem[]>;
  /** Sync health for this project's beads workspace. */
  sync: SyncStatusView;
}

// ── Tickets page ──
export interface TicketRow extends Ticket {
  type: string; // bead issue_type
  domain?: string;
  epicId?: string;
  epicTitle?: string;
}
export interface TicketFilters {
  agent?: string;
  risk?: string;
  size?: string;
  domain?: string;
  status?: string;
  type?: string;
  epic?: string;
  q?: string; // free-text over title
}

// ── Ticket detail popup ──
export interface TicketDetail extends Ticket {
  type: string; // bead issue_type
  priority?: number; // 0-4 (0 = critical)
  domain?: string; // from domain:<x>
  goal?: string; // parsed from the bead description "## Goal" section
  description?: string; // the full bead description (markdown)
  epicId?: string; // parent epic id, if any
  epicTitle?: string;
  epicAssignee?: string | null; // the parent epic's human-claim owner, inherited by this child
  approved: boolean; // has the `approved` label — locks the standalone claim control (see ClaimControl)
  notes: TicketNote[]; // append-only note history (human steering + anton's own machine notes)
}

// ── Board drag-and-drop ──
export interface MoveRequest {
  toStage: Stage;
}

// ── Epic detail + dependency graph ──
export type DepType = "parent-child" | "blocks" | "related" | "discovered-from";
export interface DepEdge {
  from: string;
  to: string;
  type: DepType;
}
export interface EpicDetail {
  epic: Epic;
  description?: string; // the full bead description (markdown)
  tickets: Ticket[];
  edges: DepEdge[]; // among the epic + its tickets
  run?: EpicRun; // the currently-open run for this epic, if any (for "View run" / worktree)
}

/** The open (queued/running/parked) run backing an epic, surfaced on the epic detail. */
export interface EpicRun {
  id: string;
  status: string;
  worktreePath?: string;
}
