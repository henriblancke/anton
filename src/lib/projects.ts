/**
 * Registry over the `projects` table — machine-local project metadata only.
 * The shareable truth (epics/tickets, approval, stage, PR) lives in beads. See DESIGN.md §3.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { removeWorktree } from "./git/worktree";
import { configureBeadsForRepo } from "./beads/config.mjs";
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./jobs/budget";
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
  /**
   * Optional operator-pinned verify gates (anton-3oh8), run in the worktree after the agent and
   * before commit alongside `testCommand`. Each is a shell command; a non-zero exit fails the
   * ticket exactly like the test gate. Absent → skipped (no behavior change). These are the
   * deterministic hard backstop complementing the agent's own self-verification (sibling ticket).
   */
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
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
  /**
   * Conventional-commit PR titles (anton-41d): when true, execute-epic prefixes the epic PR title
   * with a deterministic `<type>(<scope>): ` derived from the target bead (bug→fix, epic/task→feat;
   * scope = the `agent:` label when present). Absent → OFF (opt-in): the title stays the historical
   * `<title> (<id>)`, so existing projects' PR titles are unchanged until enabled.
   */
  conventionalCommits?: boolean;
  /**
   * Budget-aware execution master-switch (anton-7mpv.1). OFF by default: only when a project turns
   * this on does the runner's budget governor pace/defer that project's autonomous work against the
   * Claude plan (see `resolveBudgetPolicy` in ./jobs/service and the governor in ./jobs/budget).
   * Kept deliberately separate from `budgetPolicy` (the knobs): the knobs may be pre-set while the
   * feature stays off. Default off is also what keeps the runner from reading Claude usage at all —
   * so the nav usage pill isn't starved of the shared cache — until an operator opts in.
   */
  budgetAware?: boolean;
  /**
   * Operator-tunable budget policy (anton-egrg): the subset of the governor's full
   * {@link BudgetPolicy} the operator controls per project. Absent → DEFAULT_PROJECT_BUDGET_POLICY;
   * a stored value need only carry the fields the operator touched (the rest fall back to default
   * on resolve). Validated with {@link budgetPolicySchema} at the API boundary. Only consulted when
   * {@link budgetAware} is on.
   */
  budgetPolicy?: ProjectBudgetPolicy;
}

/** A resolved verify gate (anton-3oh8): a stable label (for logs/errors) + the shell command. */
export interface VerifyGate {
  label: string;
  command: string;
}

/**
 * The ordered verify gates configured for a project (anton-3oh8): tests, then lint, typecheck,
 * build. Unset commands are skipped, so an empty result means "no gates" → unchanged behavior.
 * Shared by execute-epic and review-fix so both enforce the same operator backstop identically.
 */
export function resolveVerifyGates(settings: ProjectSettings): VerifyGate[] {
  const gates: VerifyGate[] = [];
  if (settings.testCommand) gates.push({ label: "tests", command: settings.testCommand });
  if (settings.lintCommand) gates.push({ label: "lint", command: settings.lintCommand });
  if (settings.typecheckCommand) {
    gates.push({ label: "typecheck", command: settings.typecheckCommand });
  }
  if (settings.buildCommand) gates.push({ label: "build", command: settings.buildCommand });
  return gates;
}

/** Defaults for the per-project job policy when a setting is unset. */
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2 hours
export const DEFAULT_MAX_RETRIES = 3;

/** Allowed ranges for the numeric job-policy settings (validated at the API boundary). */
export const CONCURRENCY_RANGE = { min: 1, max: 6 } as const;
export const JOB_TIMEOUT_MINUTES_RANGE = { min: 5, max: 720 } as const; // 5 min … 12 h
export const MAX_RETRIES_RANGE = { min: 1, max: 10 } as const;

/** A 0–100 integer percentage — the same scale the governor's {@link BudgetPolicy} uses. */
const pctSchema = z.number().int().min(0).max(100);

/**
 * Operator-facing budget policy (anton-egrg): the tunable subset of the governor's full
 * {@link BudgetPolicy}. Every field optional so a patch can carry just the knobs the operator
 * touched; each is strictly range-checked (fail loud on out-of-range), and unknown keys are
 * rejected. `dayWindow` is a local `[startHour, endHour)` pair with `start < end`.
 */
export const budgetPolicySchema = z
  .object({
    dayWindow: z
      .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
      .refine(([start, end]) => start < end, {
        message: "dayWindow start hour must be before end hour",
      }),
    daytimeReservePct: pctSchema,
    weeklyTargetPct: pctSchema,
    minSessionHeadroomPct: pctSchema,
    preferNightForHeavy: z.boolean(),
  })
  .partial()
  .strict();

