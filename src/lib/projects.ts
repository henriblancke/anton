/**
 * Registry over the `projects` table — machine-local project metadata only.
 * The shareable truth (epics/tickets, approval, stage, PR) lives in beads. See DESIGN.md §3.
 *
 * Project lifecycle only: add/delete/list/heal a registered repo. Settings (ProjectSettings and
 * its validation/merge/resolve layer) live in ./project-settings, re-exported below so every
 * existing caller of "./projects" keeps working unchanged (anton-33h0).
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { removeWorktree } from "./git/worktree";
import { configureBeadsForRepo } from "./beads/config.mjs";
import type { AntonDb } from "./jobs/queue";
import type { Project } from "./types";

export * from "./project-settings";

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
/** What the shared beads config path reports back — the one seam the log helpers below read. */
type BeadsConfigResult = ReturnType<typeof configureBeadsForRepo>;

/**
 * Whether the config path got the repo all the way there. A partial run is logged, never thrown:
 * the projects row is valid without a board, and the operator needs to see which step fell over.
 */
function logBeadsConfig(repoPath: string, result: BeadsConfigResult): void {
  if (result.errors.length) {
    console.warn(`[projects] beads config partial for ${repoPath}: ${result.errors.join("; ")}`);
  } else if (result.configured && result.ranInit) {
    console.log(`[projects] beads configured for ${repoPath}`);
  }
}

/**
 * Why a wired Dolt remote still has no `refs/dolt/data` on origin. A failed FIRST publish leaves the
 * remote EMPTY — nothing for the next clone to bootstrap from — so it reads louder than a retry note
 * on a remote that already carries history.
 */
function doltPushFailureWarning(
  repoPath: string,
  dolt: Pick<NonNullable<BeadsConfigResult["doltSync"]>, "firstPublish" | "pushAttempts">,
): string {
  if (dolt.firstPublish) {
    return (
      `[projects] Dolt remote wired for ${repoPath} but the FIRST publish failed after ` +
      `${dolt.pushAttempts} attempts — origin has no refs/dolt/data yet (empty remote); ` +
      `retry \`bd dolt pull && bd dolt push\` once auth/network is available`
    );
  }
  return (
    `[projects] Dolt remote wired for ${repoPath} — bd dolt push failed after ` +
    `${dolt.pushAttempts} attempts; retry once auth/network is available`
  );
}

/**
 * Push is non-fatal but reported (anton-8qx): the remote is wired locally even when the publish push
 * fails (e.g. no push access yet), so only claim refs/dolt/data is on origin when it actually is.
 */
function logDoltSync(repoPath: string, result: BeadsConfigResult): void {
  const dolt = result.doltSync;
  if (dolt?.status !== "configured") return;
  if (dolt.pushed !== false) {
    console.log(`[projects] Dolt remote wired for ${repoPath} (refs/dolt/data on origin)`);
    return;
  }
  console.warn(doltPushFailureWarning(repoPath, dolt));
}

/**
 * Hooks are optional for anton-driven repos (the runner pushes Dolt explicitly); just note the
 * manager so bd's post-merge/post-checkout hydration loss under it isn't a silent surprise.
 */
