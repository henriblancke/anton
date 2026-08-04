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
import type { DeltaState } from "./stringer";

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
    left = undefined;
    baselines = 0;
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "p",
      name: "p",
      repoPath: "/tmp/p",
      defaultBranch: "main",
    });
  });
  afterEach(() => tdb.close());

  /**
   * The scan chain a nightly series really forms: each pass measures against the stringer baseline
   * the pass before it left, and leaves a fresh one. The first has none to measure against — it
   * establishes the baseline, so its counts are the whole repo.
   */
  let left: string | undefined;
  let baselines = 0;
  const chained = (): DeltaState => {
    const before = left;
    left = `baseline-${(baselines += 1)}`;
    return { ...(before ? { before } : {}), after: left, baselineScan: before === undefined };
  };

  const save = (
    c: ScanCounts,
    extra: { triage?: TriageOutcome; collectorFailures?: number; deltaState?: DeltaState } = {},
  ) => {
    const { deltaState = chained(), ...rest } = extra;
    return saveScanSummary(tdb.db, clock, { projectId, counts: c, deltaState, ...rest });
  };

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

  it("flags the whole-repo scans, so the chart never plots one as arrivals", async () => {
    const baseline = await save(counts({ low: 100 }));
    clock.advance(1000);
    const incremental = await save(counts({ low: 2 }));

    expect(baseline.baselineScan).toBe(true);
    expect(incremental.baselineScan).toBe(false);
    // Read back, not just returned — the chart reads rows, and the flag has to outlive the baseline.
    const [latest, first] = await listScanSummaries(tdb.db, projectId);
    expect(latest.baselineScan).toBe(false);
    expect(first.baselineScan).toBe(true);
    expect(scanHealth([latest, first])?.points.map((p) => p.baseline)).toEqual([true, undefined]);
  });

  it("leaves a scan whose basis anton could not identify unclassified, not baseline", async () => {
    // stringer keeping its state where anton doesn't look reports no baseline either side of every
    // scan. Reading that as "established the baseline" would label an incremental series whole-repo
    // forever — the flag has to come from what the scan observed, not from a missing `before`.
    const unknown = await save(counts({ low: 6 }), { deltaState: {} });

    expect(unknown.baselineScan).toBeUndefined();
    const [row] = await listScanSummaries(tdb.db, projectId);
    expect(row.baselineScan).toBeUndefined();
    expect(summarizeScanLine(row)).toContain("no comparable previous scan");
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

  it("suppresses the delta when stringer's baseline was reset under a running series", async () => {
    // The two states have independent lifetimes: stringer keeps its baseline in the REPO, this
    // series lives in a disposable anton.db. Wiping `.stringer/` mid-series makes the next scan a
    // whole-repo baseline again — and counting predecessors would happily subtract a settled
    // incremental scan from it and chart a spike nothing in the codebase caused.
    await save(counts({ low: 5 })); // establishes the baseline
    clock.advance(1000);
    await save(counts({ low: 2 })); // incremental — the first comparable point
    clock.advance(1000);

    const reset = await save(counts({ low: 90 }), {
      deltaState: { after: "baseline-fresh", baselineScan: true },
    });
    expect(reset.delta).toBeUndefined();

    // And nothing may be compared to a standing total either — the point AFTER the reset is the
    // first honest one, exactly as after a project's very first scan.
    clock.advance(1000);
    const afterReset = await save(counts({ low: 3 }), {
      deltaState: { before: "baseline-fresh", after: "baseline-next" },
    });
    expect(afterReset.delta).toBeUndefined();

    clock.advance(1000);
    const settled = await save(counts({ low: 1 }), {
      deltaState: { before: "baseline-next", after: "baseline-after" },
    });
    expect(settled.delta?.total).toBe(-2);
  });

  it("compares from its SECOND point when the series outlives its anton.db", async () => {
    // A rebuilt anton.db leaves the repo's baseline standing, so the first scan of the new series is
    // already incremental — its successor is comparable, and suppressing it (as a predecessor count
    // must) would throw away an honest delta.
    const first = await save(counts({ low: 4 }), {
      deltaState: { before: "baseline-survived", after: "baseline-1" },
    });
    expect(first.delta).toBeUndefined(); // nothing stored before it to compare against

    clock.advance(1000);
    const second = await save(counts({ low: 1 }), {
      deltaState: { before: "baseline-1", after: "baseline-2" },
    });
    expect(second.delta?.total).toBe(-3);
  });

  it("suppresses the delta when a scan anton never recorded consumed the baseline in between", async () => {
    // Someone ran `stringer scan --delta` by hand between two nightlies: the pass that follows
    // measures a window that starts somewhere anton's series never saw, so its counts are not
    // against the previous point at all.
    await save(counts({ low: 5 }));
    clock.advance(1000);
    await save(counts({ low: 4 }));
    clock.advance(1000);

    const stranded = await save(counts({ low: 1 }), {
      deltaState: { before: "baseline-elsewhere", after: "baseline-later" },
    });
    expect(stranded.delta).toBeUndefined();
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

  it("lets an attempt that scanned nothing of its own contribute the triage outcome", async () => {
    // Only such an attempt can be reporting on the RETAINED signals: it consumed no window, so it
    // triaged the one already on the point (see the rescan case below).
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

  it("refuses a rescanning retry's triage — it reports on part of the window only", async () => {
    // The first attempt found 7 signals against b0 and died before triage reported. The retry
    // measures against b1 and files 2 beads for ITS 2 signals. The point folds to 9, and pinning
    // that outcome on it would read "9 signals triaged into 2 beads" for seven nobody triaged.
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
      deltaState: { before: "b0", after: "b1" },
    });
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 2 }),
      deltaState: { before: "b1", after: "b2" },
      triage: { created: 2, deduped: 0 },
    });

    expect(retry.triage).toBeUndefined();
    const [row] = await listScanSummaries(tdb.db, projectId);
    expect(row.triage).toBeUndefined();
    // The baseline correction is a separate fact and still lands — the next scan consumes b2.
    expect(row.deltaState).toBe("b2");
  });

  it("folds a retry's own scan window into the point, so its signals aren't lost", async () => {
    // A retry after a long quota backoff scans a genuinely later delta window: those signals are
    // consumed from stringer's baseline and no scan will ever report them again. The retry measured
    // from exactly the baseline the point publishes, so the two windows abut — the point is the
    // whole pass, b0 → b2, and its delta against the previous point widens with it.
    await save(counts({ low: 3 }), { deltaState: { before: "b-1", after: "b0" } });
    clock.advance(86_400_000);
    const first = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 5 }),
      deltaState: { before: "b0", after: "b1" },
    });
    expect(first.delta?.total).toBe(2);

    clock.advance(86_400_000);
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ critical: 1, low: 2 }),
      deltaState: { before: "b1", after: "b2" },
    });

    expect(retry.counts.total).toBe(8);
    expect(retry.counts.bySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 7 });
    expect(retry.delta).toEqual({
      total: 5,
      bySeverity: { critical: 1, high: 0, medium: 0, low: 4 },
    });
    expect(retry.deltaState).toBe("b2");

    // Read back, not just returned — the chart reads rows, and one row is still all this pass gets.
    const rows = await listScanSummaries(tdb.db, projectId, 100);
    expect(rows.length).toBe(2);
    expect(rows[0].counts.total).toBe(8);
    expect(rows[0].counts.byClass.debt).toBe(8);
    expect(rows[0].delta?.total).toBe(5);
    // And the next nightly measures against the folded point, not the first attempt's counts.
    clock.advance(86_400_000);
    const next = await save(counts({ low: 6 }), { deltaState: { before: "b2", after: "b3" } });
    expect(next.delta?.total).toBe(-2);
  });

  it("does not fold a retry that rescanned from somewhere else — no proof the windows abut", async () => {
    // The retry re-established the baseline (or measured from one this point never published), so
    // its counts overlap the retained ones by an unknown amount. Adding them would invent arrivals.
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 5 }),
      deltaState: { before: "b0", after: "b1" },
    });
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 90 }),
      deltaState: { after: "b2", baselineScan: true },
    });

    expect(retry.counts.total).toBe(5);
    expect((await listScanSummaries(tdb.db, projectId))[0].counts.total).toBe(5);
  });

  it("moves the refresh token when a fold rewrites the newest row's counts", async () => {
    // The fold rewrites the row in place: a token that ignored the counts would keep 304-ing the
    // board past the very signals the fold exists to put on the chart.
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 5 }),
      deltaState: { before: "b0", after: "b1" },
    });
    const version = async () =>
      scanHealthVersion(scanHealth(await listScanSummaries(tdb.db, projectId, 100)));
    const before = await version();

    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 2 }),
      deltaState: { before: "b1", after: "b2" },
    });

    expect(await version()).not.toBe(before);
  });

  it("carries a retry's final baseline into the point it retained", async () => {
    // The first attempt measured against b0 and left b1, then died after scanning; the retry ran
    // stringer again and left b2. The point keeps the counts the pass measured, but the baseline it
    // publishes has to be the one the pass ULTIMATELY left — the next nightly consumes b2, and a
    // point still claiming b1 could never prove comparability, suppressing an honest delta forever.
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
      deltaState: { before: "b0", after: "b1" },
    });
    clock.advance(60_000);
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: emptyScanCounts(),
      deltaState: { before: "b1", after: "b2" },
    });

    expect(retry.counts.total).toBe(7); // the retry's own counts are NOT the pass's measurement
    expect(retry.deltaState).toBe("b2");
    expect((await listScanSummaries(tdb.db, projectId))[0].deltaState).toBe("b2");

    clock.advance(86_400_000);
    const next = await save(counts({ low: 4 }), { deltaState: { before: "b2", after: "b3" } });
    expect(next.delta?.total).toBe(-3);
  });

  it("clears the retained baseline when the retry left one anton cannot identify", async () => {
    // The retry still advanced stringer's state, so the published baseline is stale whatever anton
    // could read — and a stale one is a claim, where absent is the honest "not comparable".
    await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 7 }),
      deltaState: { before: "b0", after: "b1" },
    });
    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: emptyScanCounts(),
      deltaState: {},
    });

    expect(retry.deltaState).toBeUndefined();
    expect((await listScanSummaries(tdb.db, projectId))[0].deltaState).toBeUndefined();
  });

  it("never lets a retry give a whole-repo point a baseline to be measured against", async () => {
    // The retained counts are a standing total, so nothing may be subtracted from them — the retry's
    // baseline must not manufacture the comparison the first attempt refused to offer.
    const first = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: counts({ low: 100 }),
      deltaState: { after: "b1", baselineScan: true },
    });
    expect(first.deltaState).toBeUndefined();

    const retry = await saveScanSummary(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      counts: emptyScanCounts(),
      deltaState: { before: "b1", after: "b2" },
    });
    expect(retry.deltaState).toBeUndefined();

    clock.advance(86_400_000);
    const next = await save(counts({ low: 3 }), { deltaState: { before: "b2", after: "b3" } });
    expect(next.delta).toBeUndefined();
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

  it("suppresses the delta on both sides of a scan that lost a collector", async () => {
    await save(counts({ low: 5 })); // baseline
    clock.advance(1000);
    // The outage undercounts, so the drop it shows is the dead collector, not a quieter repo …
    const incomplete = await save(counts({ low: 1 }), { collectorFailures: 1 });
    clock.advance(1000);
    // … and the recovery back to a full collector set is not a regression either.
    const recovered = await save(counts({ low: 4 }));
    clock.advance(1000);
    const whole = await save(counts({ low: 2 }));

    expect(incomplete.delta).toBeUndefined();
    expect(recovered.delta).toBeUndefined();
    // Two whole scans in a row: comparable again, no permanent break in the chain.
    expect(whole.delta?.total).toBe(-2);
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
    expect(scanHealthVersion(health)).toBe("c:2");
  });

  it("stamps the mutable fields into the version — a retry rewrites them in an existing row", () => {
    const latest = summary("c", 300, 2);
    expect(scanHealthVersion(scanHealth([latest]))).toBe("c:2");
    // Triage backfilled, and a folded retry window growing the counts, both move the token.
    expect(scanHealthVersion(scanHealth([{ ...latest, triage: { created: 2, deduped: 1 } }]))).toBe(
      "c:2:2:1",
    );
    expect(scanHealthVersion(scanHealth([summary("c", 300, 9)]))).toBe("c:9");
  });

  it("marks every incomplete column, not only the latest scan", () => {
    // Suppressing the delta keeps an outage out of the TREND, but its column stays on the chart for
    // the whole window — unmarked, an incomplete zero is drawn as the clean-pass tick and the next
    // honest scan reads as a regression from an improvement that never happened.
    const health = scanHealth([
      summary("c", 300, 2),
      { ...summary("b", 200, 0), collectorFailures: 2 },
      summary("a", 100, 1),
    ])!;
    expect(health.points.map((p) => p.incomplete)).toEqual([undefined, true, undefined]);
    expect(health.latest.incomplete).toBeUndefined();
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

  it("names a collector failure as the reason a scan has no delta", () => {
    const line = summarizeScanLine({
      id: "x",
      projectId: "p",
      generatedAt: 1,
      counts: emptyScanCounts(),
      collectorFailures: 2,
    });
    expect(line).toContain("collector failures — counts are an undercount");
  });
});
