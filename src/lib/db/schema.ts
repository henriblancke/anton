/**
 * anton.db — ephemeral, machine-local execution state (git-ignored, disposable).
 * The shareable truth (epics/tickets, approval, stage, PR link) lives in beads (.beads/*.jsonl).
 * See DESIGN.md §3.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  // execute-epic | review-fix | nightly-stringer | orphan-grooming
  type: text("type").notNull(),
  projectId: text("project_id").references(() => projects.id),
  payloadJson: text("payload_json").notNull().default("{}"),
  // queued | running | parked | done | failed
  status: text("status").notNull().default("queued"),
  runAt: ts("run_at").notNull().default(now),
  leaseExpiresAt: ts("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().default(now),
  updatedAt: ts("updated_at").notNull().default(now),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(),
  cron: text("cron").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: ts("last_run_at"),
  nextRunAt: ts("next_run_at"),
});

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
  startedAt: ts("started_at").notNull().default(now),
  endedAt: ts("ended_at"),
});
