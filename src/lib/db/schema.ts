/**
 * anton.db — ephemeral, machine-local execution state (git-ignored, disposable).
 * The shareable truth (epics/tickets, approval, stage, PR link) lives in beads — a Dolt DB
 * synced via refs/dolt/data on the git remote (.beads/*.jsonl is only a passive local export).
 * See DESIGN.md §3.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp" });
const now = sql`(unixepoch())`;

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  settingsJson: text("settings_json").notNull().default("{}"),
  createdAt: ts("created_at").notNull().default(now),
});

/** A unit of autonomous work in flight. Stage + PR live in beads; this is local plumbing. */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  epicBeadId: text("epic_bead_id").notNull(),
  ticketBeadId: text("ticket_bead_id"),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  model: text("model"),
  agentTag: text("agent_tag"),
  // queued | running | parked | done | failed
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  leaseExpiresAt: ts("lease_expires_at"),
  error: text("error"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  updatedAt: ts("updated_at").notNull().default(now),
});

/** Durable job queue. Idempotent; resumable via leases + backoff. See DESIGN.md §4. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    // execute-epic | review-fix | nightly-stringer | orphan-grooming | sync-push
    type: text("type").notNull(),
    projectId: text("project_id").references(() => projects.id),
    payloadJson: text("payload_json").notNull().default("{}"),
    // queued | running | parked | done | failed | cancelled
    status: text("status").notNull().default("queued"),
    runAt: ts("run_at").notNull().default(now),
    leaseExpiresAt: ts("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().default(now),
    updatedAt: ts("updated_at").notNull().default(now),
  },
  (table) => [
    // At most one active (queued|running) job per (type, project, epicBeadId). epicBeadId lives in
    // payload_json, so this is an expression index over json_extract. A DB-level backstop for the
    // transactional dedupe in enqueueExecuteEpicDeduped (anton-761) — stops a double approval or
    // retrigger from spawning duplicate concurrent runs of the same epic. Non-epic job types have a
    // NULL extract, and SQLite treats NULLs as distinct in a unique index, so they never collide.
    uniqueIndex("jobs_active_epic_unique")
      .on(
        table.type,
        table.projectId,
        sql`json_extract(${table.payloadJson}, '$.epicBeadId')`,
      )
      .where(sql`${table.status} in ('queued', 'running')`),
    // At most one QUEUED sync-push job per project (anton-nowq, tightened anton-x7la). Only queued
    // rows are constrained — NOT running. A write that lands while a push is already `running` dedups
    // onto that job's earlier push, but that push may have snapshotted before the write committed; the
    // write must therefore be able to enqueue exactly ONE durable follow-up (a fresh queued job) that
    // will push the new work and retry/park on failure. Constraining running too (the old predicate)
    // suppressed that follow-up and left the write's durability resting only on the fire-and-forget
    // trailing coalescer pass — the E2 gap this closes. A burst still coalesces: every write during an
    // in-flight push collapses onto the single queued follow-up (1 running + 1 queued max). Overlapping
    // pushes are prevented by the per-repo COALESCER, not this index (beads GH#2466), so two active
    // sync-push jobs can never double-push. Partial on type='sync-push' so it never touches other job
    // types; the transactional guard in enqueueSyncPushDeduped is the fast path, this index the backstop.
    uniqueIndex("jobs_active_sync_push_unique")
      .on(table.projectId)
      .where(sql`${table.type} = 'sync-push' and ${table.status} = 'queued'`),
  ],
);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(),
  cron: text("cron").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: ts("last_run_at"),
  nextRunAt: ts("next_run_at"),
});

/**
 * Per-job Claude burn samples (anton-w8ny). One row per completed job attempt: the session%/weekly%
 * that moved across the job, attributed to its TYPE. Attribution is clean only for solo windows:
 * the runner opens a burn window only when this job runs alone (nothing else in flight), and
 * discards the window if a sibling is dispatched before it closes — so every recorded delta is
 * unambiguously one job's cost. A rolling per-type
 * average over the most recent samples feeds pacing/prioritization; a static tier seed answers until
 * enough real samples accrue. Machine-local by design (no cross-machine aggregation).
 */
export const burnSamples = sqliteTable(
  "burn_samples",
  {
    id: text("id").primaryKey(),
    // execute-epic | review-fix | nightly-stringer | orphan-grooming
    jobType: text("job_type").notNull(),
    // session/weekly utilization delta (0–100 percentage points) burned across the job.
    sessionDelta: real("session_delta").notNull(),
    weeklyDelta: real("weekly_delta").notNull(),
    createdAt: ts("created_at").notNull().default(now),
  },
  // Serve the "most recent N samples for this type" query without a full scan.
  (table) => [index("burn_samples_type_created_idx").on(table.jobType, table.createdAt)],
);

/** Claude sessions — for history, diagnostics, and xterm attach. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  runId: text("run_id").references(() => runs.id),
  // shape | execute | review-fix | interactive
  kind: text("kind").notNull(),
  beadId: text("bead_id"),
  status: text("status").notNull().default("running"),
  logPath: text("log_path"),
  // Claude's own session id (from the stream-json result / system-init event), persisted so a
  // transient mid-stream death can be retried with `claude --resume <id>` (anton-juar).
  claudeSessionId: text("claude_session_id"),
  startedAt: ts("started_at").notNull().default(now),
  endedAt: ts("ended_at"),
});
