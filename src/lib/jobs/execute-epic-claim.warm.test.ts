/**
 * anton-743gk — {@link warmRunWorktree} is the one warm call site a real run reaches, so it is what
 * makes a project's own warm setting take effect (anton-z5li2). Driven end-to-end rather than by
 * asserting on the argument: the project's command runs for real inside the checkout and leaves a
 * marker, which is the only evidence that every rung between the setting and the child process —
 * `resolveWarmConfig`, `warmWorktreeBestEffort`, `resolveWarmCommand` — is actually wired up.
 *
 * A pinned project command deliberately outranks the VITEST short-circuit (rung 3 vs rung 5 of
 * `resolveWarmCommand`'s ladder), which is exactly what lets these run a harmless `sh` line instead
 * of a real package manager.
 *
 * Mocked at the git seam only: the checkout is a real temp directory, so the warm has somewhere to
 * write, while branch creation and fork resolution stay stubbed.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { WARM_COMMAND_ENV } from "../git/worktree";
import type { Bead } from "../beads/bd";
import type { ProjectSettings } from "../projects";

const createWorktreeMock = vi.fn();
vi.mock("../git/worktree", async () => {
  const actual = await vi.importActual<typeof import("../git/worktree")>("../git/worktree");
  return {
    ...actual,
    acquireWorktreeClaim: vi.fn(async () => {}),
    releaseWorktreeClaim: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => ({ removed: true, branchDeleted: true })),
    createWorktree: (...a: unknown[]) => createWorktreeMock(...a),
    branchExists: vi.fn(async () => true),
  };
});

vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    resolveFreshBase: vi.fn(async () => ({ ref: "origin/main", baseIsAuthoritative: true })),
    resolveForkPoint: vi.fn(async () => "f0f0f0forkcommit"),
    isAncestor: vi.fn(async () => true),
    git: vi.fn(async () => ""),
  };
});

const updateRunMock = vi.fn();
vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...a: unknown[]) => updateRunMock(...a) };
});

const { warmRunWorktree } = await import("./execute-epic-claim");
const actualRuns = await vi.importActual<typeof import("../runs")>("../runs");
import type { EpicRun } from "./execute-epic-run";
import type { Clock } from "./queue";

let t: TestDb;
let checkout: string;
let marker: string;
const PROJECT = "p1";
const RUN_ID = "run-1";
const EPIC = "anton-abc";
const BRANCH = "anton/anton-abc";
const clock: Clock = { now: () => 1_800_000_000_000 };

/** Writes {@link marker} so a warm that actually ran is distinguishable from one that was skipped. */
function markerCommand(prefix = ""): string {
  return `${prefix}printf ok > ${marker}`;
}

function makeRun(settings: ProjectSettings, signal?: AbortSignal): EpicRun {
  return {
    db: t.db,
    clock,
    ctx: {
      signal: signal ?? new AbortController().signal,
      heartbeat: vi.fn(async () => {}),
      report: vi.fn(),
      attempt: 1,
    },
    projectId: PROJECT,
    repo: "/repo",
    runId: RUN_ID,
    branch: BRANCH,
    targetId: EPIC,
    project: { defaultBranch: "main" },
    settings,
    lease: { assertHeld: () => {} },
    target: { id: EPIC, title: EPIC } as Bead,
    tickets: [],
  } as unknown as EpicRun;
}

beforeEach(async () => {
  t = makeTestDb();
  await t.db.insert(schema.projects).values({ id: PROJECT, slug: "p1", name: "P1", repoPath: "/repo" });
  await actualRuns.createRun(t.db, clock, { id: RUN_ID, projectId: PROJECT, epicBeadId: EPIC });
  checkout = mkdtempSync(join(tmpdir(), "anton-warm-"));
  marker = join(checkout, "warmed");
  createWorktreeMock.mockReset().mockResolvedValue({
    path: checkout,
    branch: BRANCH,
    baseBranch: "origin/main",
    createdBranch: true,
    forkSha: "f0f0f0forkcommit",
    repoPath: "/repo",
  });
  updateRunMock.mockReset().mockImplementation(actualRuns.updateRun);
});
afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
  delete process.env[WARM_COMMAND_ENV];
  t.close();
});

it("runs the project's own warm command inside the run's checkout", async () => {
  await warmRunWorktree(makeRun({ warmCommand: markerCommand() }));

  expect(existsSync(marker)).toBe(true);
});

// The project setting outranks the machine-wide pin (rung 3 over rung 4) — a run on a machine with
// ANTON_WARM_COMMAND set must still get the project's command, not the machine's.
it("prefers the project's command over ANTON_WARM_COMMAND", async () => {
  process.env[WARM_COMMAND_ENV] = `printf env > ${join(checkout, "env-warmed")}`;

  await warmRunWorktree(makeRun({ warmCommand: markerCommand() }));

  expect(existsSync(marker)).toBe(true);
  expect(existsSync(join(checkout, "env-warmed"))).toBe(false);
});

// Turning warming off is a skip at the project rung, above both pins — nothing must run at all.
it("performs no warm when the project turned warming off", async () => {
  process.env[WARM_COMMAND_ENV] = markerCommand();

  await warmRunWorktree(makeRun({ warmCommand: markerCommand(), warmEnabled: false }));

  expect(existsSync(marker)).toBe(false);
});

// Absent settings keep every project that predates the setting warming exactly as before: no
// project command, so the VITEST guard (rung 5) short-circuits ahead of lockfile detection.
it("leaves a project with no warm settings on the env/lockfile rungs", async () => {
  process.env[WARM_COMMAND_ENV] = markerCommand();

  await warmRunWorktree(makeRun({}));

  expect(existsSync(marker)).toBe(true);
});

// anton-s55u (PR #279 review, P1): the warm is deferred until the refresh boundary is durable, so a
// process killed mid-warm can never leave a mutated branch with no record of what it was moved onto.
it("warms only after the refresh boundary is persisted", async () => {
  const warmedAtPersist: boolean[] = [];
  updateRunMock.mockImplementation(async (...a: unknown[]) => {
    warmedAtPersist.push(existsSync(marker));
    return (actualRuns.updateRun as (...args: unknown[]) => Promise<unknown>)(...a);
  });

  await warmRunWorktree(makeRun({ warmCommand: markerCommand() }));

  expect(warmedAtPersist.length).toBeGreaterThan(0);
  expect(warmedAtPersist).not.toContain(true);
  expect(existsSync(marker)).toBe(true);
});

// An operator's kill must not be stuck behind the 10-minute warm timeout: the abort degrades into
// the logged, non-fatal path, exactly like a registry timeout would.
it("lets the run's abort signal interrupt the warm", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const aborted = AbortSignal.abort();
  try {
    await warmRunWorktree(makeRun({ warmCommand: markerCommand("sleep 30; ") }, aborted));
  } finally {
    warn.mockRestore();
  }

  expect(existsSync(marker)).toBe(false);
});
