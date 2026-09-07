/**
 * The budget governor's ADMISSION gate (anton-szld): before leasing anything, a tick asks whether a
 * budget-aware project's autonomous work may run at all, and on a DEFER verdict holds that project's
 * governed buckets and pushes their queued `runAt` out to the governor's boundary.
 *
 * Two rules the cases keep honest: the gate governs only the buckets that burn a lot of budget
 * (anton-d8i4), and it fails OPEN — an unreadable usage or label read must never stall the queue.
 * The reactive `UsageLimitError` backstop is unaffected either way and is asserted here too.
 */
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { recordBurnSample } from "../burn";
import type { ClaudeUsage } from "../claude/usage";
import { DEFAULT_BUDGET_POLICY, withQuotaShare, type BudgetPolicy } from "./budget";
import { UsageLimitError } from "./errors";
import { getJob, toMs } from "./queue";
import type {
  BeadLabelsReader,
  BudgetPolicyResolver,
  JobHandler,
  ProjectSpendResolver,
} from "./runner";
import { usage, useRunnerHarness } from "./runner.fixture";

/** Every bucket the governor is wired to hold — registered together so a case can enqueue any. */
const GOVERNED_TYPES = ["execute-epic", "review-fix", "nightly-stringer", "orphan-grooming"] as const;

