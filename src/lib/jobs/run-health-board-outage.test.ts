import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead, Gate } from "../beads/bd";
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
const clock: Clock = { now: () => NOW };
let t: TestProjectDb;

beforeEach(() => {
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" });
  gateListMock.mockResolvedValue([]);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
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
});
