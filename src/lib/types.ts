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
  prRef?: string; // bead external_ref, if any
}

export interface Epic {
  id: string;
  title: string;
  goal?: string; // parsed from the bead description "## Goal" section
  acceptance?: string;
  approved: boolean; // has the `approved` label
  stage: Stage;
  prRef?: string;
  tickets: Ticket[];
}

export interface Board {
  projectSlug: string;
  /** Epics grouped by stage. Orphan tickets are wrapped as single-ticket epics. */
  columns: Record<Stage, Epic[]>;
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
}