function logHooksWarning(repoPath: string, result: BeadsConfigResult): void {
  if (!result.hooksWarning) return;
  console.warn(
    `[projects] ${result.hooksWarning.manager} owns core.hooksPath in ${repoPath}; ` +
      `bd hydration hooks won't run — chain 'bd hooks run <hook>' manually if you rely on them.`,
  );
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
    // appRoot: this runs inside the Next server bundle, where config.mjs's module-relative package
    // root points at a build chunk. The server's cwd IS the release root (bin/anton.mjs launches it
    // with cwd: APP_ROOT — the same anchor formula.ts uses), so UI registration installs the bundled
    // bead formula just like `anton init` instead of reporting `missing-asset`.
    const result = configureBeadsForRepo(repoPath, { prefix, appRoot: process.cwd() });
    logBeadsConfig(repoPath, result);
    logDoltSync(repoPath, result);
    logHooksWarning(repoPath, result);
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

/** A projects row as stored — what each teardown step is handed instead of re-reading it. */
type ProjectRow = typeof schema.projects.$inferSelect;

/** One anton-created worktree recorded on a run, with the branch to delete alongside it. */
interface ProjectWorktree {
  path: string;
  branch: string;
}

/**
 * Teardown step 1 — stop live work before anything else. Raise BOTH enqueue barriers, then drain: a
 * scheduler tick or approval that already crossed the barrier is caught by `quiesceProject`'s abort
 * sweep, anything later is rejected, so the runner can't re-claim this project mid-teardown.
 *
 * Dynamic import — the service statically imports this module for its policy resolver, so a static
 * import here would cycle.
 */
async function quiesceProjectWork(slug: string, projectId: string): Promise<void> {
  try {
    const { getRunner, getScheduler } = await import("./jobs/service");
    getScheduler().quiesceProject(projectId);
    await getRunner().quiesceProject(projectId);
  } catch (e) {
    throw new Error(`deleteProject(${slug}): aborting in-flight jobs failed: ${errMsg(e)}`);
  }
}

/** The distinct worktrees this project's runs created — never the repo's own working tree. */
async function projectWorktrees(db: AntonDb, project: ProjectRow): Promise<ProjectWorktree[]> {
  const runRows = await db
    .select({ worktreePath: schema.runs.worktreePath, branch: schema.runs.branch })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, project.id));
  const worktrees = new Map<string, ProjectWorktree>();
  for (const run of runRows) {
    if (!run.worktreePath) continue;
    // Paranoia guard: never operate on the repo's own working tree, whatever the row says.
    if (resolve(run.worktreePath) === resolve(project.repoPath)) continue;
    worktrees.set(run.worktreePath, { path: run.worktreePath, branch: run.branch ?? "" });
  }
  return [...worktrees.values()];
}

/** What survived removal. `removeWorktree` is best-effort internally, so the result is verified. */
async function worktreeResidue(
  repoPath: string,
  worktrees: ProjectWorktree[],
): Promise<string[]> {
  const residue: string[] = [];
  for (const wt of worktrees) {
    if (existsSync(wt.path)) residue.push(`worktree ${wt.path}`);
    if (wt.branch && (await branchExists(repoPath, wt.branch))) {
      residue.push(`branch ${wt.branch}`);
    }
  }
  return residue;
}

/**
 * Teardown step 2 — remove every anton-created worktree + branch recorded on this project's runs,
 * then fail loud BEFORE any row is touched. If a worktree or branch survived, the DB state is kept
 * so a retry can finish the cleanup instead of deleting the only record of where the residue lives.
 */
async function removeProjectWorktrees(
  db: AntonDb,
  slug: string,
  project: ProjectRow,
): Promise<void> {
  const worktrees = await projectWorktrees(db, project);
  for (const wt of worktrees) {
    await removeWorktree(
      {
        path: wt.path,
        branch: wt.branch,
        baseBranch: wt.branch,
        createdBranch: false,
        repoPath: project.repoPath,
      },
      { deleteBranch: Boolean(wt.branch) },
    );
  }
  const residue = await worktreeResidue(project.repoPath, worktrees);
  if (residue.length > 0) {
    throw new Error(
      `deleteProject(${slug}): worktree cleanup left residue (${residue.join(", ")}); ` +
        `rows kept so a retry can complete the teardown`,
    );
  }
}

/** Teardown step 3 — session logs are disposable local diagnostics: best-effort, never blocking. */
async function deleteSessionLogs(db: AntonDb, projectId: string): Promise<void> {
  const sessionRows = await db
    .select({ logPath: schema.sessions.logPath })
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, projectId));
  for (const session of sessionRows) {
    if (!session.logPath) continue;
    await unlink(session.logPath).catch(() => {});
  }
}

/**
 * Teardown step 4 — drop the project's anton.db rows atomically, children before parents (no ON
 * DELETE CASCADE in the schema): sessions → runs → jobs → schedules → run-health → picker plan →
 * picker verdicts → picker starts → claude invocations → hygiene → scan summaries → autopilot
 * disarms → escalations →
 * burn samples (detached, not deleted) → quota-attempt ledger → projects.
 */
