/**
 * The per-scan health series (anton-bz1w). What matters here: every pass leaves exactly one
 * comparable record, the delta it stores is the one it measured (not one re-derived from a pruned
 * history), and the two claims a monitor must never confuse — "never scanned" and "scanned, found
 * nothing" — stay distinguishable all the way to the board's view model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import type { Clock } from "./jobs/queue";
import {
  SCAN_SUMMARY_RETENTION,
  emptyScanCounts,
  getLatestScanSummary,
  listScanSummaries,
  parseTriageOutcome,
  saveScanSummary,
  scanHealth,
  scanHealthVersion,
  summarizeScanLine,
  summarizeSignals,
  type ScanCounts,
  type SeverityCounts,
  type TriageOutcome,
} from "./scan-health";
import { SCAN_SEVERITIES } from "./scan-severity";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

describe("summarizeSignals", () => {
  it("counts a scan on both axes, with every key present", () => {
    const counts = summarizeSignals([
      { Source: "vuln", Kind: "osv" },
      { Source: "todos", Kind: "todo" },
      { Source: "todos", Kind: "fixme" },
      { Source: "dephealth", Kind: "deprecated-dep" },
    ]);
    expect(counts.total).toBe(4);
    expect(counts.bySeverity).toEqual({ critical: 1, high: 0, medium: 1, low: 2 });
    expect(counts.byClass.security).toBe(1);
    expect(counts.byClass.debt).toBe(2);
    expect(counts.byClass.dependencies).toBe(1);
    expect(counts.byClass.docs).toBe(0);
  });

  it("counts an empty scan as a real zero, not as absent data", () => {
    expect(summarizeSignals([])).toEqual(emptyScanCounts());
  });
});

describe("parseTriageOutcome", () => {
  it("reads the /scan-triage report line", () => {
    const line =
      "created: 3 (1 features, 2 tickets) · epics: 1 attached, 0 created · deduped: 5 · " +
      "dropped-as-noise: 12 · deferred (over cap): 0";
    expect(parseTriageOutcome(line)).toEqual({ created: 3, deduped: 5 });
  });

  it("is undefined when the session reported nothing parseable — never a fabricated zero", () => {
    expect(parseTriageOutcome(undefined)).toBeUndefined();
    expect(parseTriageOutcome("I triaged some things.")).toBeUndefined();
  });

  it("rejects a HALF-reported line — an agent's partial protocol is still no outcome", () => {
    // Storing `deduped: 0` here would put "triage deduped nothing" on the chart for a pass that
    // never said so; "not reported" is the only honest reading of a broken report line.
    expect(parseTriageOutcome("created: 3 (1 features, 2 tickets)")).toBeUndefined();
    expect(parseTriageOutcome("deduped: 5 (cross-linked: 2)")).toBeUndefined();
  });
});

describe("the persisted series", () => {
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;

  /** Counts carrying the given severity split; the class axis rides along as debt. */
  const counts = (split: Partial<SeverityCounts>): ScanCounts => {
    const c = emptyScanCounts();
    for (const severity of SCAN_SEVERITIES) c.bySeverity[severity] = split[severity] ?? 0;
    c.total = SCAN_SEVERITIES.reduce((sum, s) => sum + c.bySeverity[s], 0);
    c.byClass.debt = c.total;
    return c;
  };

  beforeEach(async () => {
    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "p",
      name: "p",
      repoPath: "/tmp/p",
      defaultBranch: "main",
    });
  });
  afterEach(() => tdb.close());

  const save = (
    c: ScanCounts,
    extra: { triage?: TriageOutcome; collectorFailures?: number } = {},
  ) => saveScanSummary(tdb.db, clock, { projectId, counts: c, ...extra });

  it("stores the first scan with no delta — nothing to compare to is not `no change`", async () => {
    const first = await save(counts({ low: 4 }));
    expect(first.delta).toBeUndefined();
    expect((await getLatestScanSummary(tdb.db, projectId))?.delta).toBeUndefined();
  });

  it("does not compare the second scan to the baseline — unlike quantities, not a trend", async () => {
    // The first scan has no `--delta` baseline, so stringer emits the whole repo: 100 outstanding
    // signals followed by 1 newly arrived is NOT "-99, problems arriving more slowly".
    await save(counts({ low: 100 }));
    clock.advance(86_400_000);
    const second = await save(counts({ low: 1 }));

    expect(second.delta).toBeUndefined();
    expect((await getLatestScanSummary(tdb.db, projectId))?.delta).toBeUndefined();
  });

  it("stores each later scan's delta against the one before it", async () => {
    await save(counts({ low: 9 })); // baseline — the second scan is the first comparable one
    clock.advance(86_400_000);
    await save(counts({ critical: 1, low: 5 }));
    clock.advance(86_400_000);
    const third = await save(counts({ critical: 0, low: 2 }));

    expect(third.delta).toEqual({
      total: -4,
      bySeverity: { critical: -1, high: 0, medium: 0, low: -3 },
    });
    // Read back, not just returned: the chart reads rows, not the write's return value.
    expect((await getLatestScanSummary(tdb.db, projectId))?.delta?.total).toBe(-4);
  });

  it("records one point per job, however many attempts it took", async () => {
    // The runner retries a failed job under the same id, and the retry rescans a baseline the first
    // attempt already consumed — a second row would chart a phantom scan and skew the next delta.
    const first = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
    });
    clock.advance(60_000);
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: emptyScanCounts(),
    });

    expect(retry.id).toBe(first.id);
    const all = await listScanSummaries(tdb.db, projectId, 100);
    expect(all.length).toBe(1);
    expect(all[0].counts.total).toBe(7);
  });

  it("lets a retry contribute the triage outcome its first attempt died before reporting", async () => {
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
    });
    const version = async () => scanHealthVersion(scanHealth(await listScanSummaries(tdb.db, projectId, 100)));
    const before = await version();

    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
      triage: { created: 2, deduped: 4 },
    });

    expect(retry.triage).toEqual({ created: 2, deduped: 4 });
    expect((await listScanSummaries(tdb.db, projectId, 100))[0].triage).toEqual({
      created: 2,
      deduped: 4,
    });
    // The backfill rewrites the row in place: a token built from the row id alone would keep 304-ing
    // the board past the very write it exists to show.
    expect(await version()).not.toBe(before);
  });

  it("reads a half-written triage row as unreported, never as a zero someone claimed", async () => {
    // Both counters come from one TriageOutcome, so one column alone is a broken write — filling the
    // other with 0 would put a triage result on the chart that no session ever reported.
    await tdb.db.insert(schema.scanSummaries).values({
      id: randomUUID(),
      projectId,
      generatedAt: new Date(clock.now()),
      totalSignals: 1,
      bySeverityJson: "{}",
      byClassJson: "{}",
      beadsCreated: 3,
      beadsDeduped: null,
      collectorFailures: 0,
    });
    expect((await listScanSummaries(tdb.db, projectId))[0].triage).toBeUndefined();
  });

  it("records triage counts only when triage reported them", async () => {
    const reported = await save(counts({ low: 2 }), { triage: { created: 1, deduped: 3 } });
    expect(reported.triage).toEqual({ created: 1, deduped: 3 });

    clock.advance(1000);
    const silent = await save(counts({ low: 1 }));
    expect(silent.triage).toBeUndefined();
    expect((await listScanSummaries(tdb.db, projectId))[0].triage).toBeUndefined();
  });

  it("keeps a scan that found nothing — a clean pass is the point of the trend", async () => {
    await save(counts({ low: 1 })); // baseline
    clock.advance(1000);
    await save(counts({ low: 3 }));
    clock.advance(1000);
    const clean = await save(emptyScanCounts());
    expect(clean.counts.total).toBe(0);
    expect(clean.delta?.total).toBe(-3);
  });

  it("prunes to the retention window, newest kept", async () => {
    for (let i = 0; i < SCAN_SUMMARY_RETENTION + 5; i += 1) {
      await save(counts({ low: i }));
      clock.advance(60_000);
    }
    const all = await listScanSummaries(tdb.db, projectId, 1000);
    expect(all.length).toBe(SCAN_SUMMARY_RETENTION);
    expect(all[0].counts.total).toBe(SCAN_SUMMARY_RETENTION + 4);
  });

  it("carries the collector-failure count, so an undercount stays visible", async () => {
    const summary = await save(counts({ low: 1 }), { collectorFailures: 2 });
    expect(summary.collectorFailures).toBe(2);
    expect((await getLatestScanSummary(tdb.db, projectId))?.collectorFailures).toBe(2);
  });
});

