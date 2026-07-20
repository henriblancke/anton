import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

// Stub the beads config path so the threading is observable without a real bd/git repo (CI has
// neither). We assert addProject hands configureBeadsForRepo the chosen prefix and surfaces its
// hasBeads verdict on the returned project.
const configureBeadsForRepo = vi.fn();
vi.mock("./beads/config.mjs", () => ({ configureBeadsForRepo }));

let workDir: string;
let addProject: typeof import("./projects").addProject;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "anton-projects-beads-test-"));
  process.env.ANTON_DB = join(workDir, "anton.db");

  const migrationSql = readFileSync(
    join(process.cwd(), "drizzle", "0000_lumpy_captain_flint.sql"),
    "utf-8",
  );
  const setup = new Database(process.env.ANTON_DB);
  setup.exec(migrationSql);
  setup.close();

  ({ addProject } = await import("./projects"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  configureBeadsForRepo.mockReset();
  configureBeadsForRepo.mockReturnValue({
    configured: true,
    ranInit: true,
    steps: [],
    errors: [],
    hasBeads: true,
  });
});

function makeRepo(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("addProject beads bootstrap (anton-ivtj)", () => {
  it("threads the chosen prefix to configureBeadsForRepo and reports the configured board", async () => {
    const repoPath = makeRepo("fresh-repo");

    const project = await addProject({ name: "Fresh", repoPath, prefix: "fresh" });

    expect(configureBeadsForRepo).toHaveBeenCalledWith(resolve(repoPath), { prefix: "fresh" });
    // configureBeadsForRepo ran bd init and reported a board — addProject surfaces that verdict.
    expect(project.hasBeads).toBe(true);
  });

  it("re-adding an already-registered repo is idempotent but still re-runs the self-heal", async () => {
    const repoPath = makeRepo("idem-repo");

    const first = await addProject({ repoPath, prefix: "idem" });
    configureBeadsForRepo.mockClear();
    const second = await addProject({ repoPath, prefix: "idem" });

    expect(second.id).toBe(first.id);
    expect(configureBeadsForRepo).toHaveBeenCalledWith(resolve(repoPath), { prefix: "idem" });
  });
});
