/**
 * The seam between a pass's session log and the jobs page (anton-hzce).
 *
 * The one rule worth a suite of its own: a COMPLETED pass job always gets an entry. A gardener
 * patrol over a clean board deliberately opens no session at all, so "no log" is the ordinary shape
 * of a quiet night — and a missing entry would render as a row whose record failed to load rather
 * than as the clean pass it was. A pass that never finished is the opposite claim, and gets none.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPassJob, passRecordsByJob } from "./pass-records";
import type { JobStatus, JobType } from "./queue";

let workDir: string;

/** Write a log and return the path, as a session row would carry it. */
function logFile(name: string, contents: string): string {
  const path = join(workDir, name);
  writeFileSync(path, contents);
  return path;
}

const APPLIED =
  "[gardener] APPLY p-1 (shipped-orphan) retire/close t-4 — APPLIED: closed t-4 as shipped\n";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "anton-pass-records-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const job = (id: string, type: JobType, status: JobStatus = "done") => ({ id, type, status });

describe("isPassJob", () => {
  it("is the two job types that file proposals, and nothing else", () => {
    expect(isPassJob("gardener")).toBe(true);
    expect(isPassJob("product-master")).toBe(true);
    expect(isPassJob("execute-epic")).toBe(false);
    expect(isPassJob("nightly-stringer")).toBe(false);
  });
});

describe("passRecordsByJob", () => {
  it("reads each pass's record out of the log its session points at", async () => {
    const records = await passRecordsByJob(
      [job("g1", "gardener"), job("pm1", "product-master")],
      {
        g1: { id: "s-g1", logPaths: [logFile("g1.log", APPLIED)] },
        pm1: {
          id: "s-pm1",
          logPaths: [
            logFile(
              "pm1.log",
              "[assistant] thinking out loud\n" +
                "[product-master] SHADOW p-2 (low-value) retire/defer t-9 — WOULD REFUSE: t-9 moved\n",
            ),
          ],
        },
      },
    );

    expect(records.g1.records.map((r) => r.outcome)).toEqual(["applied"]);
    expect(records.pm1.records.map((r) => r.detail)).toEqual(["t-9 moved"]);
  });

  it("gives a COMPLETED pass that opened no session an empty record, not no record", async () => {
    const records = await passRecordsByJob([job("quiet", "gardener", "done")], {});

    expect(records.quiet).toEqual({ records: [], notes: [] });
  });

  // "No session" means "nothing to say" only for a pass that reached the end. A gardener job that
  // dies mid-`applySafeVerbs` never opens its deferred session either, and rendering "Clean pass —
  // nothing applied, shadowed or refused" over that is the one lie this record exists to prevent.
  it("says nothing about a pass that has not completed and opened no session", async () => {
    const records = await passRecordsByJob(
      [
        job("waiting", "gardener", "queued"),
        job("mid-flight", "product-master", "running"),
        job("broke", "gardener", "failed"),
        job("stopped", "gardener", "cancelled"),
        job("stuck", "product-master", "parked"),
      ],
      {},
    );

    expect(Object.keys(records)).toEqual([]);
  });

  it("reads the record of an unfinished pass that DID open a session", async () => {
    const records = await passRecordsByJob([job("broke", "gardener", "failed")], {
      broke: { id: "s-broke", logPaths: [logFile("broke.log", APPLIED)] },
    });

    expect(records.broke.records.map((r) => r.outcome)).toEqual(["applied"]);
  });

  // The same claim as the no-session case, and it has to fail the same way: a product-master pass
  // that is still judging has a session log full of transcript and no record line in it yet. An
  // empty summary there would render "Clean pass" under a job whose judgment has not finished — or,
  // worse, under one that failed after opening its session but before deciding anything.
  it("says nothing about an unfinished pass whose log holds no record yet", async () => {
    const records = await passRecordsByJob(
      [job("mid-flight", "product-master", "running"), job("broke-early", "gardener", "failed")],
      {
        "mid-flight": {
          id: "s-mid",
          logPaths: [logFile("mid.log", "[assistant] still reading the board\n")],
        },
        "broke-early": { id: "s-early", logPaths: [logFile("early.log", "")] },
      },
    );

    expect(Object.keys(records)).toEqual([]);
  });

  // The product-master pass writes its revalidation tier's APPLY lines BEFORE it streams a claude
  // transcript, so anything reading only the end of the log drops an unattended write and calls the
  // pass clean. The transcript here is comfortably past the old 256KB tail window.
  it("finds a record buried under a transcript far longer than any tail window", async () => {
    const transcript = "[assistant] thinking out loud, at length\n".repeat(20_000);
    const records = await passRecordsByJob([job("pm2", "product-master")], {
      pm2: {
        id: "s-pm2",
        logPaths: [
          logFile(
            "pm2.log",
            "[product-master] APPLY p-1 (degraded-approval) unapprove t-1 — APPLIED: withdrew t-1\n" +
              transcript +
              "[product-master] 0 claim(s) reported, 0 accepted\n",
          ),
        ],
      },
    });

    expect(records.pm2.records.map((r) => r.proposal)).toEqual(["p-1"]);
  });

  it("survives a log the row points at but the disk no longer has — and says the read failed", async () => {
    // `.anton` is disposable — an operator who cleared it must still get the jobs list. But an
    // empty summary here would render as "Clean pass" over a pass whose only record of an
    // unattended write is the file we just failed to read, so the failure is the answer.
    const records = await passRecordsByJob([job("g2", "gardener")], {
      g2: { id: "s-g2", logPaths: [join(workDir, "never-written.log")] },
    });

    expect(records.g2.records).toEqual([]);
    expect(records.g2.notes).toEqual([
      "this pass's session log could not be read — whatever it applied, shadowed or refused is not recorded here",
    ]);
  });

  // A retried job opens one session per attempt, and each log holds only that attempt's writes. An
  // attempt that applied a proposal unattended and then failed is a board write like any other —
  // reading the newest log alone would hide it behind a clean retry.
  it("reads every attempt of a job as one record, oldest first", async () => {
    const records = await passRecordsByJob([job("pm3", "product-master")], {
      pm3: {
        id: "s-latest",
        logPaths: [
          logFile(
            "pm3-first.log",
            "[product-master] APPLY p-1 (degraded-approval) unapprove t-1 — APPLIED: withdrew t-1\n",
          ),
          logFile(
            "pm3-latest.log",
            "[product-master] SHADOW p-2 (low-value) retire/defer t-9 — WOULD APPLY: defer t-9\n",
          ),
        ],
      },
    });

    expect(records.pm3.records.map((r) => r.proposal)).toEqual(["p-1", "p-2"]);
    expect(records.pm3.records.map((r) => r.outcome)).toEqual(["applied", "shadowed"]);
  });

  it("names the attempt a note came from once a job has more than one", async () => {
    const records = await passRecordsByJob([job("pm4", "product-master")], {
      pm4: {
        id: "s-latest",
        logPaths: [join(workDir, "gone.log"), logFile("pm4-latest.log", "")],
      },
    });

    expect(records.pm4.notes).toEqual([
      "attempt 1 of 2: this pass's session log could not be read — whatever it applied, shadowed or refused is not recorded here",
    ]);
  });

  it("says nothing about jobs that file no proposals", async () => {
    const records = await passRecordsByJob(
      [job("e1", "execute-epic"), job("g3", "gardener")],
      { e1: { id: "s-e1", logPaths: [logFile("e1.log", APPLIED)] }, g3: { id: "s-g3", logPaths: [] } },
    );

    expect(Object.keys(records)).toEqual(["g3"]);
  });
});
