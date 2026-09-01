/**
 * Shared contract for the anton board slice. The API layer and the UI both build to this.
 * Stages/approval/PR are derived from beads (see DESIGN.md §2/§3), not stored in anton.db.
 */
import type { ContractStatus } from "./beads/contract";
import type { ChildReadiness } from "./epic-graph";
import type { TicketNote } from "./beads/notes";
import type { HygieneReport } from "./hygiene";
import type { ReviewTrajectory } from "./review-trajectory";
import type { ScanHealth } from "./scan-health";

export type { TicketNote };

// The bead contract, re-exported so client surfaces read its shape without importing the validator
// module itself. Type-only, so nothing of lib/beads reaches the browser bundle.
export type { ContractSeverity, ContractStatus, ContractViolation } from "./beads/contract";

// The gardener's report shape, re-exported for the same reason: the board panel renders it, and a
// value import of lib/hygiene would drag drizzle + better-sqlite3 into the browser bundle.
export type {
  HygieneActions,
  HygieneCounts,
  HygieneFinding,
  HygieneFindingKind,
  HygieneReport,
} from "./hygiene";

// The stringer health series' shapes, re-exported type-only for the same reason as hygiene above:
// the trend panel renders them, and a value import of lib/scan-health would drag drizzle +
// better-sqlite3 into the browser bundle.
export type {
  ClassCounts,
  ScanDelta,
  ScanHealth,
  ScanHealthPoint,
  SeverityCounts,
  TriageOutcome,
} from "./scan-health";
export type { ScanSeverity, SignalClass } from "./scan-severity";

// An open escalation and the stall class it was raised from, re-exported for the same reason: the
// attention strip is a client component (it rides the board poll alongside hygiene), and both
// lib/escalations and lib/run-health reach the database.
export type {
  EscalationKind,
  EscalationResolution,
  EscalationStatus,
  EscalationView,
} from "./escalations";
export type { RunHealthFindingKind } from "./run-health";

// The rollup's per-run-target child readiness, re-exported type-only for the same reason: the board
// card renders the verdict, and a value import of lib/epic-graph would drag lib/beads into the
// browser bundle.
export type { ChildReadiness } from "./epic-graph";

export type Stage = "backlog" | "implementing" | "in-review" | "done";
export const STAGES: Stage[] = ["backlog", "implementing", "in-review", "done"];

/**
 * Cap on an abandon reason (anton-6xj0). It is a sentence explaining a decision, not a document —
 * anything longer belongs in a note on the bead. Lives here, not in lib/abandon.ts, so the client
 * form can bound the input without pulling the server-only abandon module into the browser bundle;
 * the server still enforces it.
 */
export const MAX_ABANDON_REASON_CHARS = 500;

// The self-review's own shapes, re-exported type-only for the same reason as the contract above:
// the rework dialog renders findings and score rounds, and a value import of lib/jobs would drag
// the whole job runtime into the browser bundle.
export type { ReviewFinding } from "./jobs/review-context";
export type { ReviewReport, ReviewReportRound } from "./review-report";
export type { ReviewTrajectory, ScoredTarget } from "./review-trajectory";

/**
 * Which way a ticket is sent back (anton-4ocm). `reopen` says the acceptance was never actually met
 * — the same bead runs again, carrying a reason. `follow-up` says it WAS met and the founder wants
 * another pass: a new bead, linked `discovered-from` the original, so the score the first round
 * earned stays attached to the work that earned it.
 */
export type ReworkMode = "reopen" | "follow-up";

/**
 * Caps on a rework's two text fields. The summary becomes a `bd reopen --reason` / a follow-up
 * bead's title, so it is a line; the instructions are inlined verbatim into the implementer's
 * prompt, so an unbounded one is an unbounded prompt (the same reasoning as MAX_NOTE_CHARS). Here,
 * not in lib/rework.ts, so the client form can bound the inputs without pulling the server-only
 * module into the browser bundle; the server still enforces both.
 */
export const MAX_REWORK_SUMMARY_CHARS = 200;
export const MAX_REWORK_INSTRUCTIONS_CHARS = 2000;

/**
 * What a send-back had to do about the target's ALREADY-OPENED pull request (anton-leit). A run
 * target whose PR is live finishes as already-complete on its next attempt (execute-epic's step 0a
 * short-circuit), so without one of these two moves the reworked bead would sit open forever with no
 * run path back. Absent when nothing stood in the way — no PR, one that was closed unmerged (the
 * state a recovery run already re-opens), or a follow-up that came out as its own run target and so
 * never waits on the target's PR at all.
 */
