/**
 * The re-arm route (anton-5c8h), against a real in-memory anton.db.
 *
 * The property under test is the one the button cannot prove on its own: the ACTOR on the record is
 * the server's resolved operator identity, never anything the caller supplied. A frozen policy being
 * lifted is the most consequential write on the board, and a caller-authored audit trail is worth
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { disarmAutopilot } from "@/lib/autopilot-disarm";
import { systemClock } from "@/lib/jobs/queue";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const operator = vi.fn<() => Promise<string | undefined>>();
vi.mock("@/lib/operator", () => ({ resolveOperator: () => operator() }));

const { POST } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = () => new Request("http://t/", { method: "POST" });

async function latch(): Promise<void> {
  await disarmAutopilot(tdb.db, systemClock, {
    projectId: "p1",
    reason: "score-regression",
    detail: "The rolling review score fell below the floor of 7.",
    evidence: ["anton-abc1 · 5.5"],
  });
}

function row() {
  return tdb.db.select().from(schema.autopilotDisarms).all()[0];
}

describe("POST /autopilot/re-arm", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    operator.mockReset();
    operator.mockResolvedValue("Henri Blancke");
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
  });

  it("clears the breaker and records the server's operator identity", async () => {
    await latch();

    const res = await POST(req(), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rearmedBy).toBe("Henri Blancke");
    expect(body.reason).toBe("score-regression");
    // The band is gone on the next server render — that IS the breaker being cleared.
    expect(body.disarm).toBeNull();

    expect(row()!.rearmedBy).toBe("Henri Blancke");
    expect(row()!.rearmedAt).not.toBeNull();
  });

  it("refuses a re-arm on an already-armed project rather than writing a second author", async () => {
    await latch();
    await POST(req(), ctx("tmp"));

    operator.mockResolvedValue("somebody else");
    const res = await POST(req(), ctx("tmp"));

    expect(res.status).toBe(409);
    expect(row()!.rearmedBy).toBe("Henri Blancke");
  });

  it("refuses when anton cannot tell who is asking", async () => {
    // An unattributed re-arm is worse than no re-arm: it resumes autonomous work and leaves the
    // record claiming nobody decided it.
    await latch();
    operator.mockResolvedValue(undefined);

    const res = await POST(req(), ctx("tmp"));

    expect(res.status).toBe(409);
    expect(row()!.rearmedAt).toBeNull();
  });

  it("404s an unknown project", async () => {
    expect((await POST(req(), ctx("nope"))).status).toBe(404);
  });
});
