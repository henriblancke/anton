/**
 * Shared contract for the anton board slice. The API layer and the UI both build to this.
 * Stages/approval/PR are derived from beads (see DESIGN.md §2/§3), not stored in anton.db.
 */

export type Stage = "backlog" | "implementing" | "in-review" | "done";
export const STAGES: Stage[] = ["backlog", "implementing", "in-review", "done"];

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
  tickets: Ticket[];
}

/** Per-project beads↔Dolt sync health, read from the sync-status registry (bd.ts). */
export interface SyncStatusView {
  state: "unknown" | "not-wired" | "syncing" | "synced" | "failing";
  /** ms epoch of the last successful pass; null when never synced. */
  lastSyncedAt: number | null;
  lastError: string | null;
}

export interface Board {
  projectSlug: string;
  /** Monotonic issue-snapshot version used for change-aware refreshes. */
  version: string;
  /** Epics grouped by stage. Orphan tickets are wrapped as single-ticket epics. */
  columns: Record<Stage, Epic[]>;
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
