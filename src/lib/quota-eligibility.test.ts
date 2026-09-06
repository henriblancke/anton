/**
 * Who is in this pass's denominator (R6.4), tested at its own boundary.
 *
 * The claim under test is that "has eligible work" is answered from both signals a repo can wake up
 * on — the picker's latest ranking AND work already in flight — so reclaim is prompt rather than
 * gated on the next scheduled picker pass; that plumbing costing no quota never counts as a claim on
 * anyone's share; and that a project nothing has observed is reported as UNKNOWN rather than idle.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import { insertProject } from "@/lib/testing/project";
import { eligibilityOf, observedWorkEligibility } from "@/lib/quota-eligibility";
import type { JobStatus, JobType } from "@/lib/jobs/queue";

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

function job(projectId: string, type: JobType, status: JobStatus): void {
  tdb.db
    .insert(schema.jobs)
    .values({ id: randomUUID(), projectId, type, status, payloadJson: "{}" })
    .run();
}

describe("observedWorkEligibility", () => {
  it("reads the picker's own answer, both ways", async () => {
    const ranked = project("ranked");
    const empty = project("empty");
    plan(ranked, 3);
    plan(empty, 0);

    const eligibility = await observedWorkEligibility(tdb.db);

    expect(eligibilityOf(eligibility, ranked)).toBe(true);
    expect(eligibilityOf(eligibility, empty)).toBe(false);
  });

  it("never reports an unarmed picker as idle", async () => {
    // board-picker ships disabled, so most projects have no plan row at all. "Nobody looked" is not
    // "no work" — reading it as idle would strip a busy repo's share on a question never asked.
    const unobserved = project("unobserved");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db), unobserved)).toBeNull();
  });

  it("counts work already in flight, so a waking repo need not wait for the next picker pass", async () => {
    const waking = project("waking");
    plan(waking, 0);
    job(waking, "execute-epic", "queued");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db), waking)).toBe(true);
  });

  it("ignores jobs that are not a claim on the quota", async () => {
    const idle = project("idle");
    plan(idle, 0);
    // Settled work says nothing about now, and plumbing costs no Claude quota at all.
    job(idle, "execute-epic", "done");
    job(idle, "sync-push", "queued");

    expect(eligibilityOf(await observedWorkEligibility(tdb.db), idle)).toBe(false);
  });

  it("attributes nothing to anton's own project-less plumbing", async () => {
    tdb.db
      .insert(schema.jobs)
      .values({ id: randomUUID(), type: "execute-epic", status: "running", payloadJson: "{}" })
      .run();

    expect((await observedWorkEligibility(tdb.db)).size).toBe(0);
  });
});