export type ProjectBudgetPolicy = z.infer<typeof budgetPolicySchema>;

/**
 * Safe defaults applied when a policy (or one of its fields) is absent. The daytime reserve is the
 * configurable knob the founder asked for; the weekly target drives the governor's pace-line.
 */
export const DEFAULT_PROJECT_BUDGET_POLICY: Required<ProjectBudgetPolicy> = {
  dayWindow: [9, 18],
  daytimeReservePct: 15,
  weeklyTargetPct: 90,
  minSessionHeadroomPct: 5,
  preferNightForHeavy: true,
};

/** Overlay the stored (possibly partial) operator policy onto the defaults — never a partial out. */
export function resolveProjectBudgetPolicy(
  settings: ProjectSettings,
): Required<ProjectBudgetPolicy> {
  return { ...DEFAULT_PROJECT_BUDGET_POLICY, ...(settings.budgetPolicy ?? {}) };
}

/**
 * Project a project's settings onto the governor's full {@link BudgetPolicy}: the operator's knobs
 * ride on top of {@link DEFAULT_BUDGET_POLICY}, so fields the operator can't set keep the governor's
 * shipped defaults. `preferNightForHeavy` off zeroes the night value discount, so heavy jobs are no
 * longer preferentially deferred to night. This is the hook the admission gate (anton-szld) consumes.
 */
