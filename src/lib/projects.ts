/**
 * Registry over the `projects` table — machine-local project metadata only.
 * The shareable truth (epics/tickets, approval, stage, PR) lives in beads. See DESIGN.md §3.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { configureBeadsForRepo } from "./beads/config.mjs";
import type { AntonDb } from "./jobs/queue";
import type { Project } from "./types";

const execFileAsync = promisify(execFile);

function toSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function uniqueSlug(base: string): Promise<string> {
  const rows = await getDb().select({ slug: schema.projects.slug }).from(schema.projects);
  const taken = new Set(rows.map((r) => r.slug));
  let slug = base || "project";
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
      { timeout: 10_000 },
    );
    const branch = stdout.trim();
    return branch || "main";
  } catch {
    return "main";
  }
}

function toProject(row: typeof schema.projects.$inferSelect): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repoPath: row.repoPath,
    defaultBranch: row.defaultBranch,
    hasBeads: existsSync(join(row.repoPath, ".beads")),
    createdAt: Math.floor(
      row.createdAt instanceof Date ? row.createdAt.getTime() / 1000 : Number(row.createdAt),
    ),
  };
}

export async function listProjects(): Promise<Project[]> {
  const rows = await getDb().select().from(schema.projects);
  return rows.map(toProject);
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const rows = await getDb()
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .limit(1);
  return rows[0] ? toProject(rows[0]) : null;
}

/** db-injectable lookup by id (the runner/handler shares its connection). */
export async function getProjectById(db: AntonDb, id: string): Promise<Project | null> {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  return rows[0] ? toProject(rows[0]) : null;
}

/** Parsed project settings (settingsJson). All optional; sensible defaults applied by callers. */
export interface ProjectSettings {
  model?: string;
  testCommand?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  baseBranch?: string;
  /**
   * Operator-editable seed prompt layered onto the locked base contract for autonomous runs
   * (anton-cjs). Customizes how epics are approached; cannot override the base. Empty = none.
   */
  seedPrompt?: string;
  /**
   * Operator-editable reasoning prompt for the review-fix job (anton-f5n). Overrides the default
   * `skills/review-fix/SKILL.md` when set; anton appends the concrete PR context beneath it. Empty
   * = use the shipped default.
   */
  reviewFixPrompt?: string;
  /**
   * Max concurrent execute-epic runs for this project (anton-xbk). The runner gates approved-epic
   * execution per project against this; other job types (review-fix/nightly) don't count against
   * it. Absent → DEFAULT_CONCURRENCY.
   */
  concurrency?: number;
  /**
   * Wall-clock timeout for a single job attempt, in minutes (anton-xbk). On expiry the run is
   * aborted and retried/parked like any other failure. Absent → DEFAULT_JOB_TIMEOUT_MINUTES (2h).
   */
  jobTimeoutMinutes?: number;
  /**
   * Max attempts for a job before it is parked for a human (anton-xbk). A failed ticket fails the
   * execute-epic job, which retries and resumes past already-closed tickets — so this is the
   * effective per-task retry budget. Absent → DEFAULT_MAX_RETRIES.
   */
  maxRetries?: number;
  /**
   * Active-agents allowlist (anton-46w): which specialist agent prompts dispatch may assign. Each
   * entry is a discoverable agent id — bundled OR the project's own `.claude/agents` (anton-dvo.1,
   * discoverAgents in src/lib/agents-discovery.ts). Enforced by dispatch (anton-dm7, execute-epic):
   * a run whose ticket needs a disabled agent is PARKED with a clear reason — never silently run
   * with the default agent. Absent (never persisted / cleared) → all agents active; empty `[]` →
   * no agents active (the operator toggled every agent off), so any labeled ticket is parked. The
   * UI seeds "all discovered on" when this is absent, so a no-op save stays all-active.
   */
  agents?: string[];
  /**
   * Autonomy master-switch (anton-46w): whether approved epics execute without asking. Absent →
   * true (autonomous). Enforced by the runner's claim gate (anton-y3l): off leaves execute-epic
   * jobs `queued` (approval still enqueues), and turning it back on resumes them.
   */
  autonomy?: boolean;
}

/** Defaults for the per-project job policy when a setting is unset. */
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2 hours
export const DEFAULT_MAX_RETRIES = 3;

/** Allowed ranges for the numeric job-policy settings (validated at the API boundary). */
export const CONCURRENCY_RANGE = { min: 1, max: 6 } as const;
export const JOB_TIMEOUT_MINUTES_RANGE = { min: 5, max: 720 } as const; // 5 min … 12 h
export const MAX_RETRIES_RANGE = { min: 1, max: 10 } as const;

