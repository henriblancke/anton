/**
 * The veto route (anton-jqvy), against a real in-memory anton.db.
 *
 * Two properties the button cannot prove on its own. The DECLINE is recorded against the decision it
 * answers — the rank and the board digest of the plan on screen, not just the bead id — so the track
 * record names a pick. And the CRITERION is the server's answer: resolving which rule admitted a
 * bead needs the board and the stored policy, and a client-supplied one would let the deep link
 * point anywhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { getBoardPickerPlan, saveBoardPickerPlan } from "@/lib/board-picker-plan";
import {
  PICKER_DEFER_WINDOW_MS,
  activeDeferrals,
  listPickerVerdicts,
  recordPickerAccept,
} from "@/lib/picker-veto";
import type { Bead } from "@/lib/beads/types";
import type { Policy } from "@/lib/policy/types";

let tdb: TestDb;
let board: Bead[] = [];

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
vi.mock("@/lib/beads/issues", () => ({ allIssues: async () => board }));

const { POST } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = (body: unknown) =>
  new Request("http://t/", { method: "POST", body: JSON.stringify(body) });

const NOW = 1_800_000_000_000;

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "feature",
    priority: 1,
    created_at: "2026-08-01T00:00:00Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    labels: ["approved", "domain:eng"],
    ...o,
  };
}

async function arm(policy: Policy): Promise<void> {
  await tdb.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify({ pickerPolicy: policy }) });
}

describe("POST /picker/veto", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    tdb = makeTestDb();
    board = [bead("anton-a")];
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
  });

  it("defers the target and records the decline against the pick it answers", async () => {
    await saveBoardPickerPlan(tdb.db, { now: () => NOW }, {
      projectId: "p1",
      stamp: { observedAtMs: NOW, digest: "cafebabecafebabe", beadCount: 1 },
      entries: [{ beadId: "anton-a", rank: 3, rule: "the work policy armed on this machine" }],
      exclusions: [],
    });

    const res = await POST(req({ beadId: "anton-a", action: "not-now" }), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deferredUntil).toBeGreaterThan(Date.now());
    expect(body.deferredUntil).toBeLessThanOrEqual(Date.now() + PICKER_DEFER_WINDOW_MS + 1000);

    const [row] = await listPickerVerdicts(tdb.db, "p1");
    expect(row).toMatchObject({
      beadId: "anton-a",
      verdict: "declined",
      action: "not-now",
      rank: 3,
      // The plan GENERATION it answers, never the board digest — that digest comes back the moment a
      // later pass re-admits this target, and the new pick must not inherit this decline.
      planId: (await getBoardPickerPlan(tdb.db, "p1"))!.planId,
      rule: "the work policy armed on this machine",
    });
    expect(row.planId).not.toBe("cafebabecafebabe");
    expect([...(await activeDeferrals(tdb.db, "p1", new Date())).keys()]).toEqual(["anton-a"]);
  });

  it("answers Never with the criterion that admitted the bead, resolved server-side", async () => {
    await arm({ types: ["feature"], labels: [{ namespace: "domain", values: ["eng"] }] });

    const res = await POST(req({ beadId: "anton-a", action: "never" }), ctx("tmp"));
    expect(await res.json()).toMatchObject({ criterion: "labels:domain" });

    // Recorded, so the record says which rule the operator was sent to argue with.
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]?.criterion).toBe("labels:domain");
  });

  it("answers with no criterion on a project whose policy narrows nothing", async () => {
    const res = await POST(req({ beadId: "anton-a", action: "never" }), ctx("tmp"));
    expect(await res.json()).toMatchObject({ criterion: null });
    // The veto still lands — the deep link losing its anchor must not cost the decline.
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]?.verdict).toBe("declined");
  });

  it("costs no board read on the cheap veto", async () => {
    const issues = await import("@/lib/beads/issues");
    const spy = vi.spyOn(issues, "allIssues");
    await POST(req({ beadId: "anton-a", action: "not-now" }), ctx("tmp"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("vetoes a target the current plan no longer carries, recording neither rank nor plan id", async () => {
    // A stale tab answering a pick the latest generation has dropped. Stamping that generation's id
    // on the verdict would claim the operator answered a decision that never offered this bead.
    const res = await POST(req({ beadId: "anton-zz", action: "not-now" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]).toMatchObject({ beadId: "anton-zz" });
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]?.rank).toBeUndefined();
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]?.planId).toBeUndefined();
  });

  it("still records the decline when the board read for the criterion falls over", async () => {
    // The anchor is a convenience; the veto is the decision. A `Never` that 500'd on an unreadable
    // board would lose the operator's answer to protect a deep link.
    await arm({ types: ["feature"] });
    board = [];
    const issues = await import("@/lib/beads/issues");
    vi.spyOn(issues, "allIssues").mockRejectedValueOnce(new Error("bd is down"));

    const res = await POST(req({ beadId: "anton-a", action: "never" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ criterion: null });
    expect((await listPickerVerdicts(tdb.db, "p1"))[0]?.verdict).toBe("declined");
  });

  it("409s a pick a release already accepted, recording no contradicting decline", async () => {
    // Two tabs on one pick: the release records the accept, and the veto that follows must not file
    // a decline against the decision the operator already took the other side of.
    await saveBoardPickerPlan(tdb.db, { now: () => NOW }, {
      projectId: "p1",
      stamp: { observedAtMs: NOW, digest: "cafebabecafebabe", beadCount: 1 },
      entries: [{ beadId: "anton-a", rank: 1, rule: "the work policy armed on this machine" }],
      exclusions: [],
    });
    await recordPickerAccept(tdb.db, { now: () => NOW }, {
      projectId: "p1",
      beadId: "anton-a",
      planId: (await getBoardPickerPlan(tdb.db, "p1"))!.planId,
    });

    const res = await POST(req({ beadId: "anton-a", action: "not-now" }), ctx("tmp"));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already released/);
    expect((await listPickerVerdicts(tdb.db, "p1")).map((v) => v.verdict)).toEqual(["accepted"]);
    expect((await activeDeferrals(tdb.db, "p1", new Date())).size).toBe(0);
  });

  it("refuses a body that names no target or an action it does not have", async () => {
    expect((await POST(req({ action: "not-now" }), ctx("tmp"))).status).toBe(400);
    expect((await POST(req({ beadId: "anton-a", action: "burn" }), ctx("tmp"))).status).toBe(400);
    expect((await listPickerVerdicts(tdb.db, "p1")).length).toBe(0);
  });

  it("404s an unknown project rather than recording an orphan verdict", async () => {
    expect((await POST(req({ beadId: "anton-a", action: "never" }), ctx("nope"))).status).toBe(404);
  });
});
