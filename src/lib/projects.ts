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
}

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

export async function addProject(input: { name?: string; repoPath: string }): Promise<Project> {
  const repoPath = resolve(input.repoPath);
  if (!existsSync(repoPath)) {
    throw new Error(`repoPath does not exist: ${repoPath}`);
  }

  const name = input.name?.trim() || basename(repoPath);
  const baseSlug = toSlug(input.name?.trim() || basename(repoPath)) || "project";
  const slug = await uniqueSlug(baseSlug);
  const defaultBranch = await detectDefaultBranch(repoPath);
  const hasBeads = existsSync(join(repoPath, ".beads"));
  const id = randomUUID();

  const db = getDb();
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
