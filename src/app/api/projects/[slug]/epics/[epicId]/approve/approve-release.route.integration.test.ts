/**
 * Real-db + real-bd route test for the RELEASE half of POST /api/projects/[slug]/epics/[epicId]/approve
 * (anton-d2h6). The "release" slice of the `approve-*.route.integration.test.ts` family, sharing the
 * seeded repo built by `approve.fixture.ts`.
 *
 * What only a route test can hold: releasing is the same approval every other caller runs — one run
 * enqueued, one label written — plus an accept recorded against the pick, and a release that loses a
 * claim race must record NOTHING at all. The button can prove none of that.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { actAs, executeEpicJobs, setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";
import { saveBoardPickerPlan } from "@/lib/board-picker-plan";
import { listPickerVerdicts, pickerTrackRecord } from "@/lib/picker-veto";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];
let getDb: ApproveSuiteCtx["getDb"];
let schema: ApproveSuiteCtx["schema"];

const DIGEST = "cafebabecafebabe";

/** The `approvy` project row the fixture seeded — the id every picker record is keyed on. */
async function projectId(): Promise<string> {
  const [row] = await getDb().select().from(schema.projects);
  return row.id;
}

/** Record a plan that ranks `beadId` first, so a release has a pick to answer. */
async function planFor(beadId: string, digest = DIGEST): Promise<void> {
  await saveBoardPickerPlan(getDb(), { now: () => Date.now() }, {
    projectId: await projectId(),
    stamp: { observedAtMs: Date.now(), digest, beadCount: 1 },
    entries: [{ beadId, rank: 1, rule: "the work policy armed on this machine" }],
    exclusions: [],
  });
}

/** A runnable feature-with-child pair, the shape every release case starts from. */
async function runTarget(title: string): Promise<string> {
  const epic = await beads.create(repo, { title, type: "epic", acceptance: "- [ ] it works" });
  const child = await beads.create(repo, {
    title: `${title} child`,
    type: "task",
    acceptance: "- [ ] it works",
  });
  await beads.link(repo, child, epic, "parent-child");
  return epic;
}

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — release (temp anton.db + real bd)", () => {
  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, approve, beads, resetOperatorCache, getDb, schema } = s);
  });

  afterAll(() => {
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("performs exactly the approval — approve, auto-claim, one run — and records the accept", async () => {
    actAs("anton-test");
    const epic = await runTarget("Released target");
    await planFor(epic);

    const res = await approve(epic, { release: true });
    expect(res.status).toBe(200);
    expect((await res.json()).jobId).toBeTruthy();

    // The approve route's own work, unchanged by the flag: labelled, claimed, and running.
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
    expect(await executeEpicJobs(epic)).toHaveLength(1);

    // …plus the half only a release writes: the choice, against the decision it answers.
    const rows = await listPickerVerdicts(getDb(), await projectId());
    expect(rows.filter((r) => r.beadId === epic)).toEqual([
      expect.objectContaining({
        beadId: epic,
        verdict: "accepted",
        action: "release",
        rank: 1,
        planDigest: DIGEST,
        rule: "the work policy armed on this machine",
      }),
    ]);
    // The accept has no window to bound — only a decline defers.
    expect(rows.find((r) => r.beadId === epic)?.deferredUntilMs).toBeUndefined();
  });

  it("counts one accept per pick, not per click — a re-released target enqueues no second run", async () => {
    actAs("anton-test");
    const epic = await runTarget("Double released");
    await planFor(epic);

    expect((await approve(epic, { release: true })).status).toBe(200);
    expect((await approve(epic, { release: true })).status).toBe(200);

    expect(await executeEpicJobs(epic)).toHaveLength(1);
    const rows = await listPickerVerdicts(getDb(), await projectId());
    expect(rows.filter((r) => r.beadId === epic)).toHaveLength(1);
  });

  it("records nothing when the release loses a claim race", async () => {
    // A teammate holds the target: approve refuses with the steal 409 it always has, and a refusal
    // is not evidence — the operator's pick never ran, so it must not read as an accepted one.
    actAs("bob");
    const epic = await runTarget("Contested target");
    await beads.assign(repo, epic, "bob");
    await planFor(epic);

    actAs("alice");
    const res = await approve(epic, { release: true });
    expect(res.status).toBe(409);
    expect((await res.json()).owner).toBe("bob");

    expect(await executeEpicJobs(epic)).toHaveLength(0);
    // The refusal costs the picker nothing either way — no accept, and no decline it never earned.
    const record = await pickerTrackRecord(getDb(), await projectId());
    const rows = await listPickerVerdicts(getDb(), await projectId());
    expect(rows.filter((r) => r.beadId === epic)).toHaveLength(0);
    expect(record.declined).toBe(0);
  });

  it("leaves an ordinary approve unrecorded — only a release answers the picker", async () => {
    actAs("anton-test");
    const epic = await runTarget("Plain approve");
    await planFor(epic);

    expect((await approve(epic)).status).toBe(200);

    const rows = await listPickerVerdicts(getDb(), await projectId());
    expect(rows.filter((r) => r.beadId === epic)).toHaveLength(0);
  });
});