describe("JobRunner budget governor admission gate (anton-szld)", () => {
  const h = useRunnerHarness();

  /** A runner wired with the budget governor: a fixed usage read + a fixed policy for every project. */
  function budgetRunner(
    handler: JobHandler,
    opts: {
      readUsage: () => Promise<ClaudeUsage | null>;
      policy?: BudgetPolicy;
      resolveBudgetPolicy?: BudgetPolicyResolver;
      resolveProjectSpend?: ProjectSpendResolver;
      readBeadLabels?: BeadLabelsReader;
    },
  ) {
    return h.makeRunner({
      handlers: Object.fromEntries(GOVERNED_TYPES.map((type) => [type, handler])),
      config: { maxConcurrent: 5 },
      readUsage: opts.readUsage,
      // Keep the burn sampler off the real endpoint — these tests exercise the governor only.
      readUsageFresh: async () => null,
      resolveBudgetPolicy: opts.resolveBudgetPolicy ?? (() => opts.policy ?? DEFAULT_BUDGET_POLICY),
      resolveProjectSpend: opts.resolveProjectSpend,
      readBeadLabels: opts.readBeadLabels,
    });
  }

  it("defers a tick past the reset boundary: leases nothing and reschedules queued work to retryAt", async () => {
    // Session nearly exhausted (99% ≥ 100 − minSessionHeadroom 5) → session-headroom defer. No known
    // session reset, so retryAt is now + the 5h session window.
    h.seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // held — nothing leased
    await r.whenIdle();
    expect(ran).toBe(0);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0); // a proactive hold never burns an attempt
    const expectedRetry = Math.floor((h.clock.now() + DEFAULT_BUDGET_POLICY.sessionWindowMs) / 1000) * 1000;
    expect(toMs(job?.runAt)).toBe(expectedRetry);
    expect(job?.lastError).toMatch(/budget: session-headroom/);
  });

  it("clears stale budget deferrals when a project's budget-aware pacing turns off", async () => {
    // A governed tick pushes the queued job past the session horizon; then the operator flips
    // budgetAware off (resolver → null). leaseDue only scans due rows, so without clearing the
    // governor's own deferrals the job would stay parked until the stale pace boundary — the next
    // tick must pull it back to due-now and lease it.
    h.seedProjects("A");
    let budgetAwareOn = true;
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 99 }),
        resolveBudgetPolicy: () => (budgetAwareOn ? DEFAULT_BUDGET_POLICY : null),
      },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // governed → deferred to the session horizon
    const deferred = await getJob(h.db, id);
    expect(toMs(deferred?.runAt)).toBeGreaterThan(h.clock.now());
    expect(deferred?.lastError).toMatch(/budget: session-headroom/);

    budgetAwareOn = false; // operator turns pacing off
    expect(await r.tickOnce()).toBe(1); // stale deferral cleared → leases this tick
    await r.whenIdle();
    expect(ran).toBe(1);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.lastError).toBeNull();
  });

  it("governs the orphan-grooming cleanup sweep, not just execute-epic", async () => {
    h.seedProjects("A");
    const r = budgetRunner(async () => {}, { readUsage: async () => usage({ sessionPct: 99 }) });
    const id = await r.enqueue({ type: "orphan-grooming", projectId: "A" });

    expect(await r.tickOnce()).toBe(0);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toMatch(/budget:/);
  });

  it("does NOT govern review-fix or nightly-stringer — they lease immediately even when budget is scarce (anton-d8i4)", async () => {
    // Session 99% ≥ the floor would defer any governed type, but review-fix / nightly-stringer are
    // off the allowlist: a human's PR-review fix and the fixed nightly scan must not be paced.
    h.seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const rf = await r.enqueue({ type: "review-fix", projectId: "A" });
    const ns = await r.enqueue({ type: "nightly-stringer", projectId: "A" });

    expect(await r.tickOnce()).toBe(2); // both leased despite the scarce budget
    await r.whenIdle();
    expect(ran).toBe(2);
    expect((await getJob(h.db, rf))?.status).toBe("done");
    expect((await getJob(h.db, ns))?.status).toBe("done");
  });

  it("runs an immediate-approved (bypassBudget) execute-epic while pacing a queued one (anton-d8i4)", async () => {
    // Ahead of the weekly pace-line (weekly-on-track), session fresh: a paced job defers, but an
    // immediate-approved one skips pacing and runs now.
    h.seedProjects("A");
    const weeklyResetAt = new Date(h.clock.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString(); // half-week left
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10, weeklyPct: 80, weeklyResetAt }) },
    );
    const paced = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });
    const immediate = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-2", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(1); // only the immediate job leases
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, immediate))?.status).toBe("done");
    const pacedJob = await getJob(h.db, paced);
    expect(pacedJob?.status).toBe("queued");
    expect(toMs(pacedJob?.runAt)).toBeGreaterThan(h.clock.now()); // pushed out to the pace boundary
    expect(pacedJob?.lastError).toMatch(/budget: weekly-on-track/);
  });

  it("does NOT reclaim a crashed (lease-expired) paced execute-epic during a paced deferral, while a crashed bypass row reclaims (anton-d8i4)", async () => {
    // Weekly-on-track pacing defers non-bypass work while immediate work admits. deferQueuedJobs
    // only moves `queued` rows, so a paced job that was leased and then crashed sits `running`
    // with an expired lease — it must NOT be reclaimed and restarted ahead of the pace boundary,
    // while a bypass ("Approve") row in the same crashed state reclaims normally.
    h.seedProjects("A");
    const s = await import("../db/schema");
    const seedCrashed = async (id: string, payload: object) => {
      await h.db.insert(s.jobs).values({
        id,
        type: "execute-epic",
        projectId: "A",
        payloadJson: JSON.stringify(payload),
        status: "running",
        runAt: new Date(h.clock.now() - 100_000),
        leaseExpiresAt: new Date(h.clock.now() - 50_000), // already expired — looks reclaimable
        attempts: 1,
      });
    };
    await seedCrashed("crashed-paced", { projectId: "A", epicBeadId: "A-1" });
    await seedCrashed("crashed-bypass", { projectId: "A", epicBeadId: "A-2", bypassBudget: true });

    const weeklyResetAt = new Date(h.clock.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10, weeklyPct: 80, weeklyResetAt }) },
    );

    expect(await r.tickOnce()).toBe(1); // only the bypass row reclaims
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, "crashed-bypass"))?.status).toBe("done");
    // The paced row stays un-reclaimed this tick; it resumes when pacing admits again.
    const paced = await getJob(h.db, "crashed-paced");
    expect(paced?.status).toBe("running");
    expect(paced?.attempts).toBe(1); // no reclaim → no new attempt burned
  });

  it("still holds an immediate-approved execute-epic at the session-headroom floor (anton-d8i4)", async () => {
    // The session floor is the one hold "Approve" (immediate) does NOT bypass — it protects the tail
    // of the 5h session, so an immediate run can't blow the cap it would only hit mid-run.
    h.seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(0); // held by the session floor
    await r.whenIdle();
    expect(ran).toBe(0);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    const expectedRetry = Math.floor((h.clock.now() + DEFAULT_BUDGET_POLICY.sessionWindowMs) / 1000) * 1000;
    expect(toMs(job?.runAt)).toBe(expectedRetry);
    expect(job?.lastError).toMatch(/budget: session-headroom/);
  });

  it("admits a tick when the governor says work may run", async () => {
    h.seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("fails OPEN on a null usage read: no deferral, work leases normally", async () => {
    h.seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => null },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });
    const runAtBefore = toMs((await getJob(h.db, id))?.runAt);

    expect(await r.tickOnce()).toBe(1); // null usage → governor admits
    await r.whenIdle();
    expect(ran).toBe(1);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(runAtBefore).toBeLessThanOrEqual(h.clock.now()); // was due; governor never pushed it out
  });

  it("resumes prior budget deferrals on a null usage read — fail-open admits already-deferred work", async () => {
    // A governed tick defers the queued job past the session horizon; then the meter goes dark
    // (429 backoff, credentials hiccup, usage outage). leaseDue only scans due rows, so returning
    // on the null read without resuming the governor's own deferrals would strand the job until
    // the stale pace boundary — fail-open must pull it back to due-now and lease it.
    h.seedProjects("A");
    let meterUp = true;
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => (meterUp ? usage({ sessionPct: 99 }) : null) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // governed → deferred to the session horizon
    const deferred = await getJob(h.db, id);
    expect(toMs(deferred?.runAt)).toBeGreaterThan(h.clock.now());
    expect(deferred?.lastError).toMatch(/budget: session-headroom/);

    meterUp = false; // meter goes dark
    expect(await r.tickOnce()).toBe(1); // stale deferral resumed → leases this tick
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("resumes prior budget deferrals when the gate starts admitting before the old boundary", async () => {
    // A governed tick defers the queued job to a future runAt; then the budget recovers (usage
    // drops, or the operator loosens the policy) BEFORE that boundary. leaseDue only scans due
    // rows, so without resuming the governor's own deferrals on the admit path the job would stay
    // parked until the stale boundary even though the gate now admits it.
    h.seedProjects("A");
    let sessionPct = 99; // session exhausted → defer
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // governed → deferred to the session horizon
    const deferred = await getJob(h.db, id);
    expect(toMs(deferred?.runAt)).toBeGreaterThan(h.clock.now());
    expect(deferred?.lastError).toMatch(/budget: session-headroom/);

    sessionPct = 10; // budget recovered well before the deferred runAt
    expect(await r.tickOnce()).toBe(1); // stale deferral resumed → leases this tick
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("holds a project at its quota share while its neighbour keeps spending (R6.1)", async () => {
    // One account meter, two armed repos. A declares 30%, B 70%; the meter reads 60, half of it
    // each. A has spent its whole 30-point cut and must stop — but B, 30 into a 70-point cut, must
    // NOT: the meter it shares with A says nothing about whose quota was spent, and stopping both
    // at 30 would leave most of the operator's weekly target unspendable every week.
    h.seedProjects("A", "B");
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const shares: Record<string, number> = { A: 30, B: 70 };
    const spent: Record<string, number> = { A: 30, B: 30 };
    const ran: string[] = [];
    const r = budgetRunner(
      async (ctx) => {
        ran.push(ctx.projectId ?? "?");
      },
      {
        readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
        resolveBudgetPolicy: (pid) =>
          pid ? withQuotaShare(DEFAULT_BUDGET_POLICY, shares[pid]) : null,
        resolveProjectSpend: async (pid) => (pid ? spent[pid]! : null),
      },
    );
    const a = await r.enqueue({ type: "execute-epic", projectId: "A" });
    const b = await r.enqueue({ type: "execute-epic", projectId: "B" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toEqual(["B"]);
    expect((await getJob(h.db, b))?.status).toBe("done");

    const held = await getJob(h.db, a);
    expect(held?.status).toBe("queued");
    expect(held?.lastError).toMatch(/budget: weekly-cap/);
    expect(toMs(held?.runAt)).toBe(Date.parse(weeklyResetAt));
  });

  it("does not hold a project on a neighbour's spend when its own share is untouched", async () => {
    // The same meter reading, but every point of it is B's. A has spent nothing, so its 30-point
    // share is entirely intact and the governor has no business deferring it.
    h.seedProjects("A", "B");
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const ran: string[] = [];
    const r = budgetRunner(
      async (ctx) => {
        ran.push(ctx.projectId ?? "?");
      },
      {
        readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
        resolveBudgetPolicy: () => withQuotaShare(DEFAULT_BUDGET_POLICY, 30),
        resolveProjectSpend: async (pid) => (pid === "B" ? 60 : 0),
      },
    );
    await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toEqual(["A"]);
  });

  it("reserves the share across the whole leased batch, not just the first job (R6.1)", async () => {
    // The governor reads a project's attributed spend ONCE per tick, and none of the attempts the
    // batch it admits is about to make is visible to that meter until the next one. So a 10-point
    // cut with room for three seeded execute-epic runs (3 weekly-points each) would otherwise start
    // all five queued runs at once and spend 15 against it before anything could observe them.
    h.seedProjects("A");
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
        resolveBudgetPolicy: () => withQuotaShare(DEFAULT_BUDGET_POLICY, 10),
        resolveProjectSpend: async () => 0,
      },
    );
    for (let i = 0; i < 5; i++) await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(3);
    await r.whenIdle();
    expect(ran).toBe(3);
  });

  it("never withholds the FIRST run over a share too small to fit it", async () => {
    // The coarse gate admits while spend is still BELOW the cap, so the run that crosses it is one
    // the operator's ceiling allows. Reserving against the first job too would leave any share with
    // less left than a single job's burn unspendable until the weekly reset (idle-fill, anton-ld7j).
    h.seedProjects("A");
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
      resolveBudgetPolicy: () => withQuotaShare(DEFAULT_BUDGET_POLICY, 10),
      resolveProjectSpend: async () => 9, // 1 point left; a seeded execute-epic costs 3
    });
    for (let i = 0; i < 3; i++) await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
  });

  it("leaves the batch unreserved when the project carries no share", async () => {
    // No share, no ceiling to reserve against: an ungoverned-by-share project keeps leasing to its
    // concurrency, exactly as before the reservation existed.
    h.seedProjects("A");
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
      resolveBudgetPolicy: () => DEFAULT_BUDGET_POLICY, // projectWeeklyCapPct: null
      resolveProjectSpend: async () => 0,
    });
    for (let i = 0; i < 5; i++) await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(5);
    await r.whenIdle();
  });

  it("leaves the share unbound when no spend resolver is wired", async () => {
    // Fail-open, like every other governor input: without attribution the machine-wide target is
    // the only weekly limit, rather than a share the runner cannot actually measure.
    h.seedProjects("A");
    let ran = 0;
    const weeklyResetAt = new Date(h.clock.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 10, weeklyPct: 60, weeklyResetAt }),
        resolveBudgetPolicy: () => withQuotaShare(DEFAULT_BUDGET_POLICY, 30),
      },
    );
    await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
  });

  it("keeps the reactive UsageLimitError backstop working with the governor wired", async () => {
    // Governor admits (session fresh), but the handler still hits the wall mid-run: the reactive
    // path must reschedule to the reset and refund the attempt, exactly as without the governor.
    h.seedProjects("A");
    const resetAt = Math.floor(h.clock.now() / 1000) + 3600; // seconds
    const r = budgetRunner(
      async () => {
        throw new UsageLimitError("hit the wall", resetAt);
      },
      { readUsage: async () => usage({ sessionPct: 10 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1); // governor admitted; the job ran and hit the limit
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, not parked
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
    expect(job?.attempts).toBe(0); // attempt refunded — quota isn't the job's fault
    expect(job?.lastError).toMatch(/usage-limit/);
  });

  // ── Per-job value/cost gate (anton-k05r) ──
  // The h.clock (1_700_000_000_000 ≈ 22:13 UTC) is NIGHT under the default policy (day 8–22), so the
  // daytime reserve never holds these ticks: the coarse gate admits and the fine gate decides.
  // sessionPct 85 → 15% headroom ≤ scarceHeadroomPct 20 → scarce (high-value only).

  /**
   * A project that has NOMINATED `risk:high` as its top value label (anton-prng). The scorer ships
   * no vocabulary, so a gate test about high-value work has to say which label this board calls
   * high-value — exactly as the project's settings do at runtime.
   */
  const VALUE_POLICY: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY, valueLabels: ["risk:high"] };

  /** Labels by bead id for the gate's reader; anything not listed reads as label-less cleanup. */
  const labelsReader =
    (byBead: Record<string, string[]>): BeadLabelsReader =>
    async (_pid, beadId) =>
      byBead[beadId] ?? [];

  /** Seed enough real burn samples that execute-epic's rolling average is `sessionDelta` (not the L-tier seed). */
  async function seedBurn(sessionDelta: number) {
    for (let i = 0; i < 5; i++) {
      await recordBurnSample(h.db, h.clock, "execute-epic", null, {
        sessionDelta,
        weeklyDelta: 0.1,
      });
    }
  }

  it("value gate: scarce session admits only high-value work, holding cleanup un-deferred (anton-k05r)", async () => {
    h.seedProjects("A");
    await seedBurn(2); // measured cost 2% — fits the 15% headroom
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 85 }),
        policy: VALUE_POLICY,
        readBeadLabels: labelsReader({ "A-high": ["risk:high"] }),
      },
    );
    const high = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-high" },
    });
    const low = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-low" },
    });

    expect(await r.tickOnce()).toBe(1); // only the risk:high job clears the scarce threshold
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, high))?.status).toBe("done");
    // The held job is untouched — still queued and due (a per-tick hold, not a deferral), no
    // attempt burned. It re-evaluates next tick and leases the moment budget loosens.
    const held = await getJob(h.db, low);
    expect(held?.status).toBe("queued");
    expect(held?.attempts).toBe(0);
    expect(toMs(held?.runAt)).toBeLessThanOrEqual(h.clock.now());
  });

  it("value gate: a job whose cost cannot fit the remaining session is held even at high value", async () => {
    h.seedProjects("A");
    // No burn samples → execute-epic costs the L-tier seed (20%), over the 15% headroom.
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      policy: VALUE_POLICY,
      readBeadLabels: labelsReader({ "A-1": ["risk:high"] }),
    });
    await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(0); // cost-exceeds-headroom — admitting guarantees mid-run exhaustion
  });

  it("value gate: abundant budget admits low-value cleanup", async () => {
    h.seedProjects("A");
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 10 }), // 90% headroom ≥ abundant 60 → threshold 0
      readBeadLabels: labelsReader({}),
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("value gate: holds the orphan-grooming cleanup sweep when the session is scarce", async () => {
    // Grooming carries no bead — it IS the low-value cleanup band — so scarce budget holds it
    // without any label read, and it drains later when budget is abundant/behind pace.
    h.seedProjects("A");
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
    });
    const id = await r.enqueue({ type: "orphan-grooming", projectId: "A" });

    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(h.db, id))?.status).toBe("queued");
  });

  it("value gate: fails open when the bead's labels cannot be read", async () => {
    h.seedProjects("A");
    await seedBurn(2);
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      readBeadLabels: async () => null, // bead unresolved → must admit, never starve on a guess
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("value gate: an immediate-approved (bypassBudget) job skips the value gate", async () => {
    // The operator asked for "now" — only the session floor may hold it, not the value threshold.
    h.seedProjects("A");
    await seedBurn(2);
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      readBeadLabels: labelsReader({}), // would score as cleanup and be held if gated
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("value gate: holds a reclaimable (lease-expired) low-value retry like its queued twin", async () => {
    // A crashed low-value job is `running` with an expired lease — leaseDue treats that as
    // runnable, so without gating it the reclaim would bypass the admission check and spend the
    // scarce quota. It must be held un-reclaimed — while an admitted high-value QUEUED job in the
    // same project still leases (the hold must not occupy a concurrency slot).
    h.seedProjects("A");
    await seedBurn(2);
    let sessionPct = 85; // scarce → high-value only
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct }),
        policy: VALUE_POLICY,
        readBeadLabels: labelsReader({ "A-high": ["risk:high"] }),
      },
    );
    // Crashed mid-run: lease expired, nothing in this process's inFlight.
    await h.db.insert(schema.jobs).values({
      id: "stuck-low",
      type: "execute-epic",
      projectId: "A",
      payloadJson: JSON.stringify({ projectId: "A", epicBeadId: "A-low" }),
      status: "running",
      runAt: new Date(h.clock.now() - 100_000),
      leaseExpiresAt: new Date(h.clock.now() - 50_000),
      attempts: 1,
    });
    const high = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-high" },
    });

    expect(await r.tickOnce()).toBe(1); // the high-value queued job — NOT the crashed low-value row
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(h.db, high))?.status).toBe("done");
    // The reclaimable row is untouched — still running/expired, no attempt burned (per-tick hold).
    const held = await getJob(h.db, "stuck-low");
    expect(held?.status).toBe("running");
    expect(held?.attempts).toBe(1);

    sessionPct = 10; // budget loosens → the hold lifts and the row is reclaimed next tick
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(2);
    expect((await getJob(h.db, "stuck-low"))?.status).toBe("done");
  });
});
