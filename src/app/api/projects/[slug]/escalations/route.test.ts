/**
 * Route test for POST /api/projects/[slug]/escalations — the bulk dismissal (anton-7gxs).
 *
 * What is under test is the PER-ROW contract, because that is the whole reason this route is not
 * simply thirty calls to the single-row one: a group an operator selected can contain a row someone
 * else settled a second ago, or one whose kind cannot be dismissed at all, and failing all thirty
 * over either would make the button useless exactly when a storm makes it necessary.
 *
 * The real route → escalation-actions → db stack runs over one in-memory anton.db, so "it was
 * actually dismissed" is a real query, and the project scoping is enforced rather than asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { jsonRequest, paramsCtx } from "@/lib/testing/integration";
import type { RunHealthFinding } from "@/lib/run-health";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const { POST } = await import("./route");
const { raiseEscalation, settleEscalation } = await import("@/lib/escalations");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const clock = { now: () => NOW };

const ctx = (slug: string) => paramsCtx({ slug });
const req = (body?: unknown) => jsonRequest("POST", body);

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "exhausted-job",
    key: "exhausted-job:j-1",
    reason: "claude exited 1: API Error 503",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    jobId: "j-1",
    beadId: "anton-t9",
    ...o,
  };
}

/** One open escalation of a storm — `n` distinguishes the job, as a real burst would. */
async function open(n: number, o: Partial<RunHealthFinding> = {}, projectId = "p-alpha") {
  const { escalation } = await raiseEscalation(tdb.db, clock, {
    projectId,
    finding: finding({ key: `exhausted-job:j-${n}`, jobId: `j-${n}`, ...o }),
  });
  return escalation.id;
}

const rowOf = (id: string) =>
  tdb.db.select().from(schema.escalations).where(eq(schema.escalations.id, id)).get();

describe("POST /api/projects/[slug]/escalations", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(() => {
    tdb.db.delete(schema.escalations).run();
    tdb.db.delete(schema.projects).run();
    tdb.db.insert(schema.projects).values([
      { id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" },
      { id: "p-beta", slug: "beta", name: "Beta", repoPath: "/tmp/beta" },
    ]).run();
  });

  it("puts a whole storm down in one call, and stamps each row as a human dismissal", async () => {
    const ids = [await open(1), await open(2), await open(3)];

    const res = await POST(req({ action: "dismiss", ids }), ctx("alpha"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dismissed: number; escalations: unknown[] };
    expect(body.dismissed).toBe(3);
    // The panel re-renders from this rather than racing a refetch against the write.
    expect(body.escalations).toHaveLength(0);
    // The stamp, not just the status: it is what stops the next sweep raising these again.
    for (const id of ids) expect(rowOf(id)?.dismissedAt).not.toBeNull();
  });

  it("dismisses the rest when one row was already settled", async () => {
    const live = await open(1);
    const gone = await open(2);
    await settleEscalation(tdb.db, clock, gone, "resumed");

    const res = await POST(req({ action: "dismiss", ids: [live, gone] }), ctx("alpha"));
    const body = (await res.json()) as { dismissed: number; skipped: { reason: string }[] };
    expect(body.dismissed).toBe(1);
    expect(body.skipped).toEqual([{ id: gone, reason: "not-open" }]);
    expect(rowOf(live)?.dismissedAt).not.toBeNull();
  });

  it("skips a kind that cannot be dismissed rather than refusing the batch", async () => {
    const stall = await open(1);
    const gate = await open(2, { kind: "needs-human", key: "needs-human:g-1", gateId: "g-1" });

    const res = await POST(req({ action: "dismiss", ids: [stall, gate] }), ctx("alpha"));
    const body = (await res.json()) as { dismissed: number; skipped: { reason: string }[] };
    expect(body.dismissed).toBe(1);
    expect(body.skipped).toEqual([{ id: gate, reason: "not-dismissable" }]);
    // The gate is untouched: dismissing it would leave a person blocked with nothing saying so.
    expect(rowOf(gate)?.status).toBe("open");
  });

  it("cannot reach another project's escalations", async () => {
    const foreign = await open(1, {}, "p-beta");

    const res = await POST(req({ action: "dismiss", ids: [foreign] }), ctx("alpha"));
    const body = (await res.json()) as { dismissed: number; skipped: { reason: string }[] };
    expect(body.dismissed).toBe(0);
    expect(body.skipped).toEqual([{ id: foreign, reason: "not-found" }]);
    expect(rowOf(foreign)?.status).toBe("open");
  });

  it("404s for a slug that matches no project", async () => {
    const res = await POST(req({ action: "dismiss", ids: ["esc-1"] }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  describe("400 — the request itself is malformed", () => {
    it.each([
      ["a verb this route does not offer", { action: "resume", ids: ["esc-1"] }],
      ["a missing ids array", { action: "dismiss" }],
      ["ids that are not strings", { action: "dismiss", ids: [1, 2] }],
      ["an empty selection", { action: "dismiss", ids: [] }],
    ])("rejects %s", async (_case, body) => {
      const res = await POST(req(body), ctx("alpha"));
      expect(res.status).toBe(400);
    });

    // A cap, so a hand-rolled payload can't turn one request into an unbounded read loop.
    it("rejects a selection larger than a board could plausibly hold", async () => {
      const ids = Array.from({ length: 201 }, (_, i) => `esc-${i}`);
      const res = await POST(req({ action: "dismiss", ids }), ctx("alpha"));
      expect(res.status).toBe(400);
    });

    it("rejects a body that isn't JSON", async () => {
      const res = await POST(
        new Request("http://local/api", { method: "POST", body: "not json" }),
        ctx("alpha"),
      );
      expect(res.status).toBe(400);
    });
  });
});
