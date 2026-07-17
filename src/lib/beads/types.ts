/**
 * Leaf module for the shared beads value shapes. Kept dependency-free so both bd.ts (the bd CLI
 * wrapper) and snapshot.ts (its in-process cache) can import these without importing each other —
 * this is the module that breaks the bd ↔ snapshot import cycle (anton-mur).
 */

export interface Bead {
  id: string;
  title: string;
  status: string; // open | in_progress | blocked | closed | ...
  issue_type?: string; // epic | task | bug | ...
  description?: string;
  acceptance?: string;
  acceptance_criteria?: string; // the field bd show/dep return
  context?: string;
  labels?: string[];
  external_ref?: string;
  priority?: number;
  assignee?: string | null; // who claimed the bead; null/absent when unclaimed
  created_at?: string; // ISO timestamp
  created_by?: string | null; // who created the bead
  parent?: string; // parent epic id (present in `bd list --json` for structured boards)
  parent_id?: string;
  dependencies?: BeadDep[]; // edges carried inline by `bd list --json`
  dependency_type?: string; // set on beads returned by `bd dep list`
  [k: string]: unknown;
}

export interface BeadDep {
  issue_id: string; // the dependent
  depends_on_id: string; // what it depends on / is a child of
  type: string; // parent-child | blocks | related | discovered-from
}
