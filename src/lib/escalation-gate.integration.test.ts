/**
 * Resolve-and-resume against a REAL bd gate (anton-mivh.3).
 *
 * The unit suite stubs `beads.gateResolve`, so it can prove the ORDER and the CAS but not the one
 * fact the whole verb rests on: what bd actually does when the founder's answer arrives twice, or
 * arrives after they already ran `bd gate resolve` themselves. Both are the ordinary case — a wait on
 * a person is settled by a person, who may well settle it somewhere else first — and both are
 * measured here rather than assumed. bd 1.1.2 resolves a closed gate idempotently (exit 0); if a
 * later bd stops doing that, this suite goes red instead of a founder's click 500ing.
 *
 * The RESUME is stubbed: `resumeStalledEpic` reaches the live runner, and enqueueing a real
 * execute-epic job would run an agent. What it is called with — once, with the run target — is the
 * assertion; the resume machinery itself is unstick.ts's own tests.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  describeBd,
  makeBdRepo,
  makeFileDb,
  type BdRepo,
  type FileDb,
} from "@/lib/testing/integration";
import type { RunHealthFinding } from "./run-health";
import type { Project } from "./types";

const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();

// The push itself is sync-nudge's own suite; stubbed here so the temp repo (which has no remote)
// isn't shelling `bd dolt sync` after every close. What this suite asserts is that it is asked for.
const nudgeSync = vi.fn<(project: Project, label?: string) => void>();
vi.mock("./beads/sync-nudge", () => ({
  nudgeSync: (...args: [Project, string?]) => nudgeSync(...args),
}));

vi.mock("./jobs/service", async () => {
  const { activeExecuteEpicId } =
    await vi.importActual<typeof import("./jobs/queue")>("./jobs/queue");
  const { getDb } = await import("./db");
  return {
    resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
    resumeJob: async () => true,
    cancelJob: async () => ({ ok: true }),
    runIsLiveForTarget: (projectId: string, epicBeadId: string) =>
      activeExecuteEpicId(getDb(), projectId, epicBeadId) !== undefined,
  };
});

describeBd("resolve-and-resume against a real human gate", () => {
  let bdRepo: BdRepo;
  let fileDb: FileDb;
  let project: Project;
  let getDb: typeof import("./db").getDb;
  let schema: typeof import("./db/schema");
  let raiseEscalation: typeof import("./escalations").raiseEscalation;
  let actOnEscalation: typeof import("./escalation-actions").actOnEscalation;
  let resetIssueSnapshots: typeof import("./beads/snapshot").resetIssueSnapshots;

  const HOUR = 3_600_000;
  const clock = { now: () => Date.now() };

  const bd = (args: string[]): string =>
    execFileSync("bd", args, { cwd: bdRepo.repo, encoding: "utf8" });

  /** The id of whatever `bd ... --json` just created — bd wraps a single bead in an array. */
  const createdId = (out: string): string => {
    const parsed = JSON.parse(out) as { id: string } | { id: string }[];
    return (Array.isArray(parsed) ? parsed[0]! : parsed).id;
  };

  const statusOf = (id: string): string =>
    (JSON.parse(bd(["show", id, "--json"])) as { status: string }[])[0]!.status;

  interface GatedWork {
    target: string;
    ticket: string;
    gate: string;
  }

  /** What `bd gate create --blocks <ticket>` leaves behind: a run target, its ticket, and the wait. */
  function seedGatedWork(): GatedWork {
    const target = createdId(bd(["create", "ship the thing", "--type", "feature", "--json"]));
    const ticket = createdId(
      bd(["create", "do the thing", "--type", "task", "--deps", `parent-child:${target}`, "--json"]),
    );
    const gate = createdId(
      bd([
        "gate",
        "create",
        "--blocks",
        ticket,
        "--type",
        "human",
        "--reason",
        "the founder wants to see the design first",
        "--json",
      ]),
    );
    resetIssueSnapshots(); // raw bd calls bypass the write-through invalidation
    return { target, ticket, gate };
  }

  async function raise(work: GatedWork) {
    const finding: RunHealthFinding = {
      kind: "needs-human",
      key: `needs-human:${work.gate}`,
      reason: "waiting on a human 3h: the founder wants to see the design first",
      since: Date.now() - 3 * HOUR,
      ageMs: 3 * HOUR,
      gateId: work.gate,
      beadId: work.ticket,
      targetBeadId: work.target,
    };
    const { escalation } = await raiseEscalation(getDb(), clock, {
      projectId: project.id,
      finding,
      epicBeadId: work.target,
    });
    return escalation;
  }

  const rowOf = (id: string) =>
    getDb().select().from(schema.escalations).where(eq(schema.escalations.id, id)).get();

  beforeAll(async () => {
    // MUST precede the getDb-touching imports: the db path is resolved at import time.
    fileDb = makeFileDb();
    bdRepo = makeBdRepo();
    ({ getDb } = await import("./db"));
    schema = await import("./db/schema");
    ({ raiseEscalation } = await import("./escalations"));
    ({ actOnEscalation } = await import("./escalation-actions"));
    ({ resetIssueSnapshots } = await import("./beads/snapshot"));

    project = {
      id: "p1",
      slug: "p1",
      name: "p1",
      repoPath: bdRepo.repo,
    } as Project;
    getDb()
      .insert(schema.projects)
      .values({ id: project.id, slug: project.slug, name: project.name, repoPath: project.repoPath })
      .run();
  });

  afterAll(() => {
    fileDb.cleanup();
    bdRepo.cleanup();
  });

  beforeEach(() => {
    getDb().delete(schema.escalations).run();
    vi.clearAllMocks();
    resumeStalledEpic.mockResolvedValue("enqueued");
  });

  it("closes the gate, settles the row, and resumes ONCE under a double-click", async () => {
    const work = seedGatedWork();
    const escalation = await raise(work);

    const [a, b] = await Promise.all([
      actOnEscalation(project, escalation.id, "resume"),
      actOnEscalation(project, escalation.id, "resume"),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(a.ok ? b : a).toEqual({ ok: false, reason: "not-open" });
    expect(statusOf(work.gate)).toBe("closed");
    expect(resumeStalledEpic.mock.calls).toEqual([[project.id, work.target]]);
    // The close is a board write like any other: the losing click pushes nothing, the winner must.
    expect(nudgeSync.mock.calls).toEqual([[project, "gate-resolve"]]);
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("settles cleanly on a gate the founder already resolved from the CLI", async () => {
    const work = seedGatedWork();
    const escalation = await raise(work);
    bd(["gate", "resolve", work.gate, "--reason", "did it myself"]);
    resetIssueSnapshots();

    // The whole point: doing the thing and THEN clicking is the normal way round, so it must not
    // read as a failure. bd 1.1.2 accepts the second resolve outright (exit 0).
    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({ ok: true });
    expect(statusOf(work.gate)).toBe("closed");
    expect(resumeStalledEpic).toHaveBeenCalledWith(project.id, work.target);
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("closes the answered gate but holds the resume while a second gate is still open", async () => {
    // The real shape of the bug this guards: two waits on one target raise two rows naming the SAME
    // run target, so answering one and resuming enqueues work execute-epic refuses at job start —
    // it re-reads the board, sees the other gate, and PARKS. The founder's answer still lands on the
    // gate they answered; the run is left to gate-check, which dispatches when the last one clears.
    const work = seedGatedWork();
    const second = createdId(
      bd([
        "gate",
        "create",
        "--blocks",
        work.ticket,
        "--type",
        "human",
        "--reason",
        "legal has to sign off too",
        "--json",
      ]),
    );
    resetIssueSnapshots();
    const escalation = await raise(work);

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(statusOf(work.gate)).toBe("closed");
    expect(statusOf(second)).not.toBe("closed");
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("leaves a resolve whose resume failed logged, and the work re-raisable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resumeStalledEpic.mockRejectedValue(new Error("runner refused: project is being deleted"));
    const work = seedGatedWork();
    const escalation = await raise(work);

    await expect(actOnEscalation(project, escalation.id, "resume")).rejects.toThrow(
      "runner refused",
    );

    // The row is spent, but nothing is stranded: the gate is closed over runnable work, which is
    // exactly what gate-check's `plainGateResumes` dispatches on its next pass.
    expect(statusOf(work.gate)).toBe("closed");
    expect(statusOf(work.ticket)).not.toBe("closed");
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
    expect(logged.mock.calls[0]?.[0]).toContain(escalation.id);
    logged.mockRestore();
  });
});
