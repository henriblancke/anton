/**
 * Who is in this pass's denominator (R6.4), tested at its own boundary.
 *
 * The claim under test is that "has eligible work" is answered from both signals a repo can wake up
 * on — the picker's latest ranking AND work that can start now — so reclaim is prompt rather than
 * gated on the next scheduled picker pass; that "can start now" means the queue's own definition
 * (running, or queued and DUE), so a backed-off row does not hold a share it cannot spend; that
 * plumbing costing no quota never counts as a claim on anyone's share; and that a project nothing
 * has observed is reported as UNKNOWN rather than idle.
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

function project(id: string): string {
  return insertProject(tdb.db, { id, slug: id, name: id, repoPath: `/tmp/${id}` });
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
): void {
  tdb.db
    .insert(schema.jobs)
    .values({ id: randomUUID(), projectId, type, status, runAt, payloadJson: "{}" })
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

  it("attributes nothing to anton's own project-less plumbing", async () => {
    tdb.db
      .insert(schema.jobs)
      .values({ id: randomUUID(), type: "execute-epic", status: "running", payloadJson: "{}" })
      .run();

    expect((await observedWorkEligibility(tdb.db, NOW)).size).toBe(0);
  });
});
