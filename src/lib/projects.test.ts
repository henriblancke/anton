import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let workDir: string;
let dbFile: string;
let addProject: typeof import("./projects").addProject;
let listProjects: typeof import("./projects").listProjects;
let getProjectBySlug: typeof import("./projects").getProjectBySlug;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "anton-projects-test-"));
  dbFile = join(workDir, "anton.db");
  process.env.ANTON_DB = dbFile;

  const migrationSql = readFileSync(
    join(process.cwd(), "drizzle", "0000_lumpy_captain_flint.sql"),
    "utf-8",
  );
  const setup = new Database(dbFile);
  setup.exec(migrationSql);
  setup.close();

  const mod = await import("./projects");
  addProject = mod.addProject;
  listProjects = mod.listProjects;
  getProjectBySlug = mod.getProjectBySlug;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeRepoDir(name: string, opts: { withBeads?: boolean } = {}): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  if (opts.withBeads) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
  }
  return dir;
}

describe("addProject", () => {
  it("slugifies the provided name", async () => {
    const repoPath = makeRepoDir("Repo One");
    const project = await addProject({ name: "My Cool Project!", repoPath });
    expect(project.slug).toBe("my-cool-project");
  });

  it("falls back to the repoPath basename when name is omitted", async () => {
    const repoPath = makeRepoDir("basename-fallback-repo");
    const project = await addProject({ repoPath });
    expect(project.slug).toBe("basename-fallback-repo");
    expect(project.name).toBe("basename-fallback-repo");
  });

  it("disambiguates slug collisions", async () => {
    const repoA = makeRepoDir("collide-a");
    const repoB = makeRepoDir("collide-b");
    const first = await addProject({ name: "Collide", repoPath: repoA });
    const second = await addProject({ name: "Collide", repoPath: repoB });
    expect(first.slug).toBe("collide");
    expect(second.slug).toBe("collide-2");
  });

  it("detects hasBeads via a .beads directory", async () => {
    const withBeads = makeRepoDir("with-beads", { withBeads: true });
    const withoutBeads = makeRepoDir("without-beads");

    const projectA = await addProject({ name: "With Beads", repoPath: withBeads });
    const projectB = await addProject({ name: "Without Beads", repoPath: withoutBeads });

    expect(projectA.hasBeads).toBe(true);
    expect(projectB.hasBeads).toBe(false);
  });

  it("falls back to 'main' when the repo has no resolvable HEAD", async () => {
    const repoPath = makeRepoDir("no-git-here");
    const project = await addProject({ name: "No Git", repoPath });
    expect(project.defaultBranch).toBe("main");
  });

  it("throws a clear error when repoPath does not exist", async () => {
    await expect(
      addProject({ name: "Ghost", repoPath: join(workDir, "does-not-exist") }),
    ).rejects.toThrow(/does not exist/);
  });

  it("persists the project so it is retrievable by slug and in the listing", async () => {
    const repoPath = makeRepoDir("persisted-repo");
    const created = await addProject({ name: "Persisted", repoPath });

    const bySlug = await getProjectBySlug(created.slug);
    expect(bySlug).toMatchObject({ id: created.id, slug: created.slug, repoPath });

    const all = await listProjects();
    expect(all.some((p) => p.id === created.id)).toBe(true);
  });

  it("returns null for an unknown slug", async () => {
    expect(await getProjectBySlug("does-not-exist-slug")).toBeNull();
  });

  it("is idempotent by repoPath — re-adding the same repo returns the existing row (anton-uez)", async () => {
    const repoPath = makeRepoDir("idempotent-repo");
    const first = await addProject({ name: "Idem", repoPath });
    const second = await addProject({ name: "Idem Again", repoPath });

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);

    const matches = (await listProjects()).filter((p) => p.repoPath === repoPath);
    expect(matches).toHaveLength(1);
  });
});