function deleteProjectRows(db: AntonDb, slug: string, projectId: string): void {
  try {
    db.transaction((tx) => {
      tx.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId)).run();
      tx.delete(schema.runs).where(eq(schema.runs.projectId, projectId)).run();
      tx.delete(schema.quotaAttempts).where(eq(schema.quotaAttempts.projectId, projectId)).run();
      tx.delete(schema.jobs).where(eq(schema.jobs.projectId, projectId)).run();
      tx.delete(schema.schedules).where(eq(schema.schedules.projectId, projectId)).run();
      tx.delete(schema.runHealthReports).where(eq(schema.runHealthReports.projectId, projectId)).run();
      tx
        .delete(schema.boardPickerPlans)
        .where(eq(schema.boardPickerPlans.projectId, projectId))
        .run();
      tx
        .delete(schema.pickerVerdicts)
        .where(eq(schema.pickerVerdicts.projectId, projectId))
        .run();
      tx.delete(schema.pickerStarts).where(eq(schema.pickerStarts.projectId, projectId)).run();
      // The spend ledger references the project, so it goes before the project DELETE or the whole
      // teardown rolls back on the foreign key. DELETED, not detached like burn samples: those are a
      // property of the MACHINE and outlive the project, while what a project's own tasks spent is
      // meaningless once the project is gone.
      tx
        .delete(schema.claudeInvocations)
        .where(eq(schema.claudeInvocations.projectId, projectId))
        .run();
      tx.delete(schema.hygieneReports).where(eq(schema.hygieneReports.projectId, projectId)).run();
      tx.delete(schema.scanSummaries).where(eq(schema.scanSummaries.projectId, projectId)).run();
      // Before the escalations they point at, and before the project they reference: a project
      // disarmed even once keeps its whole disarm history, so leaving these behind fails the
      // project DELETE on the foreign key and rolls the entire teardown back.
      tx
        .delete(schema.autopilotDisarms)
        .where(eq(schema.autopilotDisarms.projectId, projectId))
        .run();
      tx.delete(schema.escalations).where(eq(schema.escalations.projectId, projectId)).run();
      // Burn samples are DETACHED rather than dropped: what each job type costs this machine is a
      // property of the machine, not of the project that happened to spend it, and the per-type
      // averages pacing reads would otherwise regress to the tier seeds on every deregistration.
      // Nulling the attribution is exactly what the column's null already means (unattributed), and
      // it clears the foreign key that would otherwise roll the whole teardown back.
      tx
        .update(schema.burnSamples)
        .set({ projectId: null })
        .where(eq(schema.burnSamples.projectId, projectId))
        .run();
      tx.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
    });
  } catch (e) {
    throw new Error(`deleteProject(${slug}): deleting anton.db rows failed: ${errMsg(e)}`);
  }
}

/**
 * Full local teardown for a project (anton-adt), in the order the steps below must run: stop live
 * work, remove every anton-created worktree + branch, delete its session logs, then drop its
 * anton.db rows. Leaves the repo itself pristine — the only git commands run are `worktree
 * remove/prune` and `branch -D` on anton's own branches; nothing touches the repo's working tree,
 * tracked files, or `.beads/`.
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

  await quiesceProjectWork(slug, project.id);
  await removeProjectWorktrees(db, slug, project);
  await deleteSessionLogs(db, project.id);
  deleteProjectRows(db, slug, project.id);
}

/** The row registration writes: a unique slug and the repo's own default branch, resolved once. */
async function insertProjectRow(
  db: AntonDb,
  repoPath: string,
  requestedName?: string,
): Promise<Omit<Project, "hasBeads" | "createdAt">> {
  const name = requestedName?.trim() || basename(repoPath);
  const slug = await uniqueSlug(toSlug(name) || "project");
  const defaultBranch = await detectDefaultBranch(repoPath);
  const id = randomUUID();
  await db.insert(schema.projects).values({ id, slug, name, repoPath, defaultBranch });
  return { id, slug, name, repoPath, defaultBranch };
}

/**
 * Seed the default background-job schedules (nightly stringer, review-fix poll, orphan grooming) so
 * the Phase 2 jobs run without manual setup. Best-effort — a scheduling hiccup must not fail project
 * creation, and schedules can be added later.
 */
async function seedProjectSchedules(db: AntonDb, projectId: string): Promise<void> {
  try {
    const { seedDefaultSchedules } = await import("./schedules");
    const { systemClock } = await import("./jobs/queue");
    await seedDefaultSchedules(db, systemClock, projectId);
  } catch {
    // non-fatal — schedules can be added later.
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

  const row = await insertProjectRow(db, repoPath, input.name);
  await seedProjectSchedules(db, row.id);

  // Self-heal beads so a UI/API-added repo converges to the same end state as `anton init`
  // (anton-uez). Best-effort; `hasBeads` reflects the post-heal reality. The chosen prefix
  // (anton-ivtj) is threaded to `bd init` so a fresh board gets the operator's ticket-ID prefix.
  const hasBeads = healBeads(repoPath, input.prefix);

  return { ...row, hasBeads, createdAt: Math.floor(Date.now() / 1000) };
}
