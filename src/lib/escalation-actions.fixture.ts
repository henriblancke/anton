/**
 * Shared fixture for the `escalation-actions.*.test.ts` suites — the founder's answers to an
 * escalation (anton-wvcy), over a real temp anton.db.
 *
 * The property under test is the ORDER: settle first, act second. `settleEscalation`'s status CAS is
 * the lock, so whoever flips `open → resolved` owns the decision — that is what makes a double-click
 * (or two operators on one board) resume the epic once rather than twice. The verbs themselves are
 * stubbed; that they are the SAME verbs the automatic path uses is a wiring fact, asserted by each
 * suite by checking each is called with the right target.
 *
 * The cases are split by the ANSWER they exercise (verbs, a job-only stall, contested work, a wait on
 * a person), and every split file gets its sandbox from here: the module mocks, the temp db lifecycle,
 * and the row/board builders. Importing this file registers the mocks and the lifecycle hooks — that
 * is the whole setup a suite needs.
 *
 * Test-only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeFileDb, type FileDb } from "@/lib/testing/integration";
import { LABELS, type Bead } from "./beads/bd";
import type { EscalationFinding } from "./escalations";
import type { RunHealthFinding } from "./run-health";
import type { Project } from "./types";

export const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();
export const abandonTicket =
  vi.fn<
    (
      project: Project,
      id: string,
      reason: string,
      opts?: { requireStopped?: boolean; ownRunId?: string },
    ) => Promise<unknown>
  >();
export const resumeJob = vi.fn<(projectId: string, jobId: string) => Promise<boolean>>();
export const cancelJob =
  vi.fn<
    (projectId: string, jobId: string, only?: readonly string[]) => Promise<{ ok: boolean }>
  >();

vi.mock("./jobs/service", async () => {
  // The liveness read stays REAL against the temp db — the seeded job rows are the whole point of
  // the abandon guard's tests; only the verbs it gates are stubbed.
  const { activeExecuteEpicId } =
    await vi.importActual<typeof import("./jobs/queue")>("./jobs/queue");
  const { getDb: db } = await import("./db");
  return {
    resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
    resumeJob: (...args: [string, string]) => resumeJob(...args),
    cancelJob: (...args: [string, string, (readonly string[])?]) => cancelJob(...args),
    runIsLiveForTarget: (projectId: string, epicBeadId: string) =>
      activeExecuteEpicId(db(), projectId, epicBeadId) !== undefined,
  };
});
vi.mock("./abandon", async () => {
  const actual = await vi.importActual<typeof import("./abandon")>("./abandon");
  return {
    ...actual,
    abandonTicket: (...args: Parameters<typeof actual.abandonTicket>) => abandonTicket(...args),
  };
});

// The cross-machine half: the pre-settle re-check pulls the shared board and reads the epic's
// run-lease. Stubbed so the lease is the only variable — the real lease parsing is bd.test.ts's job.
export const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
export const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead>>();
export const gateResolve = vi.fn<(repoPath: string, id: string, reason?: string) => Promise<string>>();
export const beadsTag = vi.fn<(repoPath: string, id: string, labels: string[]) => Promise<unknown>>();
vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...args: [string]) => beadsPull(...args),
      show: (...args: [string, string]) => beadsShow(...args),
      gateResolve: (...args: [string, string, string?]) => gateResolve(...args),
      tag: (...args: [string, string, string[]]) => beadsTag(...args),
    },
  };
});

// The ownership half of the dispatch rule reads this machine's identity; pinned so a test box's git
// config can't decide whether a claimed target is "ours".
vi.mock("./operator", () => ({
  resolveOperator: async () => "alice",
  resetOperatorCache: () => {},
}));

// The blocker re-check a resolve-and-resume runs before it re-queues anything reads the whole board.
// Stubbed to a board where the gate just closed was the last thing holding the target, so each test
// that cares states its own answer.
export const loadAllIssues = vi.fn<(repo: string, opts?: { strictGates?: boolean }) => Promise<Bead[]>>();
vi.mock("./beads/issues", async () => {
  const actual = await vi.importActual<typeof import("./beads/issues")>("./beads/issues");
  return {
    ...actual,
    loadAllIssues: (...args: [string, { strictGates?: boolean }?]) => loadAllIssues(...args),
  };
});

// Closing a gate is a board write, so it must reach teammates like every other one (anton-nowq).
export const nudgeSync = vi.fn<(project: Project, label?: string) => void>();
vi.mock("./beads/sync-nudge", () => ({
  nudgeSync: (...args: [Project, string?]) => nudgeSync(...args),
}));

let fileDb: FileDb;
export let actOnEscalation: typeof import("./escalation-actions").actOnEscalation;
export let isEscalationAction: typeof import("./escalation-actions").isEscalationAction;
export let getDb: typeof import("./db").getDb;
export let schema: typeof import("./db/schema");
let raiseEscalation: typeof import("./escalations").raiseEscalation;
export let settleEscalation: typeof import("./escalations").settleEscalation;
export let RunRestartedError: typeof import("./abandon").RunRestartedError;

export const NOW = 1_700_000_000_000;
export const HOUR = 3_600_000;
export const clock = { now: () => NOW };

export const project = { id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" } as Project;

beforeAll(async () => {
  // MUST precede the getDb-touching imports: the db path is resolved at import time.
  fileDb = makeFileDb();
  ({ getDb } = await import("./db"));
  schema = await import("./db/schema");
  ({ raiseEscalation, settleEscalation } = await import("./escalations"));
  ({ RunRestartedError } = await import("./abandon"));
  ({ actOnEscalation, isEscalationAction } = await import("./escalation-actions"));
});

afterAll(() => fileDb.cleanup());

beforeEach(() => {
  getDb().delete(schema.escalations).run();
  getDb().delete(schema.jobs).run();
  getDb().delete(schema.runs).run();
  getDb().delete(schema.projects).run();
  getDb()
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" })
    .run();
  resumeStalledEpic.mockResolvedValue("enqueued");
  abandonTicket.mockResolvedValue(undefined);
  resumeJob.mockResolvedValue(true);
  cancelJob.mockResolvedValue({ ok: true });
  beadsPull.mockResolvedValue(undefined);
  beadsShow.mockResolvedValue(bead());
  gateResolve.mockResolvedValue("✓ Gate resolved");
  beadsTag.mockResolvedValue(undefined);
  loadAllIssues.mockResolvedValue([bead()]);
});

/**
 * The epic bead the re-check reads the run-lease off; no run-lease label means nobody is running it.
 * Approved by default because that is what a run target anton would dispatch looks like — the gate
 * resume applies the automatic path's full dispatch rule, which refuses unapproved work.
 */