export interface ReworkPipeline {
  /**
   * `retired` — the PR is still OPEN, so the target's finished-run marker was cleared and the target
   * re-runs: the next run picks up on the same branch and updates that same PR.
   * `shipped` — the PR MERGED, so the work is on the base branch and can't be un-shipped. The
   * send-back became its OWN run target instead of re-running the merged one.
   */
  outcome: "retired" | "shipped";
  /** The pull request that decided it. */
  pr: string;
  /** True when a requested `reopen` became a standalone follow-up because the PR had already merged. */
  redirected: boolean;
}

/** What a rework settled — the bead that will re-run, and whether this request is what created it. */
export interface ReworkResult {
  /**
   * How the send-back actually landed. It is the requested {@link ReworkMode} except after a MERGE,
   * where a `reopen` becomes a `follow-up` — see {@link ReworkPipeline}.
   */
  mode: ReworkMode;
  /** The ticket the founder sent back. */
  ticketId: string;
  /** The bead that re-enters the pipeline: the ticket itself, or the follow-up that was created. */
  reworkedId: string;
  /** The instruction note, as it landed on the bead. */
  note: string;
  /**
   * False when this request found its own work already done — a double-submit. Nothing was written
   * the second time, and `reworkedId` still names the bead the first one produced.
   */
  applied: boolean;
  /** What was done about the target's already-opened PR so this send-back can actually run. */
  pipeline?: ReworkPipeline;
}

/** The board's shared type language — the three tiers of
 * docs/design/2026-07-26-tier-and-linear-ux.md: an `epic` is a product outcome spanning features,
 * a `feature` is the shippable delivery unit anton runs, and `task`/`bug`/`chore` are the working
 * layer executed as part of their run target's run. Every other bead issue_type is not board work. */
export type IssueType = "epic" | "feature" | "task" | "bug" | "chore";

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
  /**
   * The card's real work type — `feature` for the tier anton now runs, `epic` for a legacy run
   * target or a product epic, `task`/`bug` for a leaf target rendered as an epic-of-one. The card
   * and the detail header read their icon, badge and wording off this, so a feature is never
   * presented as an epic (docs/design/2026-07-26-tier-and-linear-ux.md).
   */
  type: IssueType;
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
  /**
   * How much of this run's work can actually start now (anton-nywj). `blockedBy`/`ready` above roll
   * every child's block up to the target, so they can't tell "one gated tail child" from "nothing
   * can run" — a target whose other tickets are independent reads fully blocked there while the
   * executor would happily dispatch them (issue #58). This is the verdict the board and approve
   * gate on. Falls back to the coarse `ready` flag on a surface built without the rollup.
   */
  childReadiness: ChildReadiness;
  /** Ticket ids the run can dispatch now — the N of the card's "N/M ready". Empty without the rollup. */
  readyChildren: string[];
  /** Ticket ids an open blocker outside this run holds — the rest of that M. */
  blockedChildren: string[];
  /**
   * How this card's bead measures against the bead contract, from the SAME validator approve and the
   * runner judge with (lib/beads/contract.ts) — so the board can never advertise as approvable a bead
   * approval will refuse. Absent means "never judged" (an item built from no bd read), which a
   * surface must not render as conformant.
   */
  contract?: ContractStatus;
  rank: number; // topological rank (0 = no blockers); drives dependency-aware backlog order
  priority: number; // bead priority (0=critical … 4=lowest); backlog tiebreak after rank
  /**
   * The latest self-review score off the card's `review-score:<n>` label (anton-tprv). ABSENT means
   * never reviewed, which no surface may render as 0 — see `reviewScoreOf`.
   */
  reviewScore?: number;
  /** Abandoned (closed + `abandoned` label, anton-6xj0) — a won't-do outcome, never a delivery. */
  abandoned: boolean;
  /**
   * The operator VETOED this pick and anton is holding it until this instant (epoch ms, anton-jqvy).
   * Machine-local pacing on anton's own queue — distinct from bd's `deferred` STATUS, which is shared
   * board state a human has to undo. Absent means nothing is holding it.
   *
   * On the card rather than only in the recorded plan because a vetoed target must read as SET ASIDE
   * rather than as gone: a card that silently stopped being offered would leave the operator
   * wondering what they broke.
   */
  notNowUntil?: number;
  /**
   * Who put this card where it is, and why (anton-cqxd) — one entry per unattended writer that
   * touched it. Empty/absent means nothing automated claims this bead. Never carried on a DONE card:
   * provenance answers "should this run?", which a shipped target no longer asks.
   */
  provenance?: BeadProvenance[];
  /**
   * The product epic this card sits under, when its parent is an `epic` bead — the grouping key for
   * the board's epic swimlanes (docs/design/2026-07-26-tier-and-linear-ux.md). Absent for a
   * top-level run target, which collects in the "No epic" lane.
   */
  epic?: EpicCrumb;
  tickets: Ticket[];
}

