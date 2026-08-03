/**
 * Route test for POST /api/projects/[slug]/escalations/[escalationId] — the only surface that
 * settles a stalled run. What is under test is the STATUS MAPPING and the response body: the
 * handler folds seven distinct outcomes onto 400/404/409/500, and a wrong one either strands a
 * stall on the panel forever or hides a contested abandon behind a generic 500.
 *
 * The real service → escalation-actions → db stack runs over one in-memory anton.db, so the
 * project scoping assertion is a real query rather than a mocked call. Only the leaves that shell
 * out or execute work are stubbed — `bd` (pull/show, the cross-machine re-check) and the verbs
 * themselves — which is exactly the boundary src/lib/escalation-actions.test.ts already covers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { jsonRequest, paramsCtx } from "@/lib/testing/integration";
import { LABELS, type Bead } from "@/lib/beads/bd";
import { NotAbandonableError } from "@/lib/abandon";
import type { RunHealthFinding } from "@/lib/run-health";

// One db for the whole file: every layer below the route reaches it through the getDb() singleton.
let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// service.ts imports the sync engine only to start it in startRunner(); no path here does.
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();
const resumeJob = vi.fn<(projectId: string, jobId: string) => Promise<boolean>>();
const cancelJob =
  vi.fn<(projectId: string, jobId: string, only?: readonly string[]) => Promise<{ ok: boolean }>>();
const abandonTicket = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("@/lib/jobs/service", async () => {
  // `runIsLiveForTarget` stays REAL — it reads the seeded job rows off the same test db, so the
  // abandon guard is exercised rather than assumed. Only the verbs that do work are stubbed.
  const actual = await vi.importActual<typeof import("@/lib/jobs/service")>("@/lib/jobs/service");
  return {
    ...actual,
    resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
    resumeJob: (...args: [string, string]) => resumeJob(...args),
    cancelJob: (...args: [string, string, (readonly string[])?]) => cancelJob(...args),
  };
});
vi.mock("@/lib/abandon", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abandon")>("@/lib/abandon");
  return { ...actual, abandonTicket: (...args: unknown[]) => abandonTicket(...args) };
});

// The cross-machine re-check: stubbed so the board's answer is the only variable here.
const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead>>();
vi.mock("@/lib/beads/bd", async () => {
  const actual = await vi.importActual<typeof import("@/lib/beads/bd")>("@/lib/beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...args: [string]) => beadsPull(...args),
      show: (...args: [string, string]) => beadsShow(...args),
    },
  };
});

const { POST } = await import("./route");
const { raiseEscalation, settleEscalation } = await import("@/lib/escalations");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const clock = { now: () => NOW };

const ctx = (slug: string, escalationId: string) => paramsCtx({ slug, escalationId });
const req = (body?: unknown) => jsonRequest("POST", body);

/** The route's own copy for each refusal — the contract the panel renders verbatim. */
const MESSAGES = {
  notFound: "Escalation not found",
  notOpen: "This escalation has already been settled",
  noTarget: "This escalation names no ticket or job to act on",
  contested:
    "Another machine has picked this work back up — it is running again, so nothing was changed",
  unverified:
    "anton could not read the shared board, so it can't rule out another machine running this work — nothing was changed. Try again once bd can reach the remote",
} as const;

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
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

/** Raise one open escalation, returning its id. */
async function open(
  o: { projectId?: string; finding?: RunHealthFinding; epicBeadId?: string } = {},
): Promise<string> {
  const { escalation } = await raiseEscalation(tdb.db, clock, {
    projectId: o.projectId ?? "p-alpha",
    finding: o.finding ?? finding(),
    epicBeadId: "epicBeadId" in o ? o.epicBeadId : "anton-e1",
  });
  return escalation.id;
}

const rowOf = (id: string) =>
  tdb.db.select().from(schema.escalations).where(eq(schema.escalations.id, id)).get();

/** An epic bead as bd answers for it — unlabelled means nobody holds a run-lease on it. */
const bead = (labels: string[] = []): Bead =>
  ({ id: "anton-e1", title: "epic", status: "open", labels }) as Bead;

