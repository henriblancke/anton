/**
 * The write cap across a job's ATTEMPTS (anton-zy7f).
 *
 * The property under test is the one a retry breaks: `MAX_APPLIES_PER_PASS` bounds what one PASS
 * writes to the board unattended, and the runner retries a pass that died after its writes under the
 * same job id. Every case here is a way an attempt's spend could go unseen — and what this reads
 * instead of quietly handing the retry a fresh cap.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { MAX_APPLIES_PER_PASS } from "../gardener/emit";
import { remainingApplyBudget } from "./pass-budget";
import { insertProject } from "@/lib/testing/project";

let t: TestDb;
let workDir: string;
let logged: string[];
const projectId = "p1";
const JOB = "job-1";

const applyLine = (n: number, verdict = "APPLIED"): string =>
  `[product-master] APPLY anton-p${n} (low-value) retire/defer anton-a${n} — ` +
  `${verdict}: deferred anton-a${n}\n`;

/** One earlier attempt of {@link JOB}: a session row pointing at the log it wrote. */
async function attempt(name: string, log: string | undefined, at: number): Promise<string> {
  const logPath = join(workDir, `${name}.log`);
  if (log !== undefined) writeFileSync(logPath, log);
  await t.db.insert(schema.sessions).values({
    id: name,
    projectId,
    jobId: JOB,
    kind: "product-master",
    status: "failed",
    logPath,
    startedAt: new Date(at),
  });
  return logPath;
}

const budget = () =>
  remainingApplyBudget({
    db: t.db,
    jobId: JOB,
    producer: "[product-master]",
    log: async (chunk) => {
      logged.push(chunk);
    },
  });

beforeEach(async () => {
  t = makeTestDb();
  workDir = mkdtempSync(join(tmpdir(), "anton-pass-budget-"));
  logged = [];
  insertProject(t.db, { id: projectId, slug: "p1", name: "p1", repoPath: workDir });
  await t.db
    .insert(schema.jobs)
    .values({ id: JOB, type: "product-master", projectId, status: "running" });
});

afterEach(() => {
  t.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("remainingApplyBudget", () => {
  it("gives a first attempt the whole cap, and says nothing about it", async () => {
    expect(await budget()).toBe(MAX_APPLIES_PER_PASS);
    expect(logged).toEqual([]);
  });

  it("takes what earlier attempts spent off the cap, and says so", async () => {
    await attempt("s-1", applyLine(1) + applyLine(2), 1_700_000_000_000);

    expect(await budget()).toBe(MAX_APPLIES_PER_PASS - 2);
    // Never a silent cap: a retry that applied one has to read apart from one that found one.
    expect(logged.join("")).toContain(
      "[product-master] APPLY budget: earlier attempt(s) of this job already spent 2 of the " +
        "unattended write budget on apply attempts — the cap counts attempts, so some may have " +
        "been refused or have failed rather than moved the board; this job's record carries " +
        "each one's verdict — one pass applies at most 3, so this attempt may apply 1",
    );
  });

  it("never reports a spend of refused or failed attempts as a board move", async () => {
    // The note is what an operator audits a retry against, and it is written off a count of
    // ATTEMPTS: every apply here was declined or broke before writing, so a note saying two
    // proposals were applied would send them looking for beads that never moved.
    await attempt(
      "s-1",
      applyLine(1, "REFUSED") + applyLine(2, "COULD NOT APPLY"),
      1_700_000_000_000,
    );

    expect(await budget()).toBe(MAX_APPLIES_PER_PASS - 2);
    expect(logged.join("")).toContain("spent 2 of the unattended write budget on apply attempts");
    expect(logged.join("")).not.toContain("already applied");
  });

  it("counts what the cap counts — every ATTEMPT to apply, however the board answered", async () => {
    // The cap bounds unattended work, not successful writes: a refusal and a rolled-back write each
    // cost a pass the same board reads and locks an apply does.
    await attempt(
      "s-1",
      applyLine(1) + applyLine(2, "REFUSED") + applyLine(3, "COULD NOT APPLY"),
      1_700_000_000_000,
    );

    expect(await budget()).toBe(0);
  });

  it("counts a reserved apply ONCE, and counts one whose outcome never landed at all", async () => {
    // An apply buys its line before it touches the board and records the outcome after
    // (gardener/armed.ts). Counting the pair twice would cost a retry a write it never made; missing
    // the lone reservation would hand it a cap the attempt before it had already spent — the write
    // is on the board whether or not anything got to say how it went.
    await attempt(
      "s-1",
      applyLine(1, "APPLYING") + applyLine(1) + applyLine(2, "APPLYING"),
      1_700_000_000_000,
    );

    expect(await budget()).toBe(MAX_APPLIES_PER_PASS - 2);
  });

  it("ignores what a pass only described — a shadow writes nothing to spend", async () => {
    await attempt(
      "s-1",
      "[product-master] SHADOW anton-p1 (low-value) retire/defer anton-a — WOULD APPLY: defer\n" +
        "[product-master] APPLY held back 2 armed proposal(s) — one pass applies at most 3\n" +
        "[assistant] APPLY anton-p9 (low-value) retire/defer anton-a — APPLIED: not anton's line\n",
      1_700_000_000_000,
    );

    expect(await budget()).toBe(MAX_APPLIES_PER_PASS);
    expect(logged).toEqual([]);
  });

  it("adds up every attempt, and never goes below zero", async () => {
    await attempt("s-1", applyLine(1) + applyLine(2), 1_700_000_000_000);
    await attempt("s-2", applyLine(3) + applyLine(4), 1_700_000_060_000);

    expect(await budget()).toBe(0);
  });

  it("gives the full cap to a job whose earlier attempt never wrote a line", async () => {
    // The ordinary shape of an attempt that died early: its log was opened with its session row and
    // nothing was ever appended — and an apply is recorded as it happens, so it applied nothing.
    await attempt("s-1", "", 1_700_000_000_000);

    expect(await budget()).toBe(MAX_APPLIES_PER_PASS);
    expect(logged).toEqual([]);
  });

  it("applies NOTHING when an earlier attempt's session row has no log behind it", async () => {
    // A pass opens its log WITH its row (pass-preamble.ts), so a row with no log is a log store that
    // broke — which is exactly the moment an apply's record goes unwritten. Reading that as "the
    // attempt was quiet" is what would hand this retry a fresh allowance over writes already made.
    await attempt("s-1", undefined, 1_700_000_000_000);

    expect(await budget()).toBe(0);
    expect(logged.join("")).toContain("a session log of this job could not be read");
  });

  it("applies NOTHING when an earlier attempt's log will not read", async () => {
    // What that attempt spent is unknowable, and the direction that fails safe for a write nobody
    // is watching is to spend none of the cap — out loud, never by quietly arming.
    mkdirSync(join(workDir, "s-1.log"));
    await attempt("s-1", undefined, 1_700_000_000_000);

    expect(await budget()).toBe(0);
    expect(logged.join("")).toContain("a session log of this job could not be read");
  });

  it("never blames an EARLIER attempt for a log that can only be this attempt's own", async () => {
    // A pass that opens its session up front (product-master) is already in this read, so the only
    // unreadable log a FIRST attempt can find is its own. The answer is the same one — a log store
    // broken now is one this attempt could not record its own writes against either — but a note
    // that invents an earlier attempt sends an operator looking for a pass that never ran.
    await attempt("s-current", undefined, 1_700_000_000_000);

    expect(await budget()).toBe(0);
    expect(logged.join("")).not.toContain("earlier attempt");
    expect(logged.join("")).toContain("this attempt's own included");
  });
});