export async function getProjectSettings(db: AntonDb, id: string): Promise<ProjectSettings> {
  const rows = await db
    .select({ settingsJson: schema.projects.settingsJson })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);
  try {
    return rows[0] ? (JSON.parse(rows[0].settingsJson) as ProjectSettings) : {};
  } catch {
    return {};
  }
}

/** Read this project's settings via the shared anton.db (UI/API read path). */
export async function getProjectSettingsBySlug(slug: string): Promise<ProjectSettings> {
  const p = await getProjectBySlug(slug);
  if (!p) return {};
  return getProjectSettings(getDb(), p.id);
}

/** Merge a settings patch into the project's settingsJson. Returns the merged settings. */
export async function updateProjectSettings(
  slug: string,
  patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const db = getDb();
  const p = await getProjectBySlug(slug);
  if (!p) throw new Error(`Project not found: ${slug}`);
  const current = await getProjectSettings(db, p.id);
  // Drop keys explicitly set to undefined so "Default" clears rather than persists.
  const next: ProjectSettings = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  await db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify(next) })
    .where(eq(schema.projects.id, p.id));
  return next;
}

/**
 * Best-effort beads self-heal for a registered repo (anton-uez). Runs the shared config path
 * (bd init + config.yaml enforcement + .gitignore [+ Dolt wiring via anton-43b]) so a repo added
 * through the UI/API converges to the same end state as one configured via `anton init`. Never
 * throws: a plain directory with no git/origin is skipped, and a beads-config failure is surfaced
 * (logged) but leaves the projects row intact. Returns whether `.beads/` exists afterwards.
 */
function healBeads(repoPath: string): boolean {
  try {
    const result = configureBeadsForRepo(repoPath);
    if (result.errors.length) {
      console.warn(
        `[projects] beads config partial for ${repoPath}: ${result.errors.join("; ")}`,
      );
    } else if (result.configured && result.ranInit) {
      console.log(`[projects] beads configured for ${repoPath}`);
    }
    if (result.doltSync?.status === "configured") {
      console.log(`[projects] Dolt remote wired for ${repoPath} (refs/dolt/data on origin)`);
    }
    if (result.hooksWarning) {
      // Hooks are optional for anton-driven repos (runner pushes Dolt explicitly); just note the
      // manager so bd's post-merge/post-checkout hydration loss under it isn't a silent surprise.
      console.warn(
        `[projects] ${result.hooksWarning.manager} owns core.hooksPath in ${repoPath}; ` +
          `bd hydration hooks won't run — chain 'bd hooks run <hook>' manually if you rely on them.`,
      );
    }
    return result.hasBeads;
  } catch (err) {
    console.warn(`[projects] beads self-heal failed for ${repoPath}: ${String(err)}`);
    return existsSync(join(repoPath, ".beads"));
  }
}

export async function addProject(input: { name?: string; repoPath: string }): Promise<Project> {
  const repoPath = resolve(input.repoPath);
  if (!existsSync(repoPath)) {
    throw new Error(`repoPath does not exist: ${repoPath}`);
  }

  const db = getDb();

  // Idempotent (anton-uez): a repo already registered returns its existing row rather than creating
  // a duplicate — an `anton init` re-run, or POST /api/projects on a known repo, is a safe no-op.
  // Still run the self-heal so a previously-misconfigured repo converges on every add.
  const existing = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.repoPath, repoPath))
    .limit(1);
  if (existing[0]) {
    healBeads(repoPath);
    return toProject(existing[0]);
  }

  const name = input.name?.trim() || basename(repoPath);
  const baseSlug = toSlug(input.name?.trim() || basename(repoPath)) || "project";
  const slug = await uniqueSlug(baseSlug);
  const defaultBranch = await detectDefaultBranch(repoPath);
  const id = randomUUID();

  await db.insert(schema.projects).values({
    id,
    slug,
    name,
    repoPath,
    defaultBranch,
  });

  // Seed the default background-job schedules (nightly stringer, review-fix poll, orphan grooming)
  // so the Phase 2 jobs run without manual setup. Best-effort — a scheduling hiccup must not fail
  // project creation.
  try {
    const { seedDefaultSchedules } = await import("./schedules");
    const { systemClock } = await import("./jobs/queue");
    await seedDefaultSchedules(db, systemClock, id);
  } catch {
    // non-fatal — schedules can be added later.
  }

  // Self-heal beads so a UI/API-added repo converges to the same end state as `anton init`
  // (anton-uez). Best-effort; `hasBeads` reflects the post-heal reality.
  const hasBeads = healBeads(repoPath);

  const createdAt = Math.floor(Date.now() / 1000);

  return {
    id,
    slug,
    name,
    repoPath,
    defaultBranch,
    hasBeads,
    createdAt,
  };
}
