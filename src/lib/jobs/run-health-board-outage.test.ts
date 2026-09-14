import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead, Gate } from "../beads/bd";
import { pinBoardMode, resetBoardModeCache } from "../beads/board-mode";
import { BoardUnreachableError } from "./errors";
import { getRunHealthReport } from "../run-health";
import { getJob, toMs, type Clock } from "./queue";
import { makeRunHealthHandler } from "./run-health";
import { driveJob } from "@/lib/testing/jobs";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const gateListMock = vi.fn<(cwd: string) => Promise<Gate[]>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      list: (...args: [string, string[]?]) => listMock(...args),
      gateList: (...args: [string]) => gateListMock(...args),
    },
  };
});

const NOW = 1_700_000_000_000;
const PROBE_MS = 30 * 60_000;
let now = NOW;
const clock: Clock = { now: () => now };
let t: TestProjectDb;

beforeEach(() => {
  now = NOW;
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" });
  gateListMock.mockResolvedValue([]);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
  resetBoardModeCache();
});

describe("run-health board outages", () => {
  it("persists one project outage and refunds the failed raw board read for a slow probe", async () => {
    // The bd process seam constructs this error from its non-zero output. The handler must retain it
    // after recording the outage, so the runner takes its refund-and-probe branch rather than retrying.
    listMock.mockRejectedValue(
      new BoardUnreachableError("Command failed: bd list --status all\nDolt server unreachable"),
    );

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });

    const job = await getJob(t.db, jobId);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(toMs(job?.runAt)).toBe(NOW + PROBE_MS);
    expect(job?.lastError).toContain("Dolt server unreachable");

    const report = await getRunHealthReport(t.db, t.projectId);
    expect(report?.findings).toEqual([
      expect.objectContaining({
        kind: "exhausted-job",
        key: "exhausted-job:board-unreachable:p1:server-unreachable",
        reason: expect.stringContaining("check the server is up and reachable"),
      }),
    ]);
  });

  it("preserves a continuing outage's first observation across failed probes", async () => {
    listMock.mockRejectedValue(
      new BoardUnreachableError("Command failed: bd list --status all\nDolt server unreachable"),
    );

    await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });
    now += PROBE_MS;
    await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });

    const [finding] = (await getRunHealthReport(t.db, t.projectId))?.findings ?? [];
    expect(finding).toMatchObject({ since: NOW, ageMs: PROBE_MS });
  });

  it("finds a board outage whose bd classifier text was written only to stdout", async () => {
    listMock.mockRejectedValue(
      Object.assign(new BoardUnreachableError("Command failed: bd list --status all\nstderr was empty"), {
        stdout: "Dolt server unreachable at board.example.test",
        stderr: "",
      }),
    );

    await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });

    const report = await getRunHealthReport(t.db, t.projectId);
    expect(report?.findings).toEqual([
      expect.objectContaining({
        kind: "exhausted-job",
        key: "exhausted-job:board-unreachable:p1:server-unreachable",
      }),
    ]);
  });

  it("persists an outage from the thrower's own boardCause when bd's text matches no known pattern", async () => {
    // The shared-server board-read preflight wraps its own contextual message around whatever bd
    // printed ("database not found", "permission denied", ...) — text `boardUnreachableCause` was
    // never going to recognize. Without an explicit `boardCause` this used to fall through and
    // rethrow instead of raising the outage report (PR #277 review).
    listMock.mockRejectedValue(
      new BoardUnreachableError(
        "shared Dolt server board.example.test accepted the connection but will not serve the board " +
          "for /tmp/p1. Underlying error: database not found",
        { boardCause: "database-unreadable" },
      ),
    );

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });

    const job = await getJob(t.db, jobId);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(toMs(job?.runAt)).toBe(NOW + PROBE_MS);

    const report = await getRunHealthReport(t.db, t.projectId);
    expect(report?.findings).toEqual([
      expect.objectContaining({
        kind: "exhausted-job",
        key: "exhausted-job:board-unreachable:p1:database-unreadable",
        reason: expect.stringContaining("its database account may read it"),
      }),
    ]);
  });

  it("does not turn an ordinary board error into an outage report", async () => {
    listMock.mockRejectedValue(new Error("bead not found"));

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { backoffBaseMs: 1_000 },
    });

    expect(await getRunHealthReport(t.db, t.projectId)).toBeUndefined();
    expect(await getJob(t.db, jobId)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("classifies a direct shared-server read failure as an outage even when bd's raw text matches no known pattern", async () => {
    // These two reads (beads.list/beads.gateList) bypass preflightSharedServer entirely, so bd's
    // transport-level diagnostic ("dial tcp ...: connect: connection refused") never goes through the
    // classifier that fixed the earlier preflight thread — it lands here as a PLAIN Error, not a
    // BoardUnreachableError. On a shared server this read boundary IS the board, so any failure here
    // must still raise the outage report rather than rethrow unclassified (PR #277 review).
    pinBoardMode("/tmp/p1", { mode: "server", host: "dolt.example.dev", port: 3306, database: "anton" });
    listMock.mockRejectedValue(new Error("dial tcp 10.0.0.9:3306: connect: connection refused"));

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "run-health",
      projectId: t.projectId,
      handler: (deps) => makeRunHealthHandler(deps),
      config: { boardUnreachableRetryMs: PROBE_MS },
    });

    const job = await getJob(t.db, jobId);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(toMs(job?.runAt)).toBe(NOW + PROBE_MS);

    const report = await getRunHealthReport(t.db, t.projectId);
    expect(report?.findings).toEqual([
      expect.objectContaining({
        kind: "exhausted-job",
        key: "exhausted-job:board-unreachable:p1:database-unreadable",
      }),
    ]);
  });
});
