/**
 * Real-db + real-bd route test for the RELEASE half of POST /api/projects/[slug]/epics/[epicId]/approve
 * (anton-d2h6). The "release" slice of the `approve-*.route.integration.test.ts` family, sharing the
 * seeded repo built by `approve.fixture.ts`.
 *
 * What only a route test can hold: releasing is the same approval every other caller runs — one run
 * enqueued, one label written — plus an accept recorded against the pick, and a release that loses a
 * claim race must record NOTHING at all. The button can prove none of that.
 *
 * Nor can it prove the half the button is not trusted for: the `release` flag is a CLAIM that this
 * target was anton's pick, and a stale lane or a direct caller can set it on anything runnable. The
 * cases below hold the server's own verdict — no plan entry, a stale plan, a vetoed pick, a disarmed
 * picker — each of which releases exactly as an approve does and records no evidence.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { actAs, executeEpicJobs, setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";
import {
  getBoardPickerPlan,
  saveBoardPickerPlan,
  stampBoard,
  type BoardStamp,
} from "@/lib/board-picker-plan";
import { loadAllIssues } from "@/lib/beads/issues";
import { listPickerVerdicts, pickerTrackRecord, recordPickerVeto } from "@/lib/picker-veto";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];
let getDb: ApproveSuiteCtx["getDb"];
let schema: ApproveSuiteCtx["schema"];

/** A digest no board can produce — what a plan the board has moved past looks like. */
const STALE_DIGEST = "cafebabecafebabe";

/** The `approvy` project row the fixture seeded — the id every picker record is keyed on. */
async function projectId(): Promise<string> {
  const [row] = await getDb().select().from(schema.projects);
  return row.id;
}

/**
 * The plan's freshness fence over the repo as it reads NOW — the same stamp the route re-derives
 * before it will record an accept. Computed from the live board rather than a literal: a fixed
 * digest would make every plan here stale, which is precisely the case a release must not record.
 */
async function liveStamp(): Promise<BoardStamp> {
  const board = await loadAllIssues(repo);
  return stampBoard(board, Date.now());
}

/** Record a plan that ranks `beadId` first, so a release has a pick to answer. Returns the plan's
 *  GENERATION id — what a recorded accept must name as the decision it answers, and deliberately not
 *  the reusable board digest. */
async function planFor(
  beadId: string,
  stamp?: BoardStamp,
  rule = "the work policy armed on this machine",
): Promise<string> {
  const fence = stamp ?? (await liveStamp());
  const project = await projectId();
  await saveBoardPickerPlan(getDb(), { now: () => Date.now() }, {
    projectId: project,
    stamp: fence,
    entries: [{ beadId, rank: 1, rule }],
    exclusions: [],
  });
  return (await getBoardPickerPlan(getDb(), project))!.planId;
}