/**
 * WHICH unattended writer put a bead where it is, and what to read to check the judgment
 * (anton-cqxd / R3.7).
 *
 * ONE grammar for every writer, because there are three of them and they all write to the board with
 * nobody watching: the board-picker admits a target under the standing policy, the product master
 * proposes a move on it, and the repair passes rewrite one that came back blocked. Three bespoke
 * indicators would make the board unreadable — the badge is always `◈ <writer>`, and what differs is
 * the word and where it lands.
 *
 * `repaired` is RESERVED, not rendered: the kind exists so the repair passes extend this grammar
 * instead of inventing a second one, and a surface renders nothing for a kind it has no wording for
 * (see `provenance-badge.tsx`).
 */
export type ProvenanceKind = "policy" | "pm" | "repaired";

export interface BeadProvenance {
  kind: ProvenanceKind;
  /**
   * What the badge opens — a policy criterion key for `policy`, the proposal's bead id for `pm`.
   * Absent is a real answer: a project whose policy narrows nothing this bead satisfies has no
   * criterion to open at, and the badge falls back to the panel rather than to a broken link.
   */
  ref?: string;
  /** What that writer decided, in its own words — the badge's tooltip, never its label. */
  detail?: string;
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
  /** Contract conformance from the shared validator, exactly as on an epic card (see Epic.contract). */
  contract?: ContractStatus;
  /** Latest self-review score, exactly as on an epic card — absent when never reviewed (Epic.reviewScore). */
  reviewScore?: number;
  /** A self-filed bug (source:<x> label) still untouched (backlog, unclaimed, not approved) — it
   * wants a human's triage before it runs. Derived each build; there is no stored read-state. */
  unread: boolean;
  /** Snoozed (`bd defer`) — kept off the ready queue until a human restores it. */
  deferred: boolean;
  /** Abandoned (closed + `abandoned` label, anton-6xj0) — a won't-do outcome, never a delivery. */
  abandoned: boolean;
  /** Held out of the picker's plan by an operator veto, exactly as on a card (Epic.notNowUntil). */
  notNowUntil?: number;
  /** Who put this chip where it is, exactly as on a card (Epic.provenance). */
  provenance?: BeadProvenance[];
}

/**
 * One target in the board-picker's recorded plan, as the Up Next lane reads it (anton-t9m4 / R3.1).
 *
 * The plan is this machine's projection over Backlog, never a bead state — so an entry carries the
 * ranking's own facts (where it stood, what it frees) rather than pointing at a stage. `priority`
 * and `type` ride along because the lane heads BOTH card kinds with one meta row, and a standalone
 * chip carries no priority of its own.
 */
export interface UpNextEntry {
  beadId: string;
  /** 1-based position in the ranked plan. */
  rank: number;
  /** bd priority (0=critical … 4=lowest); absent when the bead carries none. */
  priority?: number;
  type: IssueType;
  /** How many still-waiting beads finishing this target transitively unblocks (beads/rank.ts). */
  unblocks: number;
}

/** Per-project beads↔Dolt sync health, read from the sync-status registry (bd.ts). Mirrors
 * SyncStatus there — kept as a separate declaration so client components import types without the
 * server-only bd module. */
export interface SyncStatusView {
  state:
    | "unknown"
    | "not-wired"
    | "syncing"
    | "stalled"
    | "synced"
    | "failing"
    | "shared-server";
  /** ms epoch of the last successful pass (pull or push); null when never synced. */
  lastSyncedAt: number | null;
  /** ms epoch of the last successful push; null when nothing has been pushed yet. */
  lastPushedAt: number | null;
  /** Local commits committed but not yet pushed to the remote; 0 when caught up. */
  unpushedCount: number;
  lastError: string | null;
  /** How long a pass has been pinned at `syncing` past the staleness window; null unless stalled. */
  stalledForMs: number | null;
}