describe("POST /api/projects/[slug]/escalations/[escalationId]", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(async () => {
    tdb.db.delete(schema.escalations).run();
    tdb.db.delete(schema.jobs).run();
    tdb.db.delete(schema.runs).run();
    tdb.db.delete(schema.projects).run();
    tdb.db.insert(schema.projects).values([
      { id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" },
      { id: "p-beta", slug: "beta", name: "Beta", repoPath: "/tmp/beta" },
    ]).run();
    resumeStalledEpic.mockResolvedValue("enqueued");
    resumeJob.mockResolvedValue(true);
    cancelJob.mockResolvedValue({ ok: true });
    abandonTicket.mockResolvedValue(undefined);
    beadsPull.mockResolvedValue(undefined);
    beadsShow.mockResolvedValue(bead());
  });

  afterEach(() => vi.clearAllMocks());

  describe("200 — the settle answers with the panel's next state", () => {
    it("returns the action, its detail, and the STILL-OPEN escalations read after the write", async () => {
      const settled = await open();
      const other = await open({
        finding: finding({ key: "parked-run:r-2", runId: "r-2", beadId: "anton-t8" }),
      });

      const res = await POST(req({ action: "resume" }), ctx("alpha", settled));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ action: "resume", detail: "enqueued" });
      // The panel re-renders from this list, so it must not still carry the row just settled.
      expect(body.escalations.map((e: { id: string }) => e.id)).toEqual([other]);
      expect(resumeStalledEpic).toHaveBeenCalledWith("p-alpha", "anton-e1");
      expect(rowOf(settled)).toMatchObject({ status: "resolved", resolution: "resumed" });
    });

    it("carries an abandon's own detail through", async () => {
      const id = await open();

      const res = await POST(req({ action: "abandon" }), ctx("alpha", id));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ action: "abandon", detail: "abandoned" });
      expect(abandonTicket).toHaveBeenCalled();
    });

    it("dismisses without consulting the board at all", async () => {
      const id = await open();

      const res = await POST(req({ action: "dismiss" }), ctx("alpha", id));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ action: "dismiss", detail: "dismissed", escalations: [] });
      expect(beadsShow).not.toHaveBeenCalled();
    });
  });

  describe("400 — the request itself is malformed", () => {
    it("rejects a request with no body at all", async () => {
      const id = await open();
      const res = await POST(req(), ctx("alpha", id));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
    });

    it("rejects a body that is not JSON", async () => {
      const id = await open();
      const res = await POST(
        new Request("http://t/", { method: "POST", body: "resume" }),
        ctx("alpha", id),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
    });

    it.each([
      ["a missing action key", {}],
      ["a verb the panel does not offer", { action: "retry" }],
      ["a null action", { action: null }],
      ["a non-string action", { action: 1 }],
      ["an empty action", { action: "" }],
    ])("rejects %s", async (_label, body) => {
      const id = await open();
      const res = await POST(req(body), ctx("alpha", id));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('action must be "resume", "abandon", or "dismiss"');
      // A rejected request must not have settled anything on its way to the 400.
      expect(rowOf(id)?.status).toBe("open");
    });
  });

  describe("404 — nothing to settle", () => {
    it("answers not-found for an unknown escalation id", async () => {
      const res = await POST(req({ action: "resume" }), ctx("alpha", "no-such-escalation"));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe(MESSAGES.notFound);
    });

    it("answers not-found for an unknown project slug", async () => {
      const id = await open();
      const res = await POST(req({ action: "resume" }), ctx("nope", id));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Project not found");
      expect(rowOf(id)?.status).toBe("open");
    });

    // Scoping is the guarantee that makes the id in the URL safe: it is only ever resolved WITHIN
    // the project the slug names, so a valid id under another project is simply not found.
    it("cannot settle another project's escalation through this project's slug", async () => {
      const foreign = await open({ projectId: "p-beta" });

      const res = await POST(req({ action: "abandon" }), ctx("alpha", foreign));

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe(MESSAGES.notFound);
      expect(rowOf(foreign)?.status).toBe("open");
      expect(abandonTicket).not.toHaveBeenCalled();
    });
  });

  describe("409 — the request was valid, the state refuses it", () => {
    it("reports an escalation someone already settled", async () => {
      const id = await open();
      await settleEscalation(tdb.db, clock, id, "dismissed");

      const res = await POST(req({ action: "resume" }), ctx("alpha", id));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(MESSAGES.notOpen);
      expect(resumeStalledEpic).not.toHaveBeenCalled();
    });

    it("reports a finding that names neither a bead nor a job", async () => {
      const id = await open({
        finding: finding({ beadId: undefined, runId: undefined }),
        epicBeadId: undefined,
      });

      const res = await POST(req({ action: "resume" }), ctx("alpha", id));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(MESSAGES.noTarget);
      expect(rowOf(id)?.status).toBe("open");
    });

    it("reports work another machine has picked back up", async () => {
      beadsShow.mockResolvedValue(bead([LABELS.runLease(Date.now() + HOUR, "run-elsewhere")]));
      const id = await open();

      const res = await POST(req({ action: "abandon" }), ctx("alpha", id));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(MESSAGES.contested);
      expect(abandonTicket).not.toHaveBeenCalled();
      // Unsettled, so the row stays on the panel for the next sweep to re-judge.
      expect(rowOf(id)?.status).toBe("open");
    });

    it("reports a board bd could not read, rather than acting on an unproven snapshot", async () => {
      beadsShow.mockRejectedValue(new Error("bd: database is locked"));
      const id = await open();

      const res = await POST(req({ action: "resume" }), ctx("alpha", id));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(MESSAGES.unverified);
      expect(rowOf(id)?.status).toBe("open");
    });

    // The abandon's own boundary check throws rather than returning a reason, and it carries the
    // only copy that says WHICH ticket refused — so the route must surface the error's own message.
    it("surfaces a NotAbandonableError's own message", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      abandonTicket.mockRejectedValue(new NotAbandonableError("Ticket anton-t9 is already closed"));
      const id = await open();

      const res = await POST(req({ action: "abandon" }), ctx("alpha", id));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("Ticket anton-t9 is already closed");
      logged.mockRestore();
    });
  });

  describe("500 — the action failed after the settle", () => {
    it("answers with the failure's own message", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      resumeStalledEpic.mockRejectedValue(new Error("runner refused: project is being deleted"));
      const id = await open();

      const res = await POST(req({ action: "resume" }), ctx("alpha", id));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("runner refused: project is being deleted");
      // The CAS already claimed the decision; the stall returns via the next run-health sweep.
      expect(rowOf(id)).toMatchObject({ status: "resolved", resolution: "resumed" });
      logged.mockRestore();
    });

    it("falls back to a generic message when the throw carries none", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      resumeStalledEpic.mockRejectedValue("runner exploded");
      const id = await open();

      const res = await POST(req({ action: "resume" }), ctx("alpha", id));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Failed to settle the escalation");
      logged.mockRestore();
    });
  });
});