/** Every accept/decline recorded against `beadId` on the seeded project. */
async function verdictsFor(beadId: string) {
  const rows = await listPickerVerdicts(getDb(), await projectId());
  return rows.filter((r) => r.beadId === beadId);
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
    const planId = await planFor(epic);

    const res = await approve(epic, { release: true });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { jobId?: string; run?: string };
    expect(started.jobId).toBeTruthy();
    expect(started.run).toBe("started");

    // The approve route's own work, unchanged by the flag: labelled, claimed, and running.
    const bead = await beads.show(repo, epic);
    expect(beads.isApproved(bead)).toBe(true);
    expect(bead.assignee).toBe("anton-test");
    expect(await executeEpicJobs(epic)).toHaveLength(1);

    // …plus the half only a release writes: the choice, against the decision it answers.
    const rows = await verdictsFor(epic);
    expect(rows).toEqual([
      expect.objectContaining({
        beadId: epic,
        verdict: "accepted",
        action: "release",
        rank: 1,
        planId,
        rule: "the work policy armed on this machine",
      }),
    ]);
    // The accept has no window to bound — only a decline defers.
    expect(rows[0]?.deferredUntilMs).toBeUndefined();
  });

  it("records the accept against the generation the operator named", async () => {
    actAs("anton-test");
    const epic = await runTarget("Named generation");
    const planId = await planFor(epic);

    expect((await approve(epic, { release: true, planId })).status).toBe(200);

    expect(await verdictsFor(epic)).toEqual([
      expect.objectContaining({ beadId: epic, verdict: "accepted", planId, rank: 1 }),
    ]);
  });

  it("records nothing when a later pass replaced the generation the operator answered", async () => {
    // The tab still shows generation A; the pass has since written B over it, carrying the same
    // bead. Resolving the pick from B would credit the picker with an agreement to a decision that
    // was never on screen — and could answer a pick another tab has already vetoed (PR #212 review).
    actAs("anton-test");
    const epic = await runTarget("Superseded generation");
    const displayed = await planFor(epic);
    const current = await planFor(epic, undefined, "a rule the next pass ranked it under");
    expect(current).not.toBe(displayed);

    expect((await approve(epic, { release: true, planId: displayed })).status).toBe(200);
    // The run is the operator's to have either way — only the evidence is withheld.
    expect(await executeEpicJobs(epic)).toHaveLength(1);
    expect(await verdictsFor(epic)).toHaveLength(0);
  });

  it("counts one accept per pick, not per click — a re-released target enqueues no second run", async () => {
    actAs("anton-test");
    const epic = await runTarget("Double released");
    await planFor(epic);

    expect((await approve(epic, { release: true })).status).toBe(200);
    expect((await approve(epic, { release: true })).status).toBe(200);

    // One run, one accept. Two fences hold that here and they agree: the first approval's own label
    // and claim moved the board past the plan the second release answers, and the unique index
    // behind `recordPickerAccept` would refuse the duplicate anyway (picker-veto.test.ts holds the
    // overlapping-release case the route cannot stage sequentially).
    expect(await executeEpicJobs(epic)).toHaveLength(1);
    expect(await verdictsFor(epic)).toHaveLength(1);
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
    expect(await verdictsFor(epic)).toHaveLength(0);
    expect(record.declined).toBe(0);
  });

  it("says a run is live on another machine rather than reading as an enqueue failure", async () => {
    // The claim gate passes (nobody holds the target), but the shared board carries a live run-lease
    // from another machine, so the enqueue deliberately starts nothing — that run already covers the
    // work (anton-jz1). Reporting the missing job id as a failed enqueue would tell the operator to
    // release again, into a second concurrent run. `run` names which it was (PR #212).
    actAs("anton-test");
    const epic = await runTarget("Running elsewhere");
    // The lease is a LABEL on the target, so it is part of the board the plan's fence covers: publish
    // it first, then record the plan the operator is answering.
    await beads.publishRunLease(repo, epic, Date.now() + 15 * 60_000);
    await planFor(epic);

    const res = await approve(epic, { release: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId?: string; run?: string };
    expect(body.run).toBe("elsewhere");
    expect(body.jobId).toBeUndefined();
    expect(await executeEpicJobs(epic)).toHaveLength(0);

    // The accept still stands: the operator took the pick and the work IS running — what earned
    // autonomy counts is the choice, not which machine happens to be executing it.
    expect((await verdictsFor(epic)).map((r) => r.verdict)).toEqual(["accepted"]);
  });

  it("withdraws the reserved accept when nothing ends up running the target", async () => {
    // The release answers its pick BEFORE it enqueues, so a veto from another tab cannot land in the
    // window the run start would otherwise hold open (PR #212 review). The price of reserving early
    // is a run that never follows: this take-over of a BLOCKED target deliberately enqueues nothing,
    // and an accept for a run that never started is evidence of nothing — so the reservation comes
    // back out, leaving the record exactly as an unreleased pick's.
    const blocker = await beads.create(repo, {
      title: "Reservation blocker",
      type: "task",
      acceptance: "- [ ] it works",
    });
    const target = await beads.create(repo, {
      title: "Reserved but never run",
      type: "task",
      acceptance: "- [ ] it works",
    });
    await beads.link(repo, target, blocker, "blocks");
    await beads.assign(repo, target, "someone-else");
    await beads.approve(repo, target);
    await planFor(target);

    actAs("anton-test");
    const res = await approve(target, { release: true, steal: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { jobId?: string }).jobId).toBeUndefined();
    expect(await executeEpicJobs(target)).toHaveLength(0);

    expect(await verdictsFor(target)).toHaveLength(0);
  });

  it("leaves an ordinary approve unrecorded — only a release answers the picker", async () => {
    actAs("anton-test");
    const epic = await runTarget("Plain approve");
    await planFor(epic);

    expect((await approve(epic)).status).toBe(200);

    expect(await verdictsFor(epic)).toHaveLength(0);
  });

  it("records nothing for a target the recorded plan never picked", async () => {
    // The flag is a CLAIM, not a fact: a direct caller can set `release` on any runnable target. An
    // accept for a pick anton never made would tell earned autonomy the operator agreed with a
    // decision they were never shown, so the run stands and the evidence does not.
    actAs("anton-test");
    const picked = await runTarget("The actual pick");
    const unpicked = await runTarget("Never picked");
    await planFor(picked);

    const res = await approve(unpicked, { release: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run?: string }).run).toBe("started");
    expect(await executeEpicJobs(unpicked)).toHaveLength(1);

    expect(await verdictsFor(unpicked)).toHaveLength(0);
  });

  it("records nothing for an unnamed pick even when the generation named is the current one", async () => {
    // The lane is DERIVED (anton-r0ew): it ranks targets the recorded plan has not caught up with,
    // so a release can arrive naming the very generation on screen for a bead that generation never
    // picked. Naming the right plan is not agreeing with a decision it contains — the accept is
    // refused on the entry, not on the id (anton-5axf). The board withholds the button on the same
    // fact; this is the half a client cannot be trusted for.
    actAs("anton-test");
    const picked = await runTarget("Named by the plan");
    const derived = await runTarget("Ranked ahead of the plan");
    const planId = await planFor(picked);

    const res = await approve(derived, { release: true, planId });
    expect(res.status).toBe(200);
    expect(await executeEpicJobs(derived)).toHaveLength(1);

    expect(await verdictsFor(derived)).toHaveLength(0);
  });

  it("records nothing when the board has moved past the plan that picked the target", async () => {
    // The lane's own standard, held on the server: a stale plan withholds `[Release]`, so a release
    // that arrives against one came from a client whose copy of the decision is provably behind.
    actAs("anton-test");
    const epic = await runTarget("Stale pick");
    await planFor(epic, { observedAtMs: Date.now(), digest: STALE_DIGEST, beadCount: 1 });

    expect((await approve(epic, { release: true })).status).toBe(200);
    expect(await executeEpicJobs(epic)).toHaveLength(1);

    expect(await verdictsFor(epic)).toHaveLength(0);
  });

  it("records nothing for a pick the operator has vetoed", async () => {
    // A deferred target is off the lane until its window runs out (`upNextEntries`), so a release
    // against it answers a pick nobody was being offered — whatever the plan still ranks.
    actAs("anton-test");
    const epic = await runTarget("Vetoed pick");
    await planFor(epic);
    await recordPickerVeto(getDb(), { now: () => Date.now() }, {
      projectId: await projectId(),
      beadId: epic,
      action: "not-now",
    });

    expect((await approve(epic, { release: true })).status).toBe(200);
    expect(await executeEpicJobs(epic)).toHaveLength(1);

    // The decline it earned, and nothing else — no accept beside it.
    expect((await verdictsFor(epic)).map((r) => r.verdict)).toEqual(["declined"]);
  });

  it("records nothing while the picker is at propose", async () => {
    // The level that ranks and offers nothing (R3.5). The board draws no `[Release]` there, so a
    // flag arriving from a tab opened before the level changed must not become evidence for the
    // `apply` that level never asked for (PR #218 review).
    actAs("anton-test");
    const epic = await runTarget("Proposing picker");
    await planFor(epic);
    const project = await projectId();
    await getDb()
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pickerAutonomy: "propose" }) })
      .where(eq(schema.projects.id, project));

    try {
      expect((await approve(epic, { release: true })).status).toBe(200);
      expect(await executeEpicJobs(epic)).toHaveLength(1);
      expect(await verdictsFor(epic)).toHaveLength(0);
    } finally {
      // Shared suite db: leave the picker offering for whatever runs next.
      await getDb()
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify({ pickerAutonomy: "shadow" }) })
        .where(eq(schema.projects.id, project));
    }
  });

  it("records nothing while the picker is disarmed", async () => {
    // A plan left behind by a pass the operator switched off is history. The board stops offering
    // `[Release]` on it for exactly that reason, and a release that arrives anyway must not become
    // evidence for re-arming the pass that no longer runs.
    actAs("anton-test");
    const epic = await runTarget("Disarmed picker");
    await planFor(epic);
    const project = await projectId();
    await getDb().insert(schema.schedules).values({
      id: randomUUID(),
      projectId: project,
      type: "board-picker",
      cron: "*/10 * * * *",
      enabled: false,
    });

    try {
      expect((await approve(epic, { release: true })).status).toBe(200);
      expect(await executeEpicJobs(epic)).toHaveLength(1);
      expect(await verdictsFor(epic)).toHaveLength(0);
    } finally {
      // Shared suite db: leave the picker armed for whatever runs next.
      await getDb().delete(schema.schedules).where(eq(schema.schedules.projectId, project));
    }
  });
});
