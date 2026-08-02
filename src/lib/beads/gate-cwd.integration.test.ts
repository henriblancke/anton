/**
 * THE REGRESSION TEST THAT MUST NEVER BE DELETED (anton-uk95, proven in
 * .product/decisions/2026-07-28-bd-workflow-primitives.md §5).
 *
 * A `gh:run` / `gh:pr` gate is evaluated by a `gh` subprocess bd spawns, and `gh` resolves WHICH
 * REPOSITORY it is talking about from the process cwd. `bd -C <dir>` changes only which DATABASE bd
 * reads — it does not change the process cwd. So a gate call made from the wrong directory returns
 * another repository's CI verdict, silently, in both directions:
 *
 *   - **false green** — a green run in the foreign repo RESOLVES this repo's gate, letting a run
 *     advance past a check that never passed;
 *   - **false escalation** — a failed run in the foreign repo ESCALATES this repo's gate, failing a
 *     run whose CI is fine.
 *
 * Two real scratch boards, real `bd`, and a fake `gh` that answers per repository (so the suite is
 * hermetic and needs no network or GitHub auth). Each case asserts BOTH sides: the seam
 * (`beads.gate*`, cwd = the project repo) reaches the correct verdict, AND the forbidden `-C` form
 * fabricates the wrong one — because a negative assertion alone would still pass if the fake `gh`
 * had quietly stopped answering.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { beads, buildGateCheckArgs, parseGateCheck, runBdForTest } from "./bd";

/** Workflow run ids the fake `gh` knows. They exist ONLY in the foreign repo. */
const GREEN_RUN = "900001";
const RED_RUN = "900002";

/** The run `gh run list` offers to `bd gate discover` — again, only in the foreign repo. */
const DISCOVERABLE_RUN = 900003;

const HOME_SLUG = "acme/home";
const FOREIGN_SLUG = "other/foreign-ci";

let dir: string;
let foreign: BdRepo;
const boards: BdRepo[] = [];
let restoreEnv: () => void;