export function bead(labels: string[] = [LABELS.approved]): Bead {
  return { id: "anton-e1", title: "epic", status: "open", labels } as Bead;
}

afterEach(() => vi.clearAllMocks());

export function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "parked 4h ago: agent exited 1",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId: "r-1",
    beadId: "anton-t9",
    ...o,
  };
}

export async function open(o: { finding?: EscalationFinding; epicBeadId?: string } = {}) {
  const { escalation } = await raiseEscalation(getDb(), clock, {
    projectId: "p1",
    finding: o.finding ?? finding(),
    epicBeadId: "epicBeadId" in o ? o.epicBeadId : "anton-e1",
  });
  return escalation;
}

/** A real job row, so the refused-cancel path can read the status it reports back to the operator. */
export function seedJob(id: string, status: string): void {
  getDb()
    .insert(schema.jobs)
    .values({ id, type: "sync-push", projectId: "p1", status })
    .run();
}

/** An ACTIVE execute-epic job for the escalation's epic — what a local resume leaves behind. */
export function seedExecuteEpicJob(status: string): void {
  getDb()
    .insert(schema.jobs)
    .values({
      id: "j-epic",
      type: "execute-epic",
      projectId: "p1",
      status,
      payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "anton-e1" }),
    })
    .run();
}

/** The run a `parked-run` escalation was raised against — real, because abandon settles it. */
export function seedParkedRun(id: string, status = "parked"): void {
  getDb()
    .insert(schema.runs)
    .values({ id, projectId: "p1", epicBeadId: "anton-e1", status, error: "agent exited 1" })
    .run();
}

export const rowOf = (id: string) =>
  getDb().select().from(schema.escalations).where(eq(schema.escalations.id, id)).get();

export const runOf = (id: string) =>
  getDb().select().from(schema.runs).where(eq(schema.runs.id, id)).get();

/*
 * The builders for the one stall that is stuck BY DESIGN — a wait on a person. Its answer is not
 * really about the run: the wait hangs on a gate, and nothing in anton ever closes a human one — so
 * every answer to it has to close the gate, or the sweep raises the same row again forever.
 */
export const gateFinding = (o: Partial<RunHealthFinding> = {}) =>
  finding({
    kind: "needs-human",
    key: "needs-human:g-1",
    reason: "waiting on a human 3h: the founder wants to see the design first",
    runId: undefined,
    beadId: "anton-t9",
    gateId: "g-1",
    targetBeadId: "anton-e1",
    ...o,
  });

export const openGateWait = (o: { epicBeadId?: string } = { epicBeadId: "anton-e1" }) =>
  open({ finding: gateFinding(), ...o });

/** bd's answer per bead, so a gate read can differ from the run target's lease read. */
export function showsGateAs(gate: Bead | Error) {
  beadsShow.mockImplementation(async (_repo, id) => {
    if (id !== "g-1") return bead();
    if (gate instanceof Error) throw gate;
    return gate;
  });
}

export const closedGate = () => ({ id: "g-1", title: "Gate: human", status: "closed" }) as Bead;

/**
 * The board after the gated ticket was reparented — a supported move (the gardener, `beads.reparent`)
 * that the escalation's frozen `epicBeadId` cannot follow. The gate's own `blocks` edge stays on the
 * ticket, so the run target above it is the only live answer to "what does closing this release?".
 */
export function reparentedBoard(newHome: Partial<Bead> = {}): Bead[] {
  return [
    {
      id: "anton-t9",
      title: "ticket",
      status: "open",
      issue_type: "task",
      parent: "anton-e2",
      dependencies: [{ issue_id: "anton-t9", depends_on_id: "g-1", type: "blocks" }],
    } as Bead,
    {
      id: "anton-e2",
      title: "its new home",
      status: "open",
      issue_type: "feature",
      labels: [LABELS.approved],
      ...newHome,
    } as Bead,
    { id: "g-1", title: "Gate: human", issue_type: "gate", status: "closed" } as Bead,
    bead(),
  ];
}
