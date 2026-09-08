/**
 * Who is in this pass's denominator (R6.4), tested at its own boundary.
 *
 * The claim under test is that "has eligible work" is answered from both signals a repo can wake up
 * on — the picker's latest ranking AND work that can start now — so reclaim is prompt rather than
 * gated on the next scheduled picker pass; that "can start now" means the queue's own definition
 * (running, or queued and DUE), so a backed-off row does not hold a share it cannot spend; that a
 * queued row the runner's own claim gates hold — autonomy off, schedule disabled — is likewise no
 * claim (PR #248 review); that plumbing costing no quota never counts as a claim on anyone's share;
 * and that a project nothing has observed is reported as UNKNOWN rather than idle.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import { insertProject } from "@/lib/testing/project";
import { eligibilityOf, observedWorkEligibility } from "@/lib/quota-eligibility";
import type { JobStatus, JobType } from "@/lib/jobs/queue";

const NOW = Date.parse("2026-03-04T12:00:00Z");

let tdb: TestDb;

beforeEach(() => {
  tdb = makeTestDb();
});
afterEach(() => tdb.close());

function project(id: string, settings: Record<string, unknown> = {}): string {
  return insertProject(tdb.db, {
    id,
    slug: id,
    name: id,
    repoPath: `/tmp/${id}`,
    settingsJson: JSON.stringify(settings),
  });
}

function schedule(projectId: string, type: JobType, enabled: boolean): void {
  tdb.db
    .insert(schema.schedules)
    .values({ id: randomUUID(), projectId, type, cron: "0 * * * *", enabled })
    .run();
}

function plan(projectId: string, targetCount: number): void {
  tdb.db
    .insert(schema.boardPickerPlans)
    .values({ projectId, boardDigest: "d", boardObservedAtMs: 1, targetCount })
    .run();
}

function job(
  projectId: string,
  type: JobType,
  status: JobStatus,
  runAt: Date = new Date(NOW),
  leaseExpiresAt: Date | null = null,
): void {
  tdb.db
    .insert(schema.jobs)
    .values({ id: randomUUID(), projectId, type, status, runAt, leaseExpiresAt, payloadJson: "{}" })
    .run();
}

describe("observedWorkEligibility", () => {
  it("reads the picker's own answer, both ways", async () => {
    const ranked = project("ranked");
    const empty = project("empty");
    plan(ranked, 3);
    plan(empty, 0);

    const eligibility = await observedWorkEligibility(tdb.db, NOW);

    expect(eligibilityOf(eligibility, ranked)).toBe(true);
    expect(eligibilityOf(eligibility, empty)).toBe(false);
  });

  it("never reports an unarmed picker as idle", async () => {
    // board-picker ships disabled, so most projects have no plan row at all. "Nobody looked" is not
    // "no work" — reading it as idle would strip a busy repo's share on a question never asked.
    const unobserved = project("unobserved");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), unobserved)).toBeNull();
  });

  it("counts work already in flight, so a waking repo need not wait for the next picker pass", async () => {
    const waking = project("waking");
    plan(waking, 0);
    job(waking, "execute-epic", "queued");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), waking)).toBe(true);
  });

  it("ignores jobs that are not a claim on the quota", async () => {
    const idle = project("idle");
    plan(idle, 0);
    // Settled work says nothing about now, and plumbing costs no Claude quota at all.
    job(idle, "execute-epic", "done");
    job(idle, "sync-push", "queued");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), idle)).toBe(false);
  });

  it("does not count queued work that cannot start yet", async () => {
    // A retry backoff, a usage-limit reschedule, a budget deferral: the row is `queued`, but its
    // `runAt` is hours out and nothing here can spend before then. Holding the project in the
    // denominator on it blocks the reallocation the idle window exists to allow — and tells the
    // settings panel it has work ready when it has none.
    const backing = project("backing");
    plan(backing, 0);
    job(backing, "execute-epic", "queued", new Date(NOW + 60 * 60 * 1000));

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), backing)).toBe(false);
  });

  it("counts a running job whatever its runAt says", async () => {
    // `runAt` is the queue's scan key, not a lease: a job already running is spending right now.
    const busy = project("busy");
    plan(busy, 0);
    job(busy, "execute-epic", "running", new Date(NOW + 60 * 60 * 1000));

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), busy)).toBe(true);
  });

  it("does not count execute-epic work an autonomy-off project cannot claim", async () => {
    // The runner caps an autonomy-off project's execute-epic bucket at 0 (`tickOnce`), so a due row
    // there sits queued until an operator flips the switch. Holding the share on it blocks idle
    // renormalization for as long as the switch stays off — and the picker's ranking is the same
    // claim, since every start it makes is an execute-epic.
    const paused = project("paused", { autonomy: false });
    plan(paused, 3);
    job(paused, "execute-epic", "queued");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db, NOW), paused)).toBe(false);
  });

  it("still counts an autonomy-off project's other quota-burning work, and its running runs", async () => {
    // Autonomy gates the CLAIM of execute-epic only: a review-fix leases regardless, and a run
    // already in flight keeps spending until it settles.
    const fixing = project("fixing", { autonomy: false });
    plan(fixing, 0);
    job(fixing, "review-fix", "queued");
    const finishing = project("finishing", { autonomy: false });
    plan(finishing, 0);
    job(finishing, "execute-epic", "running");

    const eligibility = await observedWorkEligibility(tdb.db, NOW);
    expect(eligibilityOf(eligibility, fixing)).toBe(true);
    expect(eligibilityOf(eligibility, finishing)).toBe(true);
  });

  it("treats a held project's expired running lease as a reclaim, not a live run", async () => {
    // A restart expires every surviving lease (`reclaimRunningJobs`); the runner then re-leases
    // through the same held-bucket filter as a queued row, so an autonomy-off project's expired
    // execute-epic is never picked back up. Counting it would hold the share indefinitely.
    const stale = project("stale", { autonomy: false });
    plan(stale, 0);
    job(stale, "execute-epic", "running", new Date(NOW), new Date(NOW - 1000));
    // The same expiry on a disabled schedule's type is held the same way.
    const off = project("off");
    plan(off, 0);
    schedule(off, "review-fix", false);
    job(off, "review-fix", "running", new Date(NOW), new Date(NOW));
    // A lease still in force is a run in flight, switches or not; and a held project's expired
    // lease on an UNHELD type is reclaimable, so it still counts.
    const live = project("live", { autonomy: false });
    plan(live, 0);
    job(live, "execute-epic", "running", new Date(NOW), new Date(NOW + 60_000));
    const fixing = project("fixing", { autonomy: false });
    plan(fixing, 0);
    job(fixing, "review-fix", "running", new Date(NOW), new Date(NOW - 1000));

    const eligibility = await observedWorkEligibility(tdb.db, NOW);
    expect(eligibilityOf(eligibility, stale)).toBe(false);
    expect(eligibilityOf(eligibility, off)).toBe(false);
    expect(eligibilityOf(eligibility, live)).toBe(true);
    expect(eligibilityOf(eligibility, fixing)).toBe(true);
  });

  it("does not count a queued job whose schedule is disabled", async () => {
    // A disabled schedule caps its (type, project) bucket at 0 at claim time, not just at enqueue,
    // so an already-queued review-fix is held exactly like an autonomy-off execute-epic.
    const off = project("off");
    plan(off, 0);
    schedule(off, "review-fix", false);
    job(off, "review-fix", "queued");
    // The gate is per (type, project): another project's disabled schedule says nothing here.
    const on = project("on");
    plan(on, 0);
    schedule(on, "review-fix", true);
    job(on, "review-fix", "queued");

    const eligibility = await observedWorkEligibility(tdb.db, NOW);
    expect(eligibilityOf(eligibility, off)).toBe(false);
    expect(eligibilityOf(eligibility, on)).toBe(true);
  });

  it("attributes nothing to anton's own project-less plumbing", async () => {
    tdb.db
      .insert(schema.jobs)
      .values({ id: randomUUID(), type: "execute-epic", status: "running", payloadJson: "{}" })
      .run();

    expect((await observedWorkEligibility(tdb.db, NOW)).size).toBe(0);
  });
});
