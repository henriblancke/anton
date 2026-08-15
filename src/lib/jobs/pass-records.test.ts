/**
 * The seam between a pass's session log and the jobs page (anton-hzce).
 *
 * The one rule worth a suite of its own: a pass job ALWAYS gets an entry. A gardener patrol over a
 * clean board deliberately opens no session at all, so "no log" is the ordinary shape of a quiet
 * night — and a missing entry would render as a row whose record failed to load rather than as the
 * clean pass it was.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPassJob, passRecordsByJob } from "./pass-records";
import type { JobType } from "./queue";

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

const job = (id: string, type: JobType) => ({ id, type });

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
        g1: { id: "s-g1", logPath: logFile("g1.log", APPLIED) },
        pm1: {
          id: "s-pm1",
          logPath: logFile(
            "pm1.log",
            "[assistant] thinking out loud\n" +
              "[product-master] SHADOW p-2 (low-value) retire/defer t-9 — WOULD REFUSE: t-9 moved\n",
          ),
        },
      },
    );

    expect(records.g1.records.map((r) => r.outcome)).toEqual(["applied"]);
    expect(records.pm1.records.map((r) => r.detail)).toEqual(["t-9 moved"]);
  });

  it("gives a pass that opened no session an empty record, not no record", async () => {
    const records = await passRecordsByJob([job("quiet", "gardener")], {});

    expect(records.quiet).toEqual({ records: [], notes: [] });
  });

  it("survives a log the row points at but the disk no longer has", async () => {
    // `.anton` is disposable — an operator who cleared it must still get the jobs list.
    const records = await passRecordsByJob([job("g2", "gardener")], {
      g2: { id: "s-g2", logPath: join(workDir, "never-written.log") },
    });

    expect(records.g2).toEqual({ records: [], notes: [] });
  });

  it("says nothing about jobs that file no proposals", async () => {
    const records = await passRecordsByJob(
      [job("e1", "execute-epic"), job("g3", "gardener")],
      { e1: { id: "s-e1", logPath: logFile("e1.log", APPLIED) }, g3: { id: "s-g3" } },
    );

    expect(Object.keys(records)).toEqual(["g3"]);
  });
});