export function resolveBudgetPolicy(settings: ProjectSettings): BudgetPolicy {
  const p = resolveProjectBudgetPolicy(settings);
  return {
    ...DEFAULT_BUDGET_POLICY,
    minSessionHeadroomPct: p.minSessionHeadroomPct,
    daytimeReservePct: p.daytimeReservePct,
    dayStartHour: p.dayWindow[0],
    dayEndHour: p.dayWindow[1],
    weeklyTargetPct: p.weeklyTargetPct,
    nightValueDiscount: p.preferNightForHeavy ? DEFAULT_BUDGET_POLICY.nightValueDiscount : 0,
  };
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

/**
 * Whether ANY project has budget-aware execution turned on (anton-7mpv.1). The shaping nudge is a
 * workspace-wide glance, so it's gated on the feature being enabled *somewhere* rather than for a
 * single project. Fail-soft: a project with unparseable settingsJson is treated as off, and the
 * default (no project opted in) returns false — the nudge stays hidden.
 */
export async function isBudgetAwareEnabledAnywhere(): Promise<boolean> {
  const rows = await getDb().select({ settingsJson: schema.projects.settingsJson }).from(schema.projects);
  return rows.some((row) => {
    try {
      return (JSON.parse(row.settingsJson) as ProjectSettings).budgetAware === true;
    } catch {
      return false;
    }
  });
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
 *
 * `prefix` (anton-ivtj) is threaded to `bd init` for a fresh repo with no `.beads/` yet, so the
 * board's ticket-ID prefix is the operator's choice rather than bd's silent dir-name default. It is
 * ignored once a workspace exists (enforcement-only re-run), so passing it on every add is safe.
 */
function healBeads(repoPath: string, prefix?: string): boolean {
  try {
    const result = configureBeadsForRepo(repoPath, { prefix });
    if (result.errors.length) {
      console.warn(
        `[projects] beads config partial for ${repoPath}: ${result.errors.join("; ")}`,
      );
    } else if (result.configured && result.ranInit) {
      console.log(`[projects] beads configured for ${repoPath}`);
    }
    if (result.doltSync?.status === "configured") {
      // Push is non-fatal + reported (anton-8qx): the remote is wired locally even when the publish
      // push fails (e.g. no push access yet), so only claim refs/dolt/data is on origin when it is.
      // A failed FIRST publish leaves the remote EMPTY (nothing for the next clone to bootstrap
      // from) — warn LOUD on that case rather than logging it as a routine retry note.
      if (result.doltSync.pushed !== false) {
        console.log(`[projects] Dolt remote wired for ${repoPath} (refs/dolt/data on origin)`);
      } else if (result.doltSync.firstPublish) {
        console.warn(
          `[projects] Dolt remote wired for ${repoPath} but the FIRST publish failed after ` +
            `${result.doltSync.pushAttempts} attempts — origin has no refs/dolt/data yet (empty remote); ` +
            `retry \`bd dolt pull && bd dolt push\` once auth/network is available`,
        );
      } else {
        console.warn(
          `[projects] Dolt remote wired for ${repoPath} — bd dolt push failed after ` +
            `${result.doltSync.pushAttempts} attempts; retry once auth/network is available`,
        );
      }
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

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Full local teardown for a project (anton-adt): abort its live work, remove every anton-created
 * worktree + branch, delete its session logs, then drop its anton.db rows. Leaves the repo itself
 * pristine — the only git commands run are `worktree remove/prune` and `branch -D` on anton's own
 * branches; nothing touches the repo's working tree, tracked files, or `.beads/`.
 *
 * Idempotent-by-absence: a second call (or an unknown slug) throws the clear not-found error, with
 * nothing left to clean. Fails loud mid-way: if a step leaves residue (a worktree/branch that
 * survived removal), the project's rows are kept and the error names the residue so a retry can
 * finish the job instead of silently orphaning it.
 */
export async function deleteProject(slug: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .limit(1);
  const project = rows[0];
  if (!project) throw new Error(`Project not found: ${slug}`);

  // 1. Stop live work first: force-abort in-flight jobs and drop queued/running rows so the
  //    runner can't re-claim this project's work mid-teardown. Dynamic import — the service
  //    statically imports this module for its policy resolver, so a static import would cycle.
  try {
    const { getRunner, getScheduler } = await import("./jobs/service");
    // Raise both enqueue barriers before draining work. A scheduler tick or approval that already
    // crossed the barrier is caught by quiesceProject's abort sweep; anything later is rejected.
    getScheduler().quiesceProject(project.id);
    await getRunner().quiesceProject(project.id);
  } catch (e) {
    throw new Error(`deleteProject(${slug}): aborting in-flight jobs failed: ${errMsg(e)}`);
  }

  // 2. Remove every anton-created worktree + branch recorded on this project's runs.
  const runRows = await db
    .select({ worktreePath: schema.runs.worktreePath, branch: schema.runs.branch })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, project.id));
  const worktrees = new Map<string, { path: string; branch: string }>();
  for (const run of runRows) {
    if (!run.worktreePath) continue;
    // Paranoia guard: never operate on the repo's own working tree, whatever the row says.
    if (resolve(run.worktreePath) === resolve(project.repoPath)) continue;
    worktrees.set(run.worktreePath, { path: run.worktreePath, branch: run.branch ?? "" });
  }
  for (const wt of worktrees.values()) {
    await removeWorktree(
      { path: wt.path, branch: wt.branch, baseBranch: wt.branch, repoPath: project.repoPath },
      { deleteBranch: Boolean(wt.branch) },
    );
  }

  // Fail loud before touching rows: removeWorktree is best-effort internally, so verify. If a
  // worktree or branch survived, keep the DB state so a retry can finish the cleanup instead of
  // deleting the only record of where the residue lives.
  const residue: string[] = [];
  for (const wt of worktrees.values()) {
    if (existsSync(wt.path)) residue.push(`worktree ${wt.path}`);
    if (wt.branch && (await branchExists(project.repoPath, wt.branch))) {
      residue.push(`branch ${wt.branch}`);
    }
  }
  if (residue.length > 0) {
    throw new Error(
      `deleteProject(${slug}): worktree cleanup left residue (${residue.join(", ")}); ` +
        `rows kept so a retry can complete the teardown`,
    );
  }

  // 3. Session logs are disposable local diagnostics — delete best-effort, never block teardown.
  const sessionRows = await db
    .select({ logPath: schema.sessions.logPath })
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, project.id));
  for (const session of sessionRows) {
    if (!session.logPath) continue;
    await unlink(session.logPath).catch(() => {});
  }

  // 4. Drop the project's anton.db rows atomically, children before parents (no ON DELETE
  //    CASCADE in the schema): sessions → runs → jobs → schedules → projects.
  try {
    db.transaction((tx) => {
      tx.delete(schema.sessions).where(eq(schema.sessions.projectId, project.id)).run();
      tx.delete(schema.runs).where(eq(schema.runs.projectId, project.id)).run();
      tx.delete(schema.jobs).where(eq(schema.jobs.projectId, project.id)).run();
      tx.delete(schema.schedules).where(eq(schema.schedules.projectId, project.id)).run();
      tx.delete(schema.projects).where(eq(schema.projects.id, project.id)).run();
    });
  } catch (e) {
    throw new Error(`deleteProject(${slug}): deleting anton.db rows failed: ${errMsg(e)}`);
  }
}

export async function addProject(input: {
  name?: string;
  repoPath: string;
  /** Ticket-ID prefix for a fresh `bd init` (anton-ivtj). Ignored when the repo already has a board. */
  prefix?: string;
}): Promise<Project> {
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
    healBeads(repoPath, input.prefix);
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
  // (anton-uez). Best-effort; `hasBeads` reflects the post-heal reality. The chosen prefix
  // (anton-ivtj) is threaded to `bd init` so a fresh board gets the operator's ticket-ID prefix.
  const hasBeads = healBeads(repoPath, input.prefix);

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