export interface Board {
  projectSlug: string;
  /** Monotonic issue-snapshot version used for change-aware refreshes. */
  version: string;
  /** Epics grouped by stage — the board above the fold is epics-only. */
  columns: Record<Stage, Epic[]>;
  /** Standalone (parentless) tasks/bugs grouped by stage, rendered as chips at each column's foot. */
  standalone: Record<Stage, StandaloneItem[]>;
  /**
   * The board-picker's recorded plan, ranked (anton-t9m4 / R3.1–R3.4) — the Up Next lane's whole
   * input. The lane resolves each entry against the BACKLOG column and takes those cards out of it,
   * so a bead never renders twice.
   *
   * ABSENT, never empty, whenever there is no projection to show: the picker is disarmed for this
   * project, or it has never run here. An empty lane titled "Up Next" would read as "anton has
   * nothing to start" on a board where the pass simply isn't running.
   */
  upNext?: UpNextEntry[];
  /** Sync health for this project's beads workspace. */
  sync: SyncStatusView;
  /**
   * The latest gardener patrol report (anton-uwal) — absent until a project's first patrol, which
   * is a different claim from "patrolled, board is clean" (an empty report). Rides in the board
   * payload so it refreshes on the same 304-friendly poll as the cards.
   */
  hygiene?: HygieneReport;
  /**
   * How this project's recent runs have been scoring (anton-tprv) — derived from the same labels
   * the cards carry, so it costs no read of its own. Absent until something has actually been
   * reviewed: an un-scored project shows no panel rather than a zero trend.
   */
  reviewTrajectory?: ReviewTrajectory;
  /**
   * How this project's codebase health has been trending (anton-bz1w) — one point per nightly
   * stringer pass. Absent until the first scan: "never scanned" is not "scanned, nothing found",
   * and only the second is news.
   */
  scanHealth?: ScanHealth;
}

// ── Roadmap page ──
/**
 * One product epic on the roadmap — the epic tier's own view, built server-side by buildRoadmap
 * (lib/roadmap.ts). Deliberately thin: the roadmap is read, not operated, so a row carries only
 * what its five columns show (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export interface RoadmapRow {
  id: string;
  title: string;
  /** The epic's `area:` designator — what Linear project routing keys on. Absent means the epic
   * can't be routed, which the row says out loud rather than failing silently at push time. */
  area?: string;
  /** bd priority, 0=critical … 4=backlog. Defaulted, never undefined, so the column and the sort
   * agree — an epic with no explicit priority reads (and orders) as P4. */
  priority: number;
  /** `feature` children, excluding abandoned ones. */
  features: number;
  /** How many of those features shipped. */
  shipped: number;
  /** The tracker ref bd's Linear sync wrote to `external_ref` — displayed, never fetched. */
  linearRef?: string;
}

// ── Tickets page ──
export interface TicketRow extends Ticket {
  type: string; // bead issue_type
  domain?: string;
  /** Nearest `epic` ancestor — the product outcome this row rolls up to. */
  epicId?: string;
  epicTitle?: string;
  /** Nearest `feature` ancestor — the run target whose worktree/PR this row ships in. */
  featureId?: string;
  featureTitle?: string;
}
export interface TicketFilters {
  agent?: string;
  risk?: string;
  size?: string;
  domain?: string;
  status?: string;
  type?: string;
  epic?: string;
  /** Abandoned work: "active" hides it, "abandoned" shows only it; unset shows everything. */
  outcome?: string;
  /** Tier placement: "unassigned" shows only work detached from the tier above it (see
   * `isUnassigned`), "assigned" only work that is attached; unset shows everything. */
  assigned?: string;
  q?: string; // free-text over title
}

/**
 * Every ticket filter, in one place. The tickets page, its API route, and the filter toolbar all
 * read this list — they used to each keep their own copy, and `outcome` was silently dropped by two
 * of the three, leaving the Outcome select wired to nothing.
 */
export const TICKET_FILTER_KEYS: (keyof TicketFilters)[] = [
  "agent",
  "risk",
  "size",
  "domain",
  "status",
  "type",
  "epic",
  "outcome",
  "assigned",
  "q",
];

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
  /** Contract status over the bead's own run (runContractStatus, same as the standalone chip), so
   * the dialog's Run affordance agrees with the approve gate instead of 422ing on click. */
  contract?: ContractStatus;
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
  /**
   * The product epic this run target sits under — the breadcrumb's one hop of orientation
   * (docs/design/2026-07-26-tier-and-linear-ux.md). Absent for a parentless run target, which
   * renders no crumb at all rather than an empty one.
   */
  parentEpic?: EpicCrumb;
}

/** Just enough of the parent epic to render (and link) its badge. */
export interface EpicCrumb {
  id: string;
  title: string;
  /** The epic's `area:` designator — the board's Area filter groups badges by it. Absent on an epic
   * that hasn't been designated yet (.product/decisions/2026-07-26-engine-designator-prefix.md). */
  area?: string;
}

/** The open (queued/running/parked) run backing an epic, surfaced on the epic detail. */
export interface EpicRun {
  id: string;
  status: string;
  worktreePath?: string;
}