describe("scanHealth (the board's view)", () => {
  const summary = (id: string, at: number, low: number, delta?: number) => ({
    id,
    projectId: "p",
    generatedAt: at,
    counts: {
      total: low,
      bySeverity: { critical: 0, high: 0, medium: 0, low },
      byClass: { security: 0, dependencies: 0, debt: low, risk: 0, docs: 0, other: 0 },
    },
    ...(delta === undefined
      ? {}
      : { delta: { total: delta, bySeverity: { critical: 0, high: 0, medium: 0, low: delta } } }),
    collectorFailures: 0,
  });

  it("is undefined for a project nothing has ever scanned", () => {
    expect(scanHealth([])).toBeUndefined();
    expect(scanHealthVersion(undefined)).toBe("none");
  });

  it("charts oldest → newest, and reports the latest scan's delta", () => {
    // Rows arrive newest-first, as listScanSummaries returns them.
    const health = scanHealth([summary("c", 300, 2, -3), summary("b", 200, 5, 4), summary("a", 100, 1)])!;
    expect(health.points.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(health.latest.id).toBe("c");
    expect(health.delta?.total).toBe(-3);
    expect(scanHealthVersion(health)).toBe("c");
  });

  it("stamps the triage counts into the version — a backfill rewrites them in an existing row", () => {
    const latest = summary("c", 300, 2);
    expect(scanHealthVersion(scanHealth([latest]))).toBe("c");
    expect(scanHealthVersion(scanHealth([{ ...latest, triage: { created: 2, deduped: 1 } }]))).toBe(
      "c:2:1",
    );
  });

  it("keeps a first-ever scan's missing delta missing", () => {
    expect(scanHealth([summary("a", 100, 3)])!.delta).toBeUndefined();
  });
});

describe("summarizeScanLine", () => {
  it("says what the scan found and how it moved", () => {
    const line = summarizeScanLine({
      id: "x",
      projectId: "p",
      generatedAt: 1,
      counts: {
        total: 3,
        bySeverity: { critical: 1, high: 0, medium: 0, low: 2 },
        byClass: { security: 1, dependencies: 0, debt: 2, risk: 0, docs: 0, other: 0 },
      },
      delta: { total: -2, bySeverity: { critical: 0, high: 0, medium: 0, low: -2 } },
      triage: { created: 2, deduped: 1 },
      collectorFailures: 0,
    });
    expect(line).toContain("3 signal(s) (1 critical, 2 low)");
    expect(line).toContain("-2 vs previous scan");
    expect(line).toContain("triage created 2, deduped 1");
  });

  it("names an uncomparable scan as such rather than showing a zero delta", () => {
    const line = summarizeScanLine({
      id: "x",
      projectId: "p",
      generatedAt: 1,
      counts: emptyScanCounts(),
      collectorFailures: 0,
    });
    expect(line).toContain("no comparable previous scan — no delta");
  });
});