function setOrigin(repo: string, slug: string): void {
  execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:${slug}.git`], {
    stdio: "ignore",
  });
}

/** A fresh scratch board for one scenario, wired to the HOME GitHub repo. */
function newHomeBoard(): string {
  const board = makeBdRepo();
  boards.push(board);
  setOrigin(board.repo, HOME_SLUG);
  return board.repo;
}

/**
 * The FORBIDDEN form, run deliberately as the control: bd pointed at `home`'s database with `-C`,
 * from the foreign repo's cwd. This is what an unaware future edit would reach for in a
 * multi-worktree runtime, and what this suite exists to keep out of the seam.
 */
function bdFromForeignCwd(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("bd", args, {
    cwd: foreign.repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** A gate's current status, read straight off the board (closed ⇒ the gate resolved). */
async function gateStatus(repo: string, id: string): Promise<string | undefined> {
  const gates = await beads.gateList(repo, { all: true });
  return gates.find((g) => g.id === id)?.status;
}

/** Is the gated bead claimable again? The user-visible consequence of a gate closing. */
async function isReady(repo: string, id: string): Promise<boolean> {
  return (await beads.ready(repo)).some((b) => b.id === id);
}

/** A bead plus the `gh:run` gate blocking it, on `repo`. */
async function gatedBead(repo: string, awaitId: string): Promise<{ bead: string; gate: string }> {
  const bead = await beads.create(repo, { title: `step awaiting run ${awaitId}`, type: "task" });
  const gate = await beads.gateCreate(repo, { blocks: bead, type: "gh:run", awaitId });
  return { bead, gate };
}

describeBd("gate seam · the wrong-repo hazard (anton-uk95)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-gate-cwd-"));

    // The second board: a different anton project, pointing at a DIFFERENT GitHub repo.
    foreign = makeBdRepo();
    boards.push(foreign);
    setOrigin(foreign.repo, FOREIGN_SLUG);

    // A fake `gh` that answers per repository, exactly as the real one does: GH_REPO wins, else the
    // repo is resolved from the cwd's origin. The foreign repo has the runs; the home repo's CI is
    // still in flight, so from the CORRECT cwd nothing ever resolves and nothing ever escalates.
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
slug="$GH_REPO"
[ -z "$slug" ] && slug=$(git config --get remote.origin.url 2>/dev/null)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$1 $2" in
  "run view")
    case "$slug" in
      *foreign*)
        case "$3" in
          ${GREEN_RUN}) echo '{"status":"completed","conclusion":"success","name":"ci"}' ;;
          ${RED_RUN}) echo '{"status":"completed","conclusion":"failure","name":"ci"}' ;;
          *) echo '{"status":"in_progress","conclusion":"","name":"ci"}' ;;
        esac ;;
      *) echo '{"status":"in_progress","conclusion":"","name":"ci"}' ;;
    esac ;;
  "run list")
    case "$slug" in
      *foreign*)
        printf '[{"databaseId":${DISCOVERABLE_RUN},"displayTitle":"foreign work","headBranch":"main","headSha":"f0re19n","name":"ci","workflowName":"ci","status":"completed","conclusion":"success","url":"https://example.invalid/1","createdAt":"%s","updatedAt":"%s"}]' "$now" "$now" ;;
      *) echo '[]' ;;
    esac ;;
  *) echo '{}' ;;
esac
`,
      "utf8",
    );
    chmodSync(gh, 0o755);
    restoreEnv = saveEnv(["PATH"]);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });

  afterAll(() => {
    restoreEnv?.();
    for (const b of boards) b.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not fabricate a FALSE GREEN: a foreign repo's green run must not resolve this gate", async () => {
    const home = newHomeBoard();
    const { bead, gate } = await gatedBead(home, GREEN_RUN);

    // The seam: cwd = the project repo. Home's CI is still running, so there is no verdict yet.
    const seam = await beads.gateCheck(home, { scope: "gh:run" });
    expect(seam.resolved).toBe(0);
    expect(seam.errors).toBe(0);
    expect(await gateStatus(home, gate)).toBe("open");
    expect(await isReady(home, bead)).toBe(false);

    // cwd ALONE is what decides it — same database, same gate, no GH_REPO on either side.
    const cwdOnly = parseGateCheck(
      await runBdForTest(home, buildGateCheckArgs({ scope: "gh:run", dryRun: true })),
    );
    expect(cwdOnly.resolved).toBe(0);

    // The forbidden form, and the whole reason for this file: `-C` points bd's DATABASE at the home
    // board while `gh` keeps answering for the foreign repo — whose run 900001 is green.
    const hazard = parseGateCheck(
      bdFromForeignCwd(["-C", home, ...buildGateCheckArgs({ scope: "gh:run", dryRun: true })]),
    );
    expect(hazard.resolved).toBe(1);

    // …and run for real it LANDS: the gate closes and the blocked step goes ready on the strength of
    // another project's CI. This is the false green the seam's cwd rule prevents.
    bdFromForeignCwd(["-C", home, ...buildGateCheckArgs({ scope: "gh:run" })]);
    expect(await gateStatus(home, gate)).toBe("closed");
    expect(await isReady(home, bead)).toBe(true);
  });

  it("does not fabricate a FALSE ESCALATION: a foreign repo's failed run must not escalate this gate", async () => {
    const home = newHomeBoard();
    const { bead, gate } = await gatedBead(home, RED_RUN);

    const seam = await beads.gateCheck(home, { scope: "gh:run" });
    expect(seam.escalated).toBe(0);
    expect(seam.errors).toBe(0);
    expect(await gateStatus(home, gate)).toBe("open");
    expect(await isReady(home, bead)).toBe(false);

    // The mirror image of the false green: the same wrong cwd, a failed foreign run, and the gate is
    // reported failed — a run stopped by CI it does not own.
    const hazard = parseGateCheck(
      bdFromForeignCwd(["-C", home, ...buildGateCheckArgs({ scope: "gh:run" })]),
    );
    expect(hazard.escalated).toBe(1);
    expect(hazard.resolved).toBe(0);
  });

  it("GH_REPO overrides gh's resolution where a call site cannot control cwd", async () => {
    const home = newHomeBoard();
    const { gate } = await gatedBead(home, GREEN_RUN);

    // Same forbidden command, one environment variable apart.
    const unprotected = parseGateCheck(
      bdFromForeignCwd(["-C", home, ...buildGateCheckArgs({ scope: "gh:run", dryRun: true })]),
    );
    expect(unprotected.resolved).toBe(1);

    const protectedRun = parseGateCheck(
      bdFromForeignCwd(["-C", home, ...buildGateCheckArgs({ scope: "gh:run", dryRun: true })], {
        GH_REPO: HOME_SLUG,
      }),
    );
    expect(protectedRun.resolved).toBe(0);
    expect(await gateStatus(home, gate)).toBe("open");
  });

  it("covers `bd gate discover`, which draws its candidate runs from the same wrong repo", async () => {
    const home = newHomeBoard();
    // No await-id: this is the gate `discover` exists to fill in.
    const bead = await beads.create(home, { title: "step awaiting CI", type: "task" });
    const gate = await beads.gateCreate(home, { blocks: bead, type: "gh:run" });

    // The seam looks at the home repo's runs — there are none, so the gate stays unpinned.
    const seam = await beads.gateDiscover(home, { dryRun: true });
    expect(seam).not.toContain(String(DISCOVERABLE_RUN));
    expect(await gateStatus(home, gate)).toBe("open");

    // From the foreign cwd the candidate set is the FOREIGN repo's runs, and a real pass writes one
    // of them into this gate — after which every later check evaluates the wrong repo's workflow.
    const preview = bdFromForeignCwd(["-C", home, "gate", "discover", "--dry-run"]);
    expect(preview).toContain(String(DISCOVERABLE_RUN));

    bdFromForeignCwd(["-C", home, "gate", "discover"]);
    const written = (await beads.gateList(home, { all: true })).find((g) => g.id === gate);
    expect(written?.await_id).toBe(String(DISCOVERABLE_RUN));
  });

  it("uses `bd ready --gated` for gate-resume discovery — `bd mol ready --gated` is broken", () => {
    // Broken identically on bd 1.1.0 and 1.1.2, contradicting its own usage line. Pinned here so an
    // upstream fix is noticed rather than assumed, and so nobody "simplifies" the seam onto it.
    expect(() =>
      execFileSync("bd", ["mol", "ready", "--gated"], { cwd: foreign.repo, stdio: "pipe" }),
    ).toThrow(/unknown flag: --gated/);

    // The form the seam actually uses runs.
    expect(() =>
      execFileSync("bd", ["ready", "--gated", "--json"], { cwd: foreign.repo, stdio: "pipe" }),
    ).not.toThrow();
  });
});
