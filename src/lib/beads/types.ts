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
  /**
   * Why a closed bead was closed (`bd close --reason`). Declared rather than left to the index
   * signature because it is read as a DISCRIMINATOR, not as prose: the settled-proposal record tells
   * a founder's verdict from a fold or an unattended apply by this string alone (gardener's
   * `isFoldReason` / `isPolicyApplyReason`), and a field typed `unknown` hides a bd that stops
   * carrying it behind a check that just silently answers "no".
   */
  close_reason?: string;
  external_ref?: string;
  /**
   * bd custom metadata (`bd update --set-metadata k=v`, read back as an object). anton's PR pointer
   * lives at `metadata.pr` so `external_ref` is freed for tracker integrations — always read/write it
   * through beads.getPrRef/setPrRef, never `metadata.pr` directly.
   */
  metadata?: { pr?: string; [k: string]: unknown };
  priority?: number;
  assignee?: string | null; // who claimed the bead; null/absent when unclaimed
  created_at?: string; // ISO timestamp
  created_by?: string | null; // who created the bead
  parent?: string; // parent epic id (present in `bd list --json` for structured boards)
  parent_id?: string;
  dependencies?: BeadDep[]; // edges carried inline by `bd list --json`
  dependency_type?: string; // set on beads returned by `bd dep list`
  /** Only ever populated by a read that ASKED for them — see `beads.showWithComments`. */
  comments?: BeadComment[];
  [k: string]: unknown;
}

/**
 * One entry of a bead's append-only comment thread. Distinct from the `notes` blob: comments are
 * individually timestamped and never edited, which is why the per-round review scores live here
 * (see lib/jobs/review-score.ts) and why the review report can be replayed off the board.
 */
export interface BeadComment {
  id?: string;
  issue_id?: string;
  author?: string;
  text: string;
  created_at?: string;
}

export interface BeadDep {
  issue_id: string; // the dependent
  depends_on_id: string; // what it depends on / is a child of
  type: string; // parent-child | blocks | related | discovered-from
}
