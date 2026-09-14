/**
 * THE REGRESSION TEST FOR CROSS-PROJECT ENV LEAKAGE (anton-ffmw.1).
 *
 * anton is one process driving many projects' boards, and `BEADS_DOLT_*` is bd's highest-priority
 * config source. Launched from a directory whose `.envrc` exported project A's server settings,
 * every bd call anton made for project B inherited them and dialled A's database instead of reading
 * B's own. In production bd's project-identity guard caught the collision:
 *
 *   PROJECT IDENTITY MISMATCH — refusing to connect
 *
 * That guard is the lucky case. Measured against bd 1.1.2 here, the same leak pointed at a database
 * that simply is not there answers **exit 0 with an empty board** — no error, no guard, just project
 * B reported as having no work. An orchestrator reading that claims nothing and runs its hygiene
 * against a phantom.
 *
 * Two real scratch boards and real `bd`: the bug lives entirely in what a SPAWNED process inherits,
 * which a mocked exec cannot express. Both halves are asserted — the seam reads B's own board with
 * A's settings ambient, AND the unscoped spawn (the parent env wholesale, what `bd.ts` used to pass)
 * reports B as empty. Without that second half the suite would still pass if the leak had merely
 * changed shape.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { resetBoardModeCache } from "./board-mode";

/**
 * anton's own environment, as an `.envrc` in project A's directory really exports it. The port is
 * one nothing listens on: the point is WHERE bd is sent, and depending on a reachable server would
 * make this test depend on infrastructure it does not need.
 */
const PROJECT_A_ENV: Record<string, string> = {
  BEADS_DOLT_SERVER_MODE: "true",
  BEADS_DOLT_SERVER_HOST: "127.0.0.1",
  BEADS_DOLT_SERVER_PORT: "3399",
  BEADS_DOLT_SERVER_USER: "project_a",
  BEADS_DOLT_SERVER_DATABASE: "project_a",
};

let projectA: BdRepo;
let projectB: BdRepo;
let beadInA: string;
let beadInB: string;
let restoreEnv: () => void;

/** bd run the way `bd.ts` used to run it: the parent's environment, wholesale. */
function bdWithInheritedEnv(cwd: string): string {
  return execFileSync("bd", ["list", "--json", "--limit", "0"], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

describeBd("a bd spawn is scoped to its own project (anton-ffmw.1)", () => {
  beforeAll(async () => {
    projectA = makeBdRepo();
    projectB = makeBdRepo();
    // Created BEFORE the leak is installed, so both boards genuinely hold work — asserting that B
    // is non-empty would otherwise prove nothing.
    beadInA = await beads.create(projectA.repo, { title: "belongs to project A", type: "task" });
    beadInB = await beads.create(projectB.repo, { title: "belongs to project B", type: "task" });

    restoreEnv = saveEnv(Object.keys(PROJECT_A_ENV));
    Object.assign(process.env, PROJECT_A_ENV);
    resetBoardModeCache();
  });

  afterAll(() => {
    restoreEnv?.();
    resetBoardModeCache();
    projectA?.cleanup();
    projectB?.cleanup();
  });

  it("reads project B's own board through the seam, with project A's settings ambient", async () => {
    const ids = (await beads.list(projectB.repo)).map((b) => b.id);
    expect(ids).toContain(beadInB);
    expect(ids).not.toContain(beadInA);
  });

  it("still reads project A's own board correctly", async () => {
    const ids = (await beads.list(projectA.repo)).map((b) => b.id);
    expect(ids).toContain(beadInA);
    expect(ids).not.toContain(beadInB);
  });

  // The control, and the reason cwd correctness is not enough on its own: the cwd IS project B's
  // here, and the answer is still wrong, because the inherited env outranks B's metadata.json.
  it("reports project B as an empty board when the parent environment is inherited wholesale", () => {
    let leaked: string;
    try {
      leaked = bdWithInheritedEnv(projectB.repo);
    } catch (e) {
      // The luckier shape of the same leak: bd's identity guard refuses outright. Either way the
      // unscoped spawn does not answer with B's board.
      expect(String((e as Error & { stderr?: string }).stderr ?? e)).toMatch(/PROJECT IDENTITY/i);
      return;
    }
    expect(JSON.parse(leaked)).toEqual([]);
  });
});
