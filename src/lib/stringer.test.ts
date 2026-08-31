/**
 * Tests for the stringer wrapper (anton-3t2.3): arg construction (esp. the vendored-dir excludes
 * that keep a scan off a huge node_modules and away from the 10-minute timeout) and signal counting,
 * against a fake stringer binary that records its argv and writes a canned scan file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describeCouplingFilter } from "./scan-coupling";
import { describeDeadcodeFilter, filterDeadcodeSignals, SYMBOL_BUDGET } from "./scan-deadcode";
import { describeDuplicationFilter, filterDuplicationSignals } from "./scan-duplication";
import {
  DEFAULT_SCAN_EXCLUDES,
  STRINGER_BIN_ENV,
  describeCollectorFailure,
  describeUntrackedFilter,
  extractSignals,
  formatTimeout,
  parseCollectorFailures,
  scan,
} from "./stringer";
import { isPoisonError } from "./jobs/errors";

let dir: string;
let prevBin: string | undefined;
let prevTimeout: string | undefined;

/** Fake stringer with a scripted body (executable node script), for the failure-path tests. */
function writeScript(name: string, body: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, ["#!/usr/bin/env node", ...body, ""].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Fake stringer: records argv (minus node/script) to argvDump, writes canned signals to the -o path,
 * and optionally echoes canned slog lines to stderr (how a dead collector announces itself).
 */
function writeFakeStringer(argvDump: string, signals: unknown, stderr = ""): string {
  const path = join(dir, "fake-stringer");
  const body = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));`,
    "const i = process.argv.indexOf('-o');",
    `if (i !== -1) fs.writeFileSync(process.argv[i + 1], JSON.stringify(${JSON.stringify(signals)}));`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** Real stringer 1.8.3 stderr for a repo with extensions.worktreeConfig set (scan still exits 0). */
const WORKTREECONFIG_STDERR = [
  `time=2026-07-26T19:26:45.418-04:00 level=INFO msg=scanning collectors=15`,
  `time=2026-07-26T19:26:45.424-04:00 level=INFO msg="collector \\"gitlog\\" returned error: opening repo: core.repositoryformatversion does not support extension: worktreeconfig"`,
  `time=2026-07-26T19:26:45.452-04:00 level=ERROR msg="collector failed" name=gitlog error="opening repo: core.repositoryformatversion does not support extension: worktreeconfig" duration=4.748875ms`,
  `time=2026-07-26T19:26:45.452-04:00 level=INFO msg="collector complete" name=todos signals=1 duration=15.00125ms`,
  ``,
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-"));
  prevBin = process.env[STRINGER_BIN_ENV];
  prevTimeout = process.env.ANTON_STRINGER_TIMEOUT_MS;
});

afterEach(() => {
  if (prevBin === undefined) delete process.env[STRINGER_BIN_ENV];
  else process.env[STRINGER_BIN_ENV] = prevBin;
  if (prevTimeout === undefined) delete process.env.ANTON_STRINGER_TIMEOUT_MS;
  else process.env.ANTON_STRINGER_TIMEOUT_MS = prevTimeout;
  rmSync(dir, { recursive: true, force: true });
});

describe("scan", () => {
  function argvOf(dump: string): string[] {
    return JSON.parse(readFileSync(dump, "utf8")) as string[];
  }

  it("excludes build/cache dirs (root-relative) and caps each collector so a scan can't hang", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, [{ id: 1 }, { id: 2 }]);

    const result = await scan({ repoPath: "/repo", scanFile: join(dir, "scan.json") });

    const argv = argvOf(argvDump);
    expect(argv).toContain("--exclude");
    const globs = argv[argv.indexOf("--exclude") + 1].split(",");
    // Root-relative (stringer's glob dialect) — the .next build dir was the measured culprit.
    expect(globs).toContain(".next/**");
    expect(globs).toContain("node_modules/**");
    expect(globs.some((g) => g.startsWith("**/"))).toBe(false); // no doublestar prefix (unsupported)
    expect(DEFAULT_SCAN_EXCLUDES.every((g) => globs.includes(g))).toBe(true);
    // Collector-timeout backstop present.
    expect(argv).toContain("--collector-timeout");
    expect(argv[argv.indexOf("--collector-timeout") + 1]).toMatch(/^\d+[a-z]+$/);
    expect(argv).toContain("--delta"); // delta on by default
    expect(argv).toContain("--no-color"); // keeps stderr parseable for collector failures
    expect(result.signals).toHaveLength(2);
    expect(result.collectorFailures).toEqual([]);
  });

  it("excludes in-repo agent worktrees, so a nested checkout isn't walked as a second tree", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json") });

    // Claude Code checks isolation worktrees out at `.claude/worktrees/<name>/`; walking one made
    // 56% of the 2026-08-05 scan phantom clones of the real tree (anton-bqge).
    expect(DEFAULT_SCAN_EXCLUDES).toContain(".claude/**");
    const globs = argvOf(argvDump)[argvOf(argvDump).indexOf("--exclude") + 1].split(",");
    expect(globs).toContain(".claude/**");
  });

  it("excludes anton's own database, a githygiene finding that recurs on every scan of this repo", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json") });

    // anton.db sits at the repo root of the project anton runs FROM; `githygiene` walks the working
    // tree, so a gitignored multi-megabyte SQLite file is reported as a large binary every night
    // (anton-qor2). The glob also covers SQLite's -wal/-shm sidecars.
    expect(DEFAULT_SCAN_EXCLUDES).toContain("anton.db*");
    const globs = argvOf(argvDump)[argvOf(argvDump).indexOf("--exclude") + 1].split(",");
    expect(globs).toContain("anton.db*");
  });

  it("appends caller-supplied excludes after the defaults", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json"), exclude: ["fixtures/**"] });

    const globs = argvOf(argvDump)[argvOf(argvDump).indexOf("--exclude") + 1].split(",");
    expect(globs).toContain("fixtures/**");
    expect(globs).toContain(".next/**");
  });

  it("omits --delta when delta is false", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json"), delta: false });

    expect(argvOf(argvDump)).not.toContain("--delta");
  });

  // stringer writes the -o file even for a zero-signal delta scan, so unreadable output is a
  // process-boundary failure — reading it as "no signals" would skip triage, chart a zero-signal
  // point, and report a clean pass for a scan nobody read.
  it("rejects a scan whose output is missing, empty, or truncated", async () => {
    process.env[STRINGER_BIN_ENV] = writeScript("noop-stringer", ["process.exit(0);"]);
    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "missing.json") })).rejects.toThrow(
      /scan output at .*missing\.json is unreadable/,
    );

    process.env[STRINGER_BIN_ENV] = writeScript("empty-stringer", [
      "const fs = require('fs');",
      "fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '  ');",
    ]);
    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "empty.json") })).rejects.toThrow(
      /unreadable \(the file is empty\)/,
    );

    process.env[STRINGER_BIN_ENV] = writeScript("truncated-stringer", [
      "const fs = require('fs');",
      `fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '{"signals":[{"Source":"vu');`,
    ]);
    await expect(
      scan({ repoPath: "/repo", scanFile: join(dir, "truncated.json") }),
    ).rejects.toThrow(/is unreadable/);
  });

  // A stringer that renames its envelope key would otherwise chart a green point for output nobody
  // parsed: both readers agree on zero, and the agreement is on a false zero. Valid JSON is no
  // reassurance when the signals are in a key anton never looked at.
  it("refuses an unrecognized envelope rather than counting it as zero", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, {
      findings: [{ Source: "todos" }],
    });

    const rejection = scan({ repoPath: "/repo", scanFile: join(dir, "scan.json") });

    await expect(rejection).rejects.toThrow(/carries no recognized signal array/);
    // The shape it DID see, so an operator can tell a rename from a broken write.
    await expect(rejection).rejects.toThrow(/object with keys: findings/);
  });

  // The chart and the beads must label the same signal the same way (anton-bz1w): triage reads the
  // severity off the file rather than re-deriving one from `Priority`, which would miss the floors.
  it("stamps anton's derived severity and class onto every signal in the scan file", async () => {
    const argvDump = join(dir, "argv.json");
    const scanFile = join(dir, "scan.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, {
      signals: [
        { Source: "githygiene", Kind: "merge-conflict", Priority: 2 },
        { Source: "todos", Kind: "todo", Priority: 3 },
      ],
      metadata: { total_count: 2 },
    });

    const result = await scan({ repoPath: "/repo", scanFile });

    // `Priority: 2` alone reads as medium; the merge-conflict floor is what makes it high, and it is
    // exactly the rule an agent re-deriving from the raw fields would miss.
    expect(result.signals).toMatchObject([
      { AntonSeverity: "high", AntonClass: "risk" },
      { AntonSeverity: "low", AntonClass: "debt" },
    ]);

    // Written back into the file triage actually reads — and the envelope survives the round-trip.
    const written = JSON.parse(readFileSync(scanFile, "utf8")) as {
      signals: { AntonSeverity: string }[];
      metadata: { total_count: number };
    };
    expect(written.signals.map((s) => s.AntonSeverity)).toEqual(["high", "low"]);
    expect(written.metadata.total_count).toBe(2);
  });

  it("reports a collector that died even though the scan exited 0 (anton-uspu)", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, [{ id: 1 }], WORKTREECONFIG_STDERR);

    const result = await scan({ repoPath: "/repo", scanFile: join(dir, "scan.json") });

    // The scan still succeeded with the surviving collectors' signals — the loss is reported, not thrown.
    expect(result.signals).toHaveLength(1);
    expect(result.collectorFailures).toEqual([
      {
        name: "gitlog",
        error: "opening repo: core.repositoryformatversion does not support extension: worktreeconfig",
      },
    ]);
  });

  // anton-be1s: a killed scan's stderr is startup noise (stringer buffers collector logs to the
  // end), so it must never be what the parked job reports.
  it("reports a timeout kill as a timeout, not the misleading partial stderr", async () => {
    process.env[STRINGER_BIN_ENV] = writeScript("slow-stringer", [
      "process.stderr.write('collector gitlog: go-git: reference not found\\n');",
      "setTimeout(() => {}, 60000);", // outlive the deadline → SIGTERMed with no output written
    ]);
    process.env.ANTON_STRINGER_TIMEOUT_MS = "250";

    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "s.json") })).rejects.toThrow(
      /stringer timed out after 250ms \(killed with SIG/,
    );
    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "s.json") })).rejects.not.toThrow(
      /gitlog/,
    );
  });

  it("surfaces stderr for a genuine non-zero exit", async () => {
    process.env[STRINGER_BIN_ENV] = writeScript("failing-stringer", [
      "process.stderr.write('scan aborted: unreadable config at .stringer.toml\\n');",
      "process.exit(2);",
    ]);

    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "s.json") })).rejects.toThrow(
      /unreadable config at \.stringer\.toml/,
    );
    await expect(scan({ repoPath: "/repo", scanFile: join(dir, "s.json") })).rejects.not.toThrow(
      /timed out/,
    );
  });

  // anton-3flx: the health series can only subtract two scans that measured against the SAME
  // stringer baseline, and the baseline lives in the repo — nowhere anton's own db can see it.
  describe("the --delta baseline it reports", () => {
    /** Fake stringer that rewrites `.stringer/last-scan.json` under the scanned repo, as the real one does. */
    function writeBaselineStringer(): string {
      return writeScript("baseline-stringer", [
        "const fs = require('fs'); const path = require('path');",
        "const repo = process.argv[3];", // node, script, "scan", <repo>
        "fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '[]');",
        "if (!process.argv.includes('--delta')) process.exit(0);",
        "const state = path.join(repo, '.stringer', 'last-scan.json');",
        "let n = 0;",
        "try { n = JSON.parse(fs.readFileSync(state, 'utf8')).n + 1; } catch {}",
        "fs.mkdirSync(path.dirname(state), { recursive: true });",
        "fs.writeFileSync(state, JSON.stringify({ n }));",
      ]);
    }

    /** Fake stringer that advances the baseline and then writes NO scan file — output anton refuses. */
    function writeRejectingStringer(name: string): string {
      return writeScript(name, [
        "const fs = require('fs'); const path = require('path');",
        "const state = path.join(process.argv[3], '.stringer', 'last-scan.json');",
        "let n = 0;",
        "try { n = JSON.parse(fs.readFileSync(state, 'utf8')).n + 1; } catch {}",
        "fs.mkdirSync(path.dirname(state), { recursive: true });",
        "fs.writeFileSync(state, JSON.stringify({ n }));",
        "process.exit(0);", // ...and never writes the -o file
      ]);
    }

    it("reports no baseline consumed by the scan that established one", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();

      const first = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });

      // Nothing was suppressed, so these signals are the whole repo — not an arrival rate.
      expect(first.deltaState.before).toBeUndefined();
      expect(first.deltaState.after).toBeTruthy();
      expect(first.deltaState.baselineScan).toBe(true);
      // ...and the scan after it measures arrivals, so it is not a standing total.
      const second = await scan({ repoPath: dir, scanFile: join(dir, "s2.json") });
      expect(second.deltaState.baselineScan).toBe(false);
    });

    it("chains each later scan to the baseline the one before it left", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();

      const first = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const second = await scan({ repoPath: dir, scanFile: join(dir, "s2.json") });
      const third = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });

      expect(second.deltaState.before).toBe(first.deltaState.after);
      expect(third.deltaState.before).toBe(second.deltaState.after);
      expect(second.deltaState.after).not.toBe(second.deltaState.before);
    });

    it("re-reads the baseline after a reset, so the rescan reads as the baseline it is", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      await scan({ repoPath: dir, scanFile: join(dir, "s2.json") });

      rmSync(join(dir, ".stringer"), { recursive: true, force: true });
      const rescan = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });

      expect(rescan.deltaState.before).toBeUndefined();
    });

    it("consumes no baseline when the scan ran without --delta — that's the whole repo", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });

      const full = await scan({ repoPath: dir, scanFile: join(dir, "s2.json"), delta: false });

      expect(full.deltaState).toEqual({ baselineScan: true });
    });

    // stringer advances the baseline before anton ever reads the output, so a refused scan has
    // already consumed its window. Leaving that advance in place lets the retry find nothing new and
    // record a clean pass for findings nobody triaged — the false green the refusal exists to stop.
    it("puts the baseline back when it refuses the scan output, so a retry rescans the same window", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const first = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const state = join(dir, ".stringer", "last-scan.json");
      const consumed = readFileSync(state, "utf8");

      process.env[STRINGER_BIN_ENV] = writeRejectingStringer("rejecting-stringer");
      await expect(scan({ repoPath: dir, scanFile: join(dir, "s2.json") })).rejects.toThrow(
        /is unreadable/,
      );
      expect(readFileSync(state, "utf8")).toBe(consumed);

      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const retry = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });
      expect(retry.deltaState.before).toBe(first.deltaState.after);
    });

    // Refusing the OUTPUT is not the only way a pass consumes a window without reporting it: a scan
    // anton accepted and whose triage then died (quota, abort) leaves the same untriaged findings
    // behind the advanced baseline, so the unwind is handed to the caller rather than kept private.
    it("hands the caller an unwind for a scan it accepted but could not report", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const state = join(dir, ".stringer", "last-scan.json");
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const beforeSecond = readFileSync(state, "utf8");

      const second = await scan({ repoPath: dir, scanFile: join(dir, "s2.json") });
      expect(readFileSync(state, "utf8")).not.toBe(beforeSecond);
      expect(await second.restoreBaseline()).toBeUndefined();
      expect(readFileSync(state, "utf8")).toBe(beforeSecond);

      // ...so the retry measures the window the failed pass saw, not the empty one after it.
      const retry = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });
      expect(retry.deltaState.before).toBe(second.deltaState.before);
    });

    it("reports why an unwind failed, so the caller can fail loud instead of silently retrying", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const result = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });

      // Nowhere to put the bytes back (the state path is now a directory) — the honest answer is a
      // reason, never a silent success that leaves the retry measuring past the lost window.
      rmSync(join(dir, ".stringer", "last-scan.json"), { force: true });
      mkdirSync(join(dir, ".stringer", "last-scan.json"), { recursive: true });

      expect(await result.restoreBaseline()).toMatch(/last-scan\.json/);
    });

    it("undoes the baseline a refused FIRST scan established — there was none to go back to", async () => {
      process.env[STRINGER_BIN_ENV] = writeRejectingStringer("rejecting-first");

      await expect(scan({ repoPath: dir, scanFile: join(dir, "s1.json") })).rejects.toThrow(
        /is unreadable/,
      );

      expect(existsSync(join(dir, ".stringer", "last-scan.json"))).toBe(false);
    });

    it("says so when the baseline behind a refused scan cannot be put back", async () => {
      // No bytes to restore (here the state path is a directory), so the next --delta scan measures
      // against whatever stringer left — an operator has to be told, not left with a silent retry.
      mkdirSync(join(dir, ".stringer", "last-scan.json"), { recursive: true });
      process.env[STRINGER_BIN_ENV] = writeScript("noop-stringer", ["process.exit(0);"]);

      await expect(scan({ repoPath: dir, scanFile: join(dir, "s.json") })).rejects.toThrow(
        /baseline could not be restored/,
      );
    });

    it("PARKS the job when the baseline cannot be put back — a retry can't see the lost window", async () => {
      // An ordinary error gets rescheduled, and the retry measures --delta against the baseline this
      // scan advanced: zero signals, job done, findings nobody triaged. Poison instead, so the pass
      // stops at the human who has to reset the state file.
      mkdirSync(join(dir, ".stringer", "last-scan.json"), { recursive: true });
      process.env[STRINGER_BIN_ENV] = writeScript("noop-poison-stringer", ["process.exit(0);"]);

      await expect(scan({ repoPath: dir, scanFile: join(dir, "s.json") })).rejects.toSatisfy(
        isPoisonError,
      );
    });

    it("keeps a refusal it COULD unwind retryable — the retry rescans the same window", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });

      process.env[STRINGER_BIN_ENV] = writeRejectingStringer("rejecting-retryable");
      const err = await scan({ repoPath: dir, scanFile: join(dir, "s2.json") }).catch((e) => e);

      expect(isPoisonError(err)).toBe(false);
    });

    // A scan that dies mid-run has advanced the window just the same: stringer rewrites its state as
    // it goes, so the signals it had already produced sit behind an advanced baseline the retry
    // would scan past — a clean-looking pass over findings nobody parsed.
    it("puts the baseline back when the scanner process itself fails", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const first = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const state = join(dir, ".stringer", "last-scan.json");
      const consumed = readFileSync(state, "utf8");

      // Advances the baseline, then dies non-zero without writing the -o file.
      process.env[STRINGER_BIN_ENV] = writeScript("advancing-failing-stringer", [
        "const fs = require('fs'); const path = require('path');",
        "const state = path.join(process.argv[3], '.stringer', 'last-scan.json');",
        "let n = 0;",
        "try { n = JSON.parse(fs.readFileSync(state, 'utf8')).n + 1; } catch {}",
        "fs.mkdirSync(path.dirname(state), { recursive: true });",
        "fs.writeFileSync(state, JSON.stringify({ n }));",
        "process.stderr.write('scan aborted: collector panic\\n');",
        "process.exit(2);",
      ]);
      await expect(scan({ repoPath: dir, scanFile: join(dir, "s2.json") })).rejects.toThrow(
        /collector panic/,
      );
      expect(readFileSync(state, "utf8")).toBe(consumed);

      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const retry = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });
      expect(retry.deltaState.before).toBe(first.deltaState.after);
    });

    it("unwinds a deadline kill too — the killed scan's window is not the retry's", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const state = join(dir, ".stringer", "last-scan.json");
      const consumed = readFileSync(state, "utf8");

      // Advances the baseline, then outlives the deadline → SIGTERM before any output is written.
      process.env[STRINGER_BIN_ENV] = writeScript("advancing-slow-stringer", [
        "const fs = require('fs'); const path = require('path');",
        "const state = path.join(process.argv[3], '.stringer', 'last-scan.json');",
        "fs.writeFileSync(state, JSON.stringify({ n: 99 }));",
        "setTimeout(() => {}, 60000);",
      ]);
      process.env.ANTON_STRINGER_TIMEOUT_MS = "250";

      await expect(scan({ repoPath: dir, scanFile: join(dir, "s2.json") })).rejects.toThrow(
        /stringer timed out after 250ms/,
      );
      expect(readFileSync(state, "utf8")).toBe(consumed);
    });

    it("PARKS a failed scan whose advanced baseline cannot be put back", async () => {
      // Same false green as a refused scan, arrived at by a different door: an ordinary error is
      // rescheduled, and the retry measures against the baseline the dead scan advanced.
      mkdirSync(join(dir, ".stringer", "last-scan.json"), { recursive: true });
      process.env[STRINGER_BIN_ENV] = writeScript("failing-poison-stringer", ["process.exit(2);"]);

      const err = await scan({ repoPath: dir, scanFile: join(dir, "s.json") }).catch((e) => e);

      expect(isPoisonError(err)).toBe(true);
      expect((err as Error).message).toMatch(/baseline could not be restored/);
    });

    // The unwind must not relabel the failure it unwinds: the runner classifies a cancelled scan by
    // the error it gets, and a restored baseline is not news it needs.
    it("unwinds a cancelled scan while keeping it an AbortError", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const state = join(dir, ".stringer", "last-scan.json");
      const consumed = readFileSync(state, "utf8");

      process.env[STRINGER_BIN_ENV] = writeScript("advancing-hanging-stringer", [
        "const fs = require('fs'); const path = require('path');",
        "fs.writeFileSync(path.join(process.argv[3], '.stringer', 'last-scan.json'), '{\"n\":99}');",
        "setTimeout(() => {}, 60000);",
      ]);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);

      await expect(
        scan({ repoPath: dir, scanFile: join(dir, "s2.json"), signal: ac.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(readFileSync(state, "utf8")).toBe(consumed);
    });

    it("reports an unreadable baseline as unknown rather than as unchanged", async () => {
      const argvDump = join(dir, "argv.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

      // A stringer that keeps its state somewhere anton doesn't look leaves nothing to chain: the
      // series then carries no deltas at all, which is the honest reading of "cannot prove it".
      const result = await scan({ repoPath: dir, scanFile: join(dir, "s.json") });

      // And unknown all the way down: a missing state is not evidence this scan established one, so
      // the point must not be outlined as a baseline — every scan would be, forever.
      expect(result.deltaState).toEqual({});
      expect(result.deltaState.baselineScan).toBeUndefined();
    });

    // The refusal is only half the guarantee: a scan whose envelope anton didn't recognize has
    // already advanced the window, and leaving that advance in place loses the findings for good.
    it("puts the baseline back when it refuses an unrecognized envelope", async () => {
      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const first = await scan({ repoPath: dir, scanFile: join(dir, "s1.json") });
      const consumed = readFileSync(join(dir, ".stringer", "last-scan.json"), "utf8");

      process.env[STRINGER_BIN_ENV] = writeScript("renamed-envelope-stringer", [
        "const fs = require('fs'); const path = require('path');",
        "const state = path.join(process.argv[3], '.stringer', 'last-scan.json');",
        "let n = 0;",
        "try { n = JSON.parse(fs.readFileSync(state, 'utf8')).n + 1; } catch {}",
        "fs.writeFileSync(state, JSON.stringify({ n }));",
        `fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '{"findings":[{"Source":"todos"}]}');`,
      ]);
      await expect(scan({ repoPath: dir, scanFile: join(dir, "s2.json") })).rejects.toThrow(
        /carries no recognized signal array/,
      );
      expect(readFileSync(join(dir, ".stringer", "last-scan.json"), "utf8")).toBe(consumed);

      process.env[STRINGER_BIN_ENV] = writeBaselineStringer();
      const retry = await scan({ repoPath: dir, scanFile: join(dir, "s3.json") });
      expect(retry.deltaState.before).toBe(first.deltaState.after);
    });
  });

  // anton-j2zg: `githygiene` reads the WORKING TREE, so it flagged anton's own gitignored anton.db
  // as a "large binary file" on every pass — a medium-severity finding nobody can act on, counted
  // into the health record and re-triaged nightly. git's index is the arbiter.
  describe("findings about files git does not track", () => {
    /** A real git repo (inside `dir`, so the fake stringer binary is never one of its files). */
    function initRepo(files: Record<string, string>): string {
      const repo = join(dir, "repo");
      mkdirSync(repo, { recursive: true });
      const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
      run("init", "-q");
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "test");
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(repo, name, ".."), { recursive: true });
        writeFileSync(join(repo, name), body, "utf8");
      }
      run("add", "-A");
      run("commit", "-qm", "init");
      return repo;
    }

    const largeBinary = (path: string) => ({
      Source: "githygiene",
      Kind: "large-binary",
      FilePath: path,
      Title: `Large binary file: ${path}`,
      Tags: ["git-hygiene", "large-binary"],
    });

    it("drops the finding, keeps the count, and removes it from the file triage reads", async () => {
      const repo = initRepo({ ".gitignore": "phantom.db\n", "keep.bin": "committed" });
      writeFileSync(join(repo, "phantom.db"), "local database", "utf8");
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), {
        signals: [largeBinary("phantom.db"), largeBinary("keep.bin")],
        metadata: { total_count: 2 },
      });

      const result = await scan({ repoPath: repo, scanFile });

      expect(result.signals).toMatchObject([{ FilePath: "keep.bin", AntonSeverity: "medium" }]);
      expect(result.untracked).toEqual({
        dropped: [{ path: "phantom.db", kind: "large-binary", severity: "medium" }],
      });
      // Same set on both sides of the seam: the health record counts `signals`, triage reads the file.
      const written = JSON.parse(readFileSync(scanFile, "utf8")) as {
        signals: { FilePath: string }[];
        metadata: { total_count: number };
      };
      expect(written.signals.map((s) => s.FilePath)).toEqual(["keep.bin"]);
      expect(written.metadata.total_count).toBe(2); // stringer's own envelope rides through untouched
    });

    it("leaves a scan whose flagged files are all tracked exactly as it was", async () => {
      const repo = initRepo({ "keep.bin": "committed", "src/app.ts": "export {};\n" });
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        largeBinary("keep.bin"),
        { ...largeBinary("src/app.ts"), Kind: "mixed-line-endings" },
      ]);

      const result = await scan({ repoPath: repo, scanFile });

      expect(result.signals).toHaveLength(2);
      expect(result.untracked).toEqual({ dropped: [] });
      expect(
        (JSON.parse(readFileSync(scanFile, "utf8")) as { FilePath: string }[]).map((s) => s.FilePath),
      ).toEqual(["keep.bin", "src/app.ts"]);
    });

    // The filter drops only what git positively contradicts: a debt signal reads the same whether or
    // not the file is committed yet, a directory is never in the index, and a signal naming no file
    // is not a claim about the repo at all.
    it("drops nothing it cannot contradict — other collectors, directories, pathless signals", async () => {
      const repo = initRepo({ "src/app.ts": "export {};\n" });
      writeFileSync(join(repo, "scratch.ts"), "// TODO: later\n", "utf8");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        { Source: "todos", Kind: "todo", FilePath: "scratch.ts" },
        { ...largeBinary("src"), Kind: "many-large-files" },
        { ...largeBinary("."), Kind: "many-large-files" }, // the repo root, as collectors spell it
        { Source: "githygiene", Kind: "merge-conflict" },
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(4);
      expect(result.untracked.dropped).toEqual([]);
    });

    // How a collector SPELLS a path must not decide the drop: `src/../keep.bin` is absent from the
    // index verbatim, but it is the same tracked file as `keep.bin` — matching literally would
    // delete a real finding about a committed file.
    it("resolves `./` and mid-path traversals before asking git", async () => {
      const repo = initRepo({ "keep.bin": "committed", ".gitignore": "phantom.db\n" });
      writeFileSync(join(repo, "phantom.db"), "local database", "utf8");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        largeBinary("src/../keep.bin"),
        largeBinary("./phantom.db"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/../keep.bin" }]);
      expect(result.untracked.dropped).toEqual([
        { path: "phantom.db", kind: "large-binary", severity: "medium" },
      ]);
    });

    // The drop log is the only place a filtered finding still exists, so it has to carry what was
    // lost: a gitignored file holding a secret must not read as one more stale-binary phantom.
    it("records the kind and pre-filter severity of every drop", async () => {
      const repo = initRepo({ ".gitignore": "phantom.db\nsecrets.env\n", "keep.bin": "committed" });
      writeFileSync(join(repo, "phantom.db"), "local database", "utf8");
      writeFileSync(join(repo, "secrets.env"), "TOKEN=1", "utf8");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        largeBinary("phantom.db"),
        { ...largeBinary("secrets.env"), Kind: "committed-secret", Tags: ["secret"] },
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.untracked.dropped).toEqual([
        { path: "phantom.db", kind: "large-binary", severity: "medium" },
        { path: "secrets.env", kind: "committed-secret", severity: "critical" },
      ]);
    });

    // A filter that can't prove a file is untracked must under-filter rather than delete findings —
    // and say why, so the extra medium signals aren't read as the repo suddenly getting worse.
    it("counts everything and reports why when git cannot be asked", async () => {
      const notARepo = join(dir, "loose");
      mkdirSync(notARepo, { recursive: true });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        largeBinary("phantom.db"),
      ]);

      const result = await scan({ repoPath: notARepo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.untracked.dropped).toEqual([]);
      expect(result.untracked.unavailable).toBeTruthy();
    });
  });


  // anton-yvx9: the `coupling` collector builds its import graph from the source text, so an
  // `import type` — erased by the compiler, with no runtime edge — weighs exactly as much as a value
  // import. The 2026-08-18 scan charted an 11-module "circular dependency" closed only by
  // src/lib/types.ts, a pure type barrel, and handed it to triage as work.
  describe("coupling signals whose edges only the type system can see", () => {
    /** A source tree — no git, since nothing here is a claim about the index. */
    function writeRepo(files: Record<string, string>): string {
      const repo = join(dir, "repo");
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(repo, name, ".."), { recursive: true });
        writeFileSync(join(repo, name), body, "utf8");
      }
      return repo;
    }

    /** stringer's own phrasing: the component's members, alphabetical, and its size in the body. */
    const cycle = (modules: string[]) => ({
      Source: "coupling",
      Kind: "circular-dependency",
      FilePath: modules[0],
      Title: `Circular dependency: ${[...modules, modules[0]].join(" → ")}`,
      Description:
        `Strongly connected component with ${modules.length} modules forming a dependency cycle. ` +
        `Circular dependencies make code harder to test, refactor, and reason about independently.`,
      Tags: ["architecture", "coupling"],
    });

    const fanOut = (path: string, imports: number) => ({
      Source: "coupling",
      Kind: "high-coupling",
      FilePath: path,
      Title: `High coupling: ${path} imports ${imports} modules`,
      Description:
        `Module "${path}" has ${imports} direct dependencies, which is above the threshold of 10. ` +
        `High fan-out increases the risk of cascading breakage when any dependency changes.`,
      Tags: ["architecture", "coupling"],
    });

    /** src/lib/types.ts in miniature: 11 outgoing edges, every one of them erased at compile time. */
    function typeBarrel(): Record<string, string> {
      const names = Array.from({ length: 10 }, (_, i) => `M${i}`);
      const files: Record<string, string> = {
        "src/types.ts": [
          ...names.map((name, i) => `import type { ${name} } from "./m${i}";`),
          `export type { A } from "./a";`,
          `export type Every = ${names.join(" | ")};`,
          `export const STAGES = ["backlog"];`,
          ``,
        ].join("\n"),
        // ...and the module that closes the reported cycle imports the barrel for a VALUE.
        "src/a.ts": `import { STAGES } from "./types";\nexport type A = number;\nexport const first = () => STAGES[0];\n`,
      };
      for (let i = 0; i < 10; i += 1) files[`src/m${i}.ts`] = `export type M${i} = ${i};\n`;
      return files;
    }

    it("drops the phantom cycle and the barrel's fan-out, on both sides of the seam", async () => {
      const repo = writeRepo(typeBarrel());
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), {
        signals: [
          cycle(["src/a", "src/types"]),
          fanOut("src/types", 11),
          { Source: "todos", Kind: "todo", FilePath: "src/a.ts" },
        ],
        metadata: { total_count: 3 },
      });

      const result = await scan({ repoPath: repo, scanFile });

      // Not vacuous: the todo rides through, so the drop is this filter rather than an empty read.
      expect(result.signals).toMatchObject([{ Source: "todos" }]);
      expect(result.coupling.dropped).toMatchObject([
        { path: "src/a", kind: "circular-dependency" },
        { path: "src/types", kind: "high-coupling" },
      ]);
      // Every drop says why, in terms an operator can check against the source by hand.
      expect(result.coupling.dropped[0].reason).toContain("type-only");
      expect(result.coupling.dropped[0].reason).toContain("src/types.ts → src/a.ts");
      expect(result.coupling.dropped[1].reason).toContain("11 of its 11 imports are type-only");
      expect(describeCouplingFilter(result.coupling)).toContain("11 of its 11 imports are type-only");
      // Same set on both sides: the health record counts `signals`, triage reads the file.
      const written = JSON.parse(readFileSync(scanFile, "utf8")) as { signals: { Source: string }[] };
      expect(written.signals.map((s) => s.Source)).toEqual(["todos"]);
    });

    it("keeps a real value-import cycle exactly as stringer wrote it", async () => {
      const repo = writeRepo({
        "src/x.ts": `import { y } from "./y";\nexport const x = () => y();\n`,
        "src/y.ts": `import { x } from "./x";\nexport const y = () => x;\n`,
      });
      const scanFile = join(dir, "scan.json");
      const signal = cycle(["src/x", "src/y"]);
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [signal]);

      const result = await scan({ repoPath: repo, scanFile });

      expect(result.signals).toMatchObject([{ Title: signal.Title, AntonSeverity: "medium" }]);
      expect(result.coupling).toEqual({ dropped: [], recounted: [] });
      expect(describeCouplingFilter(result.coupling)).toBeUndefined();
    });

    // `import { type Q }` is elided whole; one default binding beside it makes the same statement a
    // runtime import, and a cycle it closes is real.
    it("reads inline `type` bindings, and the default binding that outranks them", async () => {
      const repo = writeRepo({
        "src/p.ts": `import { type Q } from "./q";\nexport const p: Q = 1;\n`,
        "src/q.ts": `import { p } from "./p";\nexport type Q = number;\nexport const usesP = () => p;\n`,
        "src/r.ts": `import S, { type T } from "./s";\nexport const r: T = S;\n`,
        "src/s.ts": `import { r } from "./r";\nexport type T = number;\nexport default r;\n`,
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        cycle(["src/p", "src/q"]),
        cycle(["src/r", "src/s"]),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/r" }]);
      expect(result.coupling.dropped).toMatchObject([{ path: "src/p" }]);
    });

    // A `semi:false` repo has no `;` to end a statement on, so the only thing separating one from
    // the next is the line-start keyword. Read without that bound, `export type …` runs forward into
    // the value re-export below it and takes the whole pair for erased — dropping a real cycle.
    it("reads one statement at a time in a repo that writes no semicolons", async () => {
      const repo = writeRepo({
        "src/a.ts": `export type Meta = number\n\nexport { b } from "./b"\n\nexport const a = 1\n`,
        "src/b.ts": `import { a } from "./a"\n\nexport const b = () => a\n`,
      });
      const signal = cycle(["src/a", "src/b"]);
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [signal]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ Title: signal.Title }]);
      expect(result.coupling).toEqual({ dropped: [], recounted: [] });
    });

    // A cycle closed by `@/lib/x` is only visible if the alias resolver lands on the same file the
    // compiler would: a resolver that misses turns a value edge into an unresolved specifier, and
    // the cycle it was holding up is dropped as a phantom.
    it("resolves `@/`-alias imports to the file they name on disk", async () => {
      const repo = writeRepo({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        }),
        "src/a.ts": `import { b } from "@/b";\nexport const a = () => b();\n`,
        "src/b.ts": `import { a } from "@/a";\nexport const b = () => a;\n`,
      });
      const signal = cycle(["src/a", "src/b"]);
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [signal]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ Title: signal.Title }]);
      expect(result.coupling).toEqual({ dropped: [], recounted: [] });
    });

    it("re-prices a surviving fan-out, so triage acts on the runtime number", async () => {
      const files: Record<string, string> = {};
      const lines: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        files[`src/t${i}.ts`] = `export type T${i} = ${i};\n`;
        lines.push(`import type { T${i} } from "./t${i}";`);
      }
      for (let i = 0; i < 12; i += 1) {
        files[`src/v${i}.ts`] = `export const v${i} = ${i};\n`;
        lines.push(`import { v${i} } from "./v${i}";`);
      }
      files["src/hub.ts"] = `${lines.join("\n")}\nexport const all = [v0];\n`;
      const repo = writeRepo(files);
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [fanOut("src/hub", 15)]);

      const result = await scan({ repoPath: repo, scanFile });

      expect(result.coupling.dropped).toEqual([]);
      expect(result.coupling.recounted).toEqual([{ path: "src/hub", reported: 15, value: 12 }]);
      const kept = result.signals[0] as { Title: string; Description: string };
      expect(kept.Title).toBe("High coupling: src/hub imports 12 modules");
      expect(kept.Description).toContain("has 12 direct dependencies");
      expect(kept.Description).toContain("3 of the 15 imports stringer counted are type-only");
      // The corrected number is in the file triage reads, not only in the array anton counted.
      const written = JSON.parse(readFileSync(scanFile, "utf8")) as { Title: string }[];
      expect(written[0].Title).toBe("High coupling: src/hub imports 12 modules");
    });

    /**
     * stringer's collector reads single-line statements only — a wrapped `import { … } from` is
     * missing from its count entirely (measured: 12 single-line imports report `imports 12
     * modules`; the same 12 with 4 wrapped report nothing). So its number is a floor, and a
     * subtraction off it can price a module below the fan-out it really has.
     */
    function undercountedHub(typeImports: number, values: number, wrapped: number) {
      const files: Record<string, string> = {};
      const lines: string[] = [];
      for (let i = 0; i < typeImports; i += 1) {
        files[`src/t${i}.ts`] = `export type T${i} = ${i};\n`;
        lines.push(`import type { T${i} } from "./t${i}";`);
      }
      for (let i = 0; i < values; i += 1) {
        files[`src/v${i}.ts`] = `export const v${i} = ${i};\n`;
        lines.push(
          i < wrapped ? `import {\n  v${i},\n} from "./v${i}";` : `import { v${i} } from "./v${i}";`,
        );
      }
      files["src/hub.ts"] = `${lines.join("\n")}\nexport const all = [v0];\n`;
      // What stringer would have counted: every single-line statement, the wrapped ones unseen.
      return { files, counted: typeImports + values - wrapped };
    }

    it("keeps a fan-out stringer undercounted, rather than pricing it below its runtime edges", async () => {
      const { files, counted } = undercountedHub(3, 12, 4);
      const repo = writeRepo(files);
      const scanFile = join(dir, "scan.json");
      expect(counted).toBe(11); // stringer's view: 3 type-only + the 8 unwrapped value imports
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        fanOut("src/hub", counted),
      ]);

      const result = await scan({ repoPath: repo, scanFile });

      // 11 − 3 = 8 is below the threshold, but 12 modules are imported for a value: not a drop, and
      // not a correction either — anton has nothing to subtract that stringer didn't already miss.
      expect(result.coupling).toEqual({ dropped: [], recounted: [] });
      expect((result.signals[0] as { Title: string }).Title).toBe(
        "High coupling: src/hub imports 11 modules",
      );
    });

    it("prices a drop off its own runtime count, not off stringer's subtraction", async () => {
      const { files, counted } = undercountedHub(4, 9, 2);
      const repo = writeRepo(files);
      expect(counted).toBe(11); // 4 type-only + the 7 unwrapped value imports
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        fanOut("src/hub", counted),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      // 11 − 4 = 7 would understate it; 9 modules really are imported for a value, still under 10.
      expect(result.coupling.dropped[0].reason).toContain("leaving 9 at runtime");
    });

    // Under-filtering costs one triaged bead; over-filtering deletes an architecture finding nobody
    // hears about again. So anything anton cannot PROVE is erased rides through untouched.
    it("keeps every signal it cannot disprove", async () => {
      const repo = writeRepo({
        "src/only-values.ts": `import { v } from "./v";\nexport const u = v;\n`,
        "src/v.ts": `export const v = 1;\n`,
        ...typeBarrel(),
      });
      const truncated = {
        ...cycle(["src/a", "src/types"]),
        // The component holds five modules; the title spells two, so it is not evidence about the rest.
        Description: "Strongly connected component with 5 modules forming a dependency cycle.",
      };
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        truncated,
        cycle(["internal/api", "internal/store"]), // another language's modules — nothing anton can parse
        fanOut("src/only-values", 12), // no erased edge to subtract
        { ...fanOut("src/types", 11), Kind: "unknown-coupling-kind" }, // a kind these rules don't know
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(4);
      expect(result.coupling).toEqual({ dropped: [], recounted: [] });
      expect((result.signals[2] as { Title: string }).Title).toBe(
        "High coupling: src/only-values imports 12 modules",
      );
    });
  });

  // anton-23xe: the `deadcode` collector doesn't follow every reference — all ten unused-function
  // signals in the 2026-08-17 scan named a symbol with real callers, every one of them in a test
  // file. They cost the health record a debt point a night and triage the judgment to re-derive
  // that they were wrong.
  describe("dead-code signals whose symbol has callers elsewhere in the tree", () => {
    /** A committed tree — the reference check asks git what the repo holds. */
    function initRepo(files: Record<string, string>): string {
      const repo = join(dir, "repo");
      mkdirSync(repo, { recursive: true });
      const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
      run("init", "-q");
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "test");
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(repo, name, ".."), { recursive: true });
        writeFileSync(join(repo, name), body, "utf8");
      }
      run("add", "-A");
      run("commit", "-qm", "init");
      return repo;
    }

    /** stringer's own phrasing, tags and confidence for an unused symbol. */
    const unused = (path: string, symbol: string, kind = "unused-function") => ({
      Source: "deadcode",
      Kind: kind,
      FilePath: path,
      Line: 1,
      Title: `Unused ${kind === "unused-type" ? "type" : "function"}: ${symbol}`,
      Description: "",
      Confidence: 0.3,
      Tags: ["dead-code", "cleanup-candidate", "test-only-reference"],
    });

    it("drops the ones with callers and reports the rest unchanged, on both sides of the seam", async () => {
      const repo = initRepo({
        // withOperator in miniature: declared in a helper, called only from a suite.
        "src/testing/integration.ts": "export function withOperator() {}\n",
        "src/routes/claim.test.ts": "import { withOperator } from '../testing/integration';\nwithOperator();\n",
        // ...and one nobody anywhere calls.
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
      });
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), {
        signals: [
          unused("src/testing/integration.ts", "withOperator"),
          unused("src/lib/orphan.ts", "neverCalled"),
        ],
        metadata: { total_count: 2 },
      });

      const result = await scan({ repoPath: repo, scanFile });

      // The genuinely unreferenced one survives, at the severity it always carried.
      expect(result.signals).toMatchObject([
        { Title: "Unused function: neverCalled", AntonSeverity: "low", AntonClass: "debt" },
      ]);
      expect(result.deadcode.dropped).toMatchObject([
        { path: "src/testing/integration.ts", symbol: "withOperator", kind: "unused-function" },
      ]);
      // The drop names its caller, so it can be checked by hand without re-running the scan.
      expect(result.deadcode.dropped[0].reason).toContain("src/routes/claim.test.ts");
      expect(describeDeadcodeFilter(result.deadcode)).toContain("dropped 1 dead-code signal(s)");
      // Same set on both sides: the health record counts `signals`, triage reads the file.
      const written = JSON.parse(readFileSync(scanFile, "utf8")) as { signals: { Title: string }[] };
      expect(written.signals.map((s) => s.Title)).toEqual(["Unused function: neverCalled"]);
    });

    // A symbol that only ever mentions itself — its own declaration, its own recursive call — is
    // exactly what the collector claims, so nothing here may read as a caller.
    it("does not count the declaring file's own mentions as a reference", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts":
          "export function neverCalled(n: number): number {\n  return n > 0 ? neverCalled(n - 1) : 0;\n}\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("./src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode).toEqual({ dropped: [] });
      expect(describeDeadcodeFilter(result.deadcode)).toBeUndefined();
    });

    // stringer spells `FilePath` however its collector saw the file. An absolute one has to be made
    // repo-relative before it can be discounted from git's hits, or the declaration reads as its own
    // caller and erases the finding — the exact inverse of what the check is for.
    it("excludes the declaring file when the signal spells it absolutely", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts":
          "export function neverCalled(n: number): number {\n  return n > 0 ? neverCalled(n - 1) : 0;\n}\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused(join(repo, "src/lib/orphan.ts"), "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode).toEqual({ dropped: [] });
    });

    // An import is a binding taken, not a use made: a module that still imports a symbol it stopped
    // calling is the stale half of the very finding being checked. Counting that line as a caller
    // lets one forgotten import delete a true finding about a symbol nothing invokes — while the
    // file that imports AND uses it names the symbol on a line of its own, which still counts.
    it("does not count an import of the symbol as a use of it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/stale.tsx": "import { Widget } from './widget';\nexport const Stale = () => null;\n",
        "src/ui/wrapped.ts": "import {\n  Widget,\n} from './widget';\nexport const kept = 1;\n",
        "src/ui/types.ts": "import type { Widget } from './widget';\nexport const kept = 1;\n",
        "src/ui/page.tsx": "import { Widget } from './widget';\nexport const Page = () => <Widget />;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/page.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/wrapped.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/types.ts");
    });

    // The mask ends with the declaration, not with the line holding it: a statement after the `;`
    // runs, `import('./widget')` is a call rather than a declaration, and a re-export republishes
    // the symbol under another module's name. Blanking any of those reports a live symbol dead.
    it("keeps the code beside an import, a dynamic import, and a re-export", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/list.ts": "import { Widget } from './widget'; export const list = [Widget];\n",
        "src/ui/lazy.ts": "export const lazy = () => import('./widget').then((m) => m.Widget);\n",
        "src/ui/index.ts": "export { Widget } from './widget';\n",
        "src/ui/stale.tsx": "import { Widget } from './widget';\nexport const Stale = () => null;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/list.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/lazy.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/index.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.tsx");
    });

    // CommonJS spells the same stale binding as a declaration: `const { Widget } = require(...)`
    // takes the name without calling it, so counting that line deletes a true finding exactly as a
    // forgotten `import` would. Only the binding is discounted — the initializer beside it still
    // carries the call that keeps a live symbol out of the report.
    it("does not count a CommonJS require binding as a use of it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/stale.js": "const { Widget } = require('./widget');\nmodule.exports = 1;\n",
        "src/ui/wrapped.js": "const {\n  Widget,\n} = require('./widget');\nmodule.exports = 2;\n",
        "src/ui/renamed.js": "const Renamed = require('./widget').Widget;\nmodule.exports = 3;\n",
        "src/ui/calls.js": "const html = require('./widget').Widget();\nmodule.exports = html;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/calls.js");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.js");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/wrapped.js");
    });

    // The mask stops at the `=` of a `require` declaration and nowhere else: a value binding names
    // the symbol on the right of its own `=`, and a `const` that never reaches one must leave the
    // lines under it alone.
    it("keeps a value declaration and the code under an unterminated binding", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/alias.js": "const alias = Widget;\nmodule.exports = alias;\n",
        "src/ui/late.js": "const {\n  other,\n} = require('./other');\nmodule.exports = () => Widget();\n",
        "src/ui/other.js": "module.exports = { other: 1 };\n",
        "src/ui/stale.js": "const { Widget } = require('./widget');\nmodule.exports = 1;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/alias.js");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/late.js");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.js");
    });

    // An import that reaches no quoted module specifier belongs to a language that spells one
    // without a string, and the mask has nothing to end it at. Guessing at its extent would blank
    // the program under it — including the call that keeps a live symbol out of the report.
    it("leaves a quoteless import unmasked rather than blanking the code under it", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/Main.java":
          "import com.example.util.Helper;\n\npublic class Main {\n  void run() { neverCalled(); }\n}\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/Main.java");
    });

    // Python spells the same stale binding as `from widget import Widget`, where the `import`
    // keyword never stands at the head of the statement and no module string ever ends it. Counting
    // that line lets one forgotten import delete a true finding exactly as an ESM one would, while
    // the module that calls what it imports names the symbol again on a line of its own — and a
    // `raise … from` names it mid-statement, where an import never starts.
    it("does not count a Python import of the symbol as a use of it", async () => {
      const repo = initRepo({
        "src/py/widget.py": "def Widget():\n    return None\n",
        "src/py/stale.py": "from widget import Widget\n\nkept = 1\n",
        "src/py/wrapped.py": "from widget import (\n    Widget,\n)\n\nkept = 2\n",
        "src/py/module.py": "import Widget\n\nkept = 3\n",
        "src/py/calls.py": "from widget import Widget\n\nhtml = Widget()\n",
        "src/py/raises.py": "def run():\n    raise ValueError('gone') from Widget\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/py/widget.py", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/py/calls.py");
      expect(result.deadcode.dropped[0].reason).toContain("src/py/raises.py");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/py/stale.py");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/py/wrapped.py");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/py/module.py");
    });

    // A binding taken under another name is the one import that is not a stale half: the statement
    // holds the file's only mention of the symbol, and every use of it beside is spelled with the
    // local name, which the searched symbol can never match. Blanking that reports a live symbol
    // dead — while an alias nothing uses stays discounted exactly as a plain stale import is.
    it("counts a renamed import whose local name the file still uses", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/renamed.ts":
          "import { Widget as Renamed } from './widget';\nexport const page = () => Renamed();\n",
        "src/ui/wrapped.ts":
          "import {\n  Widget as Wrapped,\n} from './widget';\nexport const list = [Wrapped];\n",
        "src/ui/cjs.js":
          "const { Widget: Required } = require('./widget');\nmodule.exports = () => Required();\n",
        "src/ui/stale.ts": "import { Widget as Unused } from './widget';\nexport const kept = 1;\n",
        "src/ui/stale.js": "const { Widget: Ignored } = require('./widget');\nmodule.exports = 1;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/renamed.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/wrapped.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/cjs.js");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/stale.js");
    });

    // Python spells the rename `import Widget as Renamed`, and it reads the same way: the statement
    // carries the only mention of the symbol, so discounting it wholesale hides the caller that
    // keeps a live symbol out of the report.
    it("counts a renamed Python import whose local name the file still uses", async () => {
      const repo = initRepo({
        "src/py/widget.py": "def Widget():\n    return None\n",
        "src/py/renamed.py": "from widget import Widget as Renamed\n\nhtml = Renamed()\n",
        "src/py/stale.py": "from widget import Widget as Unused\n\nkept = 1\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/py/widget.py", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/py/renamed.py");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/py/stale.py");
    });

    // Python's triple quote opens a docstring, but `f"""` opens an expression: the text between its
    // braces runs, and `f"""{Widget()}"""` calls the symbol. Reading every triple-quoted span as a
    // comment blanks that call and reports a live symbol dead — while the literal text around the
    // interpolation is still prose, and a docstring is still a docstring.
    it("reads a Python f-string interpolation as code and its docstrings as prose", async () => {
      const repo = initRepo({
        "src/py/widget.py": "def Widget():\n    return None\n",
        "src/py/inline.py": 'def render():\n    return f"""{Widget()}"""\n',
        "src/py/block.py": 'def page():\n    return f"""\n    <div>{Widget()}</div>\n    """\n',
        "src/py/doc.py": '"""\nWidget was the old renderer.\n"""\nkept = 1\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/py/widget.py", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/py/inline.py");
      expect(result.deadcode.dropped[0].reason).toContain("src/py/block.py");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/py/doc.py");
    });

    // A name written in prose is being described, not called. Without this the module that documents
    // a symbol keeps it alive forever, and the filter goes blind to the symbols it exists to check.
    it("does not count a name in a comment or a doc as a reference", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/notes.ts":
          "// neverCalled was the old nightly entry point.\n/**\n * neverCalled goes next.\n */\nexport const kept = 1;\n",
        "docs/history.md": "- `neverCalled` used to run every night\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // A block comment's continuation lines carry no marker of their own, so judging a hit by its
    // own text alone reads prose as a call — and deletes a finding that was right.
    it("does not count a name inside an open block comment as a reference", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/notes.ts":
          "/*\nneverCalled was removed later.\n*/\nexport const kept = 1;\n",
        "scripts/notes.py": '"""\nneverCalled ran the old nightly.\n"""\nkept = 1\n',
        "public/notes.html": "<!--\nneverCalled used to run here.\n-->\n<p>kept</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // ...and the tracking has to end where the block does, or a caller written under a docblock
    // stops counting and the filter goes blind to exactly the case it was built for.
    it("counts a call written below a block comment that mentions the symbol", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/caller.ts":
          "/*\nneverCalled is called below.\n*/\nimport { neverCalled } from './orphan';\nneverCalled();\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/caller.ts");
    });

    // A hit is a line, not a position: prose written after real code carries no marker where the
    // line begins, so reading the line as code proves a caller that isn't there.
    it("does not count a name in a comment opened after code as a reference", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/notes.ts":
          "export const kept = 1; /* neverCalled was removed */\nexport const also = 2; // neverCalled went with it\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // A marker quoted inside a string opens no comment. Blanking from the `//` in a URL erases the
    // call written beside it, and the file then proves no caller for a symbol it does use — the
    // filter reports a signal the tree had already disproved.
    it("counts a call written after a string that holds a comment marker", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/caller.ts": 'const url = "https://host"; neverCalled();\n',
        "src/lib/block.ts": "const opener = '/*';\nneverCalled();\n",
        "src/lib/tick.ts": "const url = `https://host`;\nneverCalled();\n",
        "config/deploy.yml": 'url: "https://host" # neverCalled runs here\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/caller.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/block.ts");
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/tick.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("config/deploy.yml");
    });

    // ...and stepping over the literal must not step over the comment behind it: a marker past the
    // closing quote still blanks its line, or prose proves a caller that isn't there. A quote that
    // never closes on its line is no literal to step over at all — the tail of a template literal
    // still carries the comment written after it.
    it("still masks a comment opened after a string on the same line", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/notes.ts": 'const url = "https://host"; // neverCalled was removed\n',
        "src/lib/wrapped.ts": "const banner = `\n  hello\n`; // neverCalled was removed\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // PHP takes `#` as a line comment on top of `//`, so it reads neither like C nor like a file
    // anton has no grammar for: prose after `#` must not prove a caller, and a real call must still
    // count.
    it("reads both PHP comment markers as prose and still counts a PHP caller", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/legacy/notes.php": "<?php\n# neverCalled was removed\n// neverCalled went with it\n",
        "src/legacy/caller.php": "<?php\nneverCalled(); # neverCalled was here\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/legacy/caller.php");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/legacy/notes.php");
    });

    // `;` opens a comment in Lisp and guards ASI in TypeScript. Reading every marker in every file
    // leaves a symbol with a real caller counted as dead — the phantom this filter exists to stop.
    it("counts a caller whose line opens with a marker its own language does not have", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/caller.ts": "const ready = true\n;neverCalled()\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/caller.ts");
    });

    // A repo that commits its build output names every symbol it bundled. stringer never walked
    // `dist/`, so counting the copy there as a caller would delete a finding about source it DID
    // walk — the reference check has to read the same file set the scan did.
    it("ignores mentions in trees the scan excluded, and honours extra excludes", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "dist/bundle.js": "function neverCalled(){}\nneverCalled();\n",
        "vendor/copy.ts": "neverCalled();\n",
        "generated/api.ts": "neverCalled();\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({
        repoPath: repo,
        scanFile: join(dir, "scan.json"),
        exclude: ["generated/**"],
      });

      expect(result.signals).toMatchObject([{ Title: "Unused function: neverCalled" }]);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // ...and excluding is not the same as searching nothing: source outside the excluded trees
    // still answers.
    it("still counts a caller that sits outside the excluded trees", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "dist/bundle.js": "neverCalled();\n",
        "src/lib/caller.ts": "import { neverCalled } from './orphan';\nneverCalled();\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/caller.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("dist/bundle.js");
    });

    // Rust and Swift nest block comments: the inner `*/` closes only the inner opener. Ending the
    // comment there reads the outer comment's remaining prose as a call site.
    it("keeps a nested block comment open until its outer delimiter closes", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/notes.rs":
          "/* outer /* inner */\nneverCalled was removed later.\n*/\nfn kept() {}\n",
        "src/lib/notes.swift": "/* /* x */ neverCalled went too */\nlet kept = 1\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // ...and the nesting count has to end the comment where it really ends, or a Rust caller below
    // a nested docblock stops counting.
    it("counts a Rust caller written below a nested block comment", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/caller.rs":
          "/* outer /* inner */ still comment */\nfn go() { neverCalled(); }\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/caller.rs");
    });

    // Ruby's block comment is `=begin`/`=end`, not `#`. Reading it with `#` alone leaves the block's
    // continuation lines looking like code, so prose naming the symbol proves a caller that isn't
    // there — and a real Ruby call below the block still has to count.
    it("reads a Ruby =begin block as prose and still counts a Ruby caller", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/legacy/notes.rb":
          "=begin\nneverCalled ran the old nightly.\n=end # neverCalled went with it\nkept = 1\n",
        "src/legacy/caller.rb": "=begin\nneverCalled is called below.\n=end\nneverCalled()\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/legacy/caller.rb");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/legacy/notes.rb");
    });

    // MDX is a program: a component imported and rendered only from a docs page has a real caller,
    // and discounting the whole file as prose leaves that component reported dead every night. Its
    // markdown body still is prose, so only the shapes MDX executes may count.
    it("counts an MDX import and render, and not the prose or the fenced example around it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "import { Widget } from '../src/ui/widget';\n\n<Widget />\n",
        "docs/notes.mdx":
          "Widget was removed in favour of Panel.\n\n{/* Widget shipped here once */}\n\n" +
          "```tsx\nimport { Widget } from '../src/ui/widget';\n```\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // A code example is fenced with three or more backticks OR tildes, and the delimiter is the
    // fence rather than the backticks inside it. Pairing backticks one at a time sees no fence in
    // `~~~~tsx` and pairs an even-length one off against itself, so the example's `<Widget />`
    // reads as a rendered tag and erases a finding that was right.
    it("reads a tilde fence and an even-length backtick fence as an example, not a caller", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "import { Widget } from '../src/ui/widget';\n\n<Widget />\n",
        "docs/tilde.mdx": "How it looked:\n\n~~~~tsx\n<Widget />\n~~~~\n",
        "docs/even.mdx": "How it looked:\n\n````tsx\n<Widget />\n````\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/tilde.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/even.mdx");
    });

    // An inline code span runs from a backtick run to the next run of the same length, so a doubled
    // span shows a tag rather than rendering one — and a fence only closes on its own character, so
    // a tilde row inside a backtick block is body text rather than the end of the example.
    it("reads a doubled inline span and a foreign fence line as example text", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "import { Widget } from '../src/ui/widget';\n\n<Widget />\n",
        "docs/span.mdx": "Render it with ``<Widget />`` on the page.\n",
        "docs/mixed.mdx": "```tsx\n~~~\n<Widget />\n```\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/span.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/mixed.mdx");
    });

    // MDX wraps. An import list runs over three lines and an expression opens its `{` on one of
    // its own, so the line naming the component carries neither the keyword nor the brace. Reading
    // each line alone misses the caller under the brace — and reads the wrapped specifier list as
    // one, though a page that imports a component and never renders it calls nothing.
    it("counts an MDX caller written across lines, and not a wrapped import on its own", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/imports.mdx": "import {\n  Widget,\n} from '../src/ui/widget';\n",
        "docs/renders.mdx": "import {\n  Widget,\n} from '../src/ui/widget';\n\n<Widget />\n",
        "docs/expression.mdx": "{\n  Widget()\n}\n",
        "docs/notes.mdx": "Widget was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/renders.mdx");
      expect(result.deadcode.dropped[0].reason).toContain("docs/expression.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/imports.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // An ESM statement can wrap without opening a delimiter on its first line — `export default`
    // with the component under it. MDX ends that block at the blank line, so the continuation is
    // code and the prose after the blank line is not; closing it on its opening line reads the
    // caller as markdown and leaves the component reported dead.
    it("counts an MDX ESM continuation that opens no delimiter, and stops at the blank line", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/layout.mdx": "export default\n  Widget()\n",
        "docs/notes.mdx": "export const slug = 'notes'\n\nWidget was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/layout.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // Backticks mean two things in MDX: a markdown code span, which shows a symbol, and a template
    // literal inside an ESM statement, which runs. Masking every span alike blanks the
    // interpolation and leaves a live component reported dead.
    it("keeps a template literal in an MDX ESM block, and still masks a code span in prose", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/meta.mdx": "export const value = `${Widget()}`\n",
        "docs/multi.mdx": "export const banner = `\n  ${Widget()}\n`\n",
        "docs/notes.mdx": "export the `Widget` helper from the old build.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/meta.mdx");
      expect(result.deadcode.dropped[0].reason).toContain("docs/multi.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // MDX opens its ESM block on a statement, not on a paragraph that happens to start with the
    // keyword: `export Widget from the old build` is a sentence. Reading it as code lets the prose
    // prove its own caller — and carries that mistake down the paragraph, since the block runs to
    // the blank line — while the statement beside it still counts.
    it("reads an MDX paragraph opening with an ESM keyword as prose", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/notes.mdx": "export Widget from the old build.\n",
        "docs/para.mdx": "export was dropped from the docs\nWidget was removed in favour of Panel.\n",
        "docs/uses.mdx": "export const value = Widget()\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/para.mdx");
    });

    // The ESM block is not the only executable place a backtick can stand: a braced expression runs
    // too, so the template literal in ``{`${Widget()}`}`` interpolates a real call. Masking it as a
    // markdown span leaves that caller unseen and the finding standing.
    it("keeps a template literal inside an MDX expression", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/inline.mdx": "Rendered with {`${Widget()}`} on the page.\n",
        "docs/wrapped.mdx": "{\n  `${Widget()}`\n}\n",
        "docs/notes.mdx": "The `Widget` helper was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/inline.mdx");
      expect(result.deadcode.dropped[0].reason).toContain("docs/wrapped.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // JSX lets a comment's braces stand off its `/* */`. Matching only the attached `{/*` leaves
    // the span unmasked, and the `{` in front of it then proves the prose is an expression —
    // erasing a finding that was right.
    it("masks an MDX comment written with spaces inside its braces", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "import { Widget } from '../src/ui/widget';\n\n<Widget />\n",
        "docs/notes.mdx": "{ /* Widget was removed in favour of Panel */ }\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // An MDX ESM block is JavaScript, so `//` opens a comment there. The prose behind it sits on a
    // line already read as executable, where it proves a caller that isn't there — and the block
    // has to survive that comment, so a real reference under it still counts.
    it("masks a line comment inside an MDX ESM block and still counts the reference under it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/notes.mdx": "export const meta = {\n  // Widget was removed in favour of Panel\n  title: 'Notes',\n};\n",
        "docs/layout.mdx": "export const layout = {\n  // rendered below\n  render: Widget,\n};\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/layout.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // An MDX expression closes on the line that opened it: in `Current: {version}. Widget was
    // removed.` the symbol is markdown prose, not code. Accepting any earlier `{` reads that
    // sentence as executable, calls the page a caller, and deletes a true finding.
    it("counts an MDX symbol only while its expression is still open", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "Rendered with {Widget()} on the page.\n",
        "docs/notes.mdx": "Current: {version}. Widget was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // A page importing a namespace renders through it — `<UI.Widget />` — and may name the symbol
    // nowhere else. Reading the member tag as prose reports a component that ships on every page.
    it("counts an MDX component rendered through a namespace import", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "import * as UI from '../src/ui/widget';\n\n<UI.Widget />\n",
        "docs/notes.mdx": "Widget was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // Comment masking leaves an HTML file's rendered text intact, where a name is being shown to a
    // reader rather than called. A committed page describing a removed symbol would otherwise prove
    // its own caller and delete a true finding; a `<script>` in the same file still calls.
    it("does not count a symbol rendered as markup text, and still counts a script that calls it", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "public/notes.html": "<h1>API</h1>\n<p>neverCalled was removed from the old API</p>\n",
        "public/app.html": "<body>\n<script>\n  neverCalled();\n</script>\n</body>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A tag name resolves a binding only where the format has one: `<Widget />` in a single-file
    // component renders the imported symbol, while the same element in static HTML, XML or SVG is
    // the document's own vocabulary. Reading those as callers deletes a true finding.
    it("does not count an element name in static markup, and still counts a component tag", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/page.svelte": "<main>\n  <Widget />\n</main>\n",
        "public/notes.html": "<Widget>gone</Widget>\n",
        "public/feed.xml": "<entry>\n  <Widget>gone</Widget>\n</entry>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/page.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/feed.xml");
    });

    // A `<script>` only runs when its type says so: `application/ld+json` and `importmap` hold data
    // a browser never executes, so a name inside one is shown rather than called — and its JSON
    // braces are not the template interpolation that would count it by the other route.
    it("reads a data script's body as inert, and still counts an executable one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/notes.html":
          '<script type="application/ld+json">\n{"name": "Widget"}\n</script>\n<p>gone</p>\n',
        "public/app.html": '<script type="text/javascript;charset=utf-8">\nWidget();\n</script>\n',
        "public/module.html": '<script type="module">\n  Widget();\n</script>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).toContain("public/module.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // ...and a template is not prose either: a rendered tag and an attribute value each name a
    // real caller, so the same rule that discounts markup text must still count them.
    it("counts a component rendered as a tag or called from an attribute", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/page.svelte": "<main>\n  <Widget />\n</main>\n",
        "src/ui/app.vue": '<template>\n  <button @click="Widget()">go</button>\n</template>\n',
        "public/notes.html": "<p>Widget was removed in favour of Panel</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/page.svelte");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/app.vue");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A static attribute is content, not a binding: `title="Widget was removed"` shows the name to
    // a reader exactly as the text between the tags does. Only an attribute that carries code —
    // a handler, a directive, a dynamic bind — names a caller.
    it("does not count a symbol inside a static attribute", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/notes.html":
          '<div title="Widget was removed" data-note=\'Widget was removed\'>gone</div>\n',
        "src/ui/notes.vue": '<template>\n  <Panel title="Widget was removed" />\n</template>\n',
        "public/app.html": '<button onclick="Widget()">go</button>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.vue");
    });

    // HTML lets a handler's value stand unquoted, and a minifier writes it that way. The browser
    // still invokes it, so requiring a quote after the `=` reports a live function dead.
    it("counts a symbol in an unquoted handler attribute", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/bare.html": "<button onclick=Widget()>go</button>\n",
        "src/ui/notes.vue": "<template>\n  <Panel title=static>Widget was removed</Panel>\n</template>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/bare.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.vue");
    });

    // A handler's value runs to the quote that opened it, and the other quote inside it is code:
    // `onclick="log('x'); Widget()"` is a call the browser makes. Ending the value at that
    // apostrophe reads a live handler as text and leaves a finding standing about a live function.
    it("counts a symbol after a nested quote in a handler attribute", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/app.html": "<button onclick=\"log('x'); Widget()\">go</button>\n",
        "public/notes.html": "<p>Widget was removed in favour of Panel</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A handler's value wraps as ordinary formatting, and the browser runs it all the same: the
    // line under `onclick="` carries no attribute of its own, so judging it alone misses the call
    // and leaves a false dead-code signal standing. A static value that wraps the same way is
    // still the text a reader sees.
    it("counts a symbol inside a handler attribute whose value wrapped", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/app.html": '<button\n  onclick="\n    Widget()\n  "\n>go</button>\n',
        "public/notes.html": '<div\n  title="\n    Widget was removed\n  "\n>gone</div>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A `<script>`'s own attributes wrap too. Reading the opener only where it fits on one line
    // finds no opener at all, so the import and call inside the body read as markup and the live
    // component stays reported dead — while a wrapped data script is still inert.
    it("reads a script whose opening tag wraps onto later lines", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/page.svelte":
          "<script\n  lang=\"ts\"\n>\n  import Widget from './widget';\n  Widget();\n</script>\n",
        "public/notes.html":
          '<script\n  type="application/ld+json"\n>\n{"name": "Widget"}\n</script>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/page.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A tag name inside another tag's quoted attribute is text, not an element: `title="<script>"`
    // opens nothing. Recognizing it as an opener makes every line under it read as program, so the
    // page's own rendered prose proves a caller and a true finding is deleted.
    it("does not open a script from a tag name quoted inside another tag's attribute", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/notes.html":
          '<div title="example <script>">shown</div>\n<p>Widget was removed</p>\n',
        "public/app.html": "<script>\n  Widget();\n</script>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A brace binds only where the format gives it meaning: `{Widget()}` invokes the symbol in a
    // single-file component, while the same braces in static HTML, XML or SVG are characters the
    // page shows. Reading those as an expression deletes a true finding.
    it("does not count a braced name in static markup, and still counts a component expression", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/live.svelte": "<p>{Widget()}</p>\n",
        "public/notes.html": "<p>Write {Widget} literally</p>\n",
        "public/icon.svg": "<title>{Widget} was removed</title>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/icon.svg");
    });

    // The two shapes with no code punctuation around them at all: a Svelte directive binding
    // (`use:enhance`) and an Astro frontmatter call, which runs above the markup rather than in a
    // `<script>`. Both name the symbol as plainly as an ordinary call does.
    it("counts a template directive and a call in Astro frontmatter", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/form.svelte": "<form use:Widget>\n</form>\n",
        "src/ui/wrapped.svelte": "<form\n  use:Widget\n>\n</form>\n",
        "src/pages/index.astro":
          "---\nimport { Widget } from '../ui/widget';\nconst html = Widget();\n---\n<main>{html}</main>\n",
        "public/notes.html": "<p>Widget was removed in favour of Panel</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/form.svelte");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/wrapped.svelte");
      expect(result.deadcode.dropped[0].reason).toContain("src/pages/index.astro");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A directive prefix binds inside a tag. Rendered text that happens to end in one — `The old
    // use:` before the symbol — is a sentence, and reading it as a binding lets a doc page prove
    // its own caller and delete a true finding.
    it("does not count a directive prefix in rendered text", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/form.svelte": "<form use:Widget>\n</form>\n",
        "public/notes.html": "<p>The old use: Widget was removed</p>\n",
        "src/ui/notes.vue": "<template>\n  <p>Written in: Widget, now gone</p>\n</template>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/form.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.vue");
    });

    // An attribute binds inside the tag that declares it. Rendered text that spells one — `<p>Write
    // onclick=Widget in docs</p>` — is a sentence whose tag closed before the symbol, and reading
    // it as a handler lets a doc page prove its own caller. The handler that really runs still
    // counts, including one whose value shows a `>` the tag does not end at.
    it("does not count a handler attribute spelled in rendered text", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "public/notes.html": "<p>Write onclick=Widget in docs</p>\n",
        "public/quoted.html": '<p>Write <code>onclick="Widget()"</code> in docs</p>\n',
        "public/app.html": '<button onclick="a > b && Widget()">go</button>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/quoted.html");
    });

    // Vue interpolates with `{{ … }}`: a single brace in its template is a character the page
    // shows, so applying Svelte's one-brace rule to a `.vue` file lets prose prove its own caller.
    // The doubled brace still runs there, and one brace still runs in Svelte and Astro.
    it("requires doubled braces for a Vue interpolation, and keeps one for Svelte", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notes.vue": "<template>\n  <p>Write {Widget} literally</p>\n</template>\n",
        "src/ui/live.vue": "<template>\n  <p>{{ Widget() }}</p>\n</template>\n",
        "src/ui/live.svelte": "<p>{Widget()}</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.vue");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.vue");
    });

    // ...and `{{` is a delimiter rather than a nesting: prose that happens to nest two single
    // braces — `<p>Write {one {Widget} two} literally</p>` — interpolates nothing, so reading its
    // depth as an expression makes the sentence a caller and deletes a true finding. A Vue
    // expression that really does nest a brace still runs.
    it("opens a Vue interpolation on adjacent braces only, not on nested ones", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notes.vue": "<template>\n  <p>Write {one {Widget} two} literally</p>\n</template>\n",
        "src/ui/nested.vue": "<template>\n  <p>{{ fn({ a: Widget }) }}</p>\n</template>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/nested.vue");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.vue");
    });

    // A `<script>` runs between its tags, not across its line. Rendered text sharing the line with
    // one is still markup, so reading the whole line as code lets that prose prove a caller and
    // delete a true finding — while the script's own body has to keep counting.
    it("reads a script's body rather than its whole line", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "public/notes.html": "<p>neverCalled was removed</p><script>const x = 1;</script>\n",
        "public/braced.html": "<script>const o = {};</script><p>neverCalled was removed</p>\n",
        "public/app.html": "<p>still wired</p><script>neverCalled();</script>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/braced.html");
    });

    // A `>` inside a quoted attribute is part of the value, not the end of the tag. Ending the
    // opening tag there hands the rest of the attribute back as script body, so text a reader sees
    // reads as a program and proves its own caller — while the script beside it still has to run.
    it("keeps a quoted greater-than inside a script tag out of its body", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "public/notes.html": '<script title="> neverCalled was removed">const x = 1;</script>\n',
        "public/app.html": "<script>neverCalled();</script>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("public/app.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
    });

    // A template expression closes on its own line too — `<p>{version} Widget was removed</p>`
    // renders the symbol as text once `}` has run. Reading any earlier `{` as executable context
    // lets a committed page prove its own caller and erase a genuinely unused symbol.
    it("counts a markup symbol only while its expression is still open", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/live.svelte": "<p>{Widget(version)} shipped</p>\n",
        "src/ui/notes.svelte": "<p>{version} Widget was removed in favour of Panel</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.svelte");
    });

    // ...and an interpolation that wraps stays open across the lines it spans: `<div>{{` with the
    // call under it names a caller the template really invokes, and reading that line alone
    // reports a live binding dead. A blank line still ends the expression, and a `<style>` rule's
    // braces never open one, so neither can let prose below prove a caller.
    it("counts a markup symbol inside an expression opened on an earlier line", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/live.vue": "<template>\n  <div>{{\n    Widget()\n  }}</div>\n</template>\n",
        "public/notes.html": "<p>Press { to open the menu</p>\n\n<p>Widget was removed</p>\n",
        "src/ui/theme.svelte": '<style>\n  .banner {\n    content: "Widget was removed";\n  }\n</style>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.vue");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/theme.svelte");
    });

    // A CSS rule's brace is the stylesheet's own punctuation on the line it opens on as well:
    // `.notice::after { content: "Widget was removed"; }` shows the name to a reader. Reading that
    // brace as a template interpolation makes a stylesheet prove its own caller and deletes a true
    // finding about a genuinely unused symbol.
    it("does not count a symbol inside a style rule that opens on its own line", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/live.svelte": "<p>{Widget()}</p>\n",
        "src/ui/theme.svelte":
          '<style>\n  .notice::after { content: "Widget was removed"; }\n</style>\n',
        "src/ui/inline.vue":
          '<template>\n  <p>shipped</p>\n</template>\n<style>.notice { content: "Widget"; }</style>\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/theme.svelte");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/inline.vue");
    });

    // A brace inside a string is text rather than the end of the expression holding it: `{ready ?
    // "}"` with the call under it still runs. Counting the quoted one closes the expression a line
    // early, so the caller below reads as markdown and a live component is reported dead.
    it("counts an MDX symbol under a quoted brace in a multiline expression", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/live.mdx": '{ready\n  ? "}"\n  : Widget()}\n',
        "docs/notes.mdx": "Widget was removed in favour of Panel\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/live.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // A quoted brace does not close the expression around it, and a backtick inside one that is
    // still open is a template literal rather than a markdown code span: reading `{ready ? "}" :
    // `${Widget()}`}` the other way blanks the literal and the caller it interpolates, and the live
    // component goes on being reported dead.
    it("counts an MDX template literal beside a quoted brace in the same expression", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/live.mdx": '{ready\n  ? "}"\n  : `${Widget()}`}\n',
        "docs/notes.mdx": "The `Widget` helper was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/live.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // Markdown writes a literal brace as `\{`, which opens no expression. Counting it reads the
    // sentence behind it as code, so a page that only mentions the symbol proves its own caller and
    // erases a genuinely unused one — while a real expression on the same page still counts.
    it("reads an escaped brace in MDX prose as text, not an open expression", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/uses.mdx": "Rendered with {Widget()} on the page.\n",
        "docs/notes.mdx": "Use \\{ before Widget in prose.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/uses.mdx");
      expect(result.deadcode.dropped[0].reason).not.toContain("docs/notes.mdx");
    });

    // A `.tsx` file is a program, but not everything on its lines runs: the text a tag opens and a
    // plain string prop are what the page shows a reader. Reading either as code lets a page that
    // merely names the symbol prove its own caller and erase a genuinely unused one — while the
    // import that renders it, and a generic closing with the same `>` a tag does, still count.
    it("reads JSX text and string props as prose, and still counts the code beside them", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/panel.tsx": "export const Panel = () => <p>Widget was removed in favour of Panel</p>;\n",
        "src/ui/notice.tsx": 'export const Notice = () => <p title="Widget was removed">gone</p>;\n',
        "src/ui/page.tsx": "import { Widget } from './widget';\nexport const Page = () => <Widget />;\n",
        "src/ui/registry.tsx": "export const registry = new Map<string, Widget>([['a', Widget]]);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/page.tsx");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/registry.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/panel.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notice.tsx");
    });

    // ...and that text wraps onto lines of its own as ordinary formatting: `<p>` with the sentence
    // under it renders the symbol exactly as the single-line form does, and judging that line alone
    // reads a paragraph as program text and deletes a finding that was right. The run ends at the
    // first punctuation, so an interpolation under the same tag still counts as the call it is.
    it("reads JSX text wrapped onto its own line as prose, and still counts a call under a tag", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/panel.tsx":
          "export const Panel = () => (\n  <p>\n    Widget was removed in favour of Panel\n  </p>\n);\n",
        "src/ui/live.tsx": "export const Live = () => (\n  <p>\n    {Widget()}\n  </p>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/panel.tsx");
    });

    // A fragment renders its children the same way a named tag does: `<>` with a sentence under it
    // is prose, and reading it as program text lets a page that merely names the symbol prove its
    // own caller. The interpolation under the same fragment still counts as the call it is.
    it("reads JSX text inside a fragment as prose, and still counts a call under one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/panel.tsx":
          "export const Panel = () => (\n  <>\n    Widget was removed in favour of Panel\n  </>\n);\n",
        "src/ui/live.tsx": "export const Live = () => (\n  <>\n    {Widget()}\n  </>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/panel.tsx");
    });

    // A child expression closes on the line that opened it: `<p>{version} Widget was removed</p>`
    // renders the symbol as text once `}` has run, and a tag whose attribute interpolates still
    // opens the prose under it. Reading either brace as executable context lets a page that merely
    // names the symbol prove its own caller and erase a genuinely unused one — while the symbol
    // inside an expression the line leaves open counts as the call it is.
    it("reads JSX text after a closed interpolation as prose, and still counts one left open", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notes.tsx":
          "export const Notes = () => <p>{version} Widget was removed in favour of Panel</p>;\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n  <p className={styles.note}>\n" +
          "    Widget was removed in favour of Panel\n  </p>\n);\n",
        "src/ui/live.tsx": "export const Live = () => <p>{version} {Widget()}</p>;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // A character entity is how rendered JSX writes punctuation its syntax would otherwise take:
    // `<p>&mdash; Widget was removed</p>` is prose. Reading the `&` and `;` it spells as the
    // program's operators makes that paragraph code again and deletes a true finding, while the
    // interpolation beside the same entity stays the call it is.
    it("reads a JSX entity as rendered text, and still counts a call beside one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notes.tsx": "export const Notes = () => <p>&mdash; Widget was removed</p>;\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n  <p>\n    &#8212;&nbsp;Widget was removed\n  </p>\n);\n",
        "src/ui/live.tsx": "export const Live = () => <p>&mdash; {Widget()}</p>;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // A prop's value shows the angle bracket it holds — `<p title="a > b">Widget was removed</p>`.
    // Ending the tag at that `>` leaves the element unopened, so the prose behind it reads as
    // program and a paragraph naming a removed component proves its own caller. The value that
    // wraps carries the same bracket onto the line under it, while the call beside one stays the
    // call it is.
    it("reads JSX text after a quoted angle bracket in a prop as prose", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notes.tsx":
          'export const Notes = () => <p title="a > b">Widget was removed in favour of Panel</p>;\n',
        "src/ui/note.tsx":
          'export const Note = () => (\n  <p\n    title="a > b"\n  >\n' +
          "    Widget was removed in favour of Panel\n  </p>\n);\n",
        "src/ui/live.tsx": 'export const Live = () => <p title="a > b">{Widget()}</p>;\n',
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notes.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // Children nest, and a sibling element closes only itself: the paragraph beside `<span>gone
    // </span>` is still the text their `<div>` opened. Reading that `</span>` as the end of the
    // parent's text makes the prose under it program again, so a page that merely names the symbol
    // proves its own caller — while the interpolation beside the same sibling stays the call it is.
    it("reads JSX text beside a nested element as prose, and still counts a call beside one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/panel.tsx":
          "export const Panel = () => (\n  <div>\n    <span>gone</span>\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <div>\n    <span>gone</span>\n" +
          "    {Widget()}\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/panel.tsx");
    });

    // The same nesting holds along a line, not just down the page: the prose after `<strong>Note:
    // </strong>` or a self-closing `<Icon />` is still the text their `<p>` opened, and the closing
    // punctuation in front of it is the child's, not the parent's. Reading it as program lets a page
    // that only names the symbol prove its own caller — while the interpolation after the same child
    // stays the call it is.
    it("reads JSX text after an inline child tag as prose, and still counts a call after one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n" +
          "  <p><strong>Note:</strong> Widget was removed in favour of Panel</p>\n);\n",
        "src/ui/icon.tsx":
          "export const Icon = () => (\n" +
          "  <p><Info /> Widget was removed in favour of Panel</p>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <p><strong>Note:</strong> {Widget()}</p>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/icon.tsx");
    });

    // Rendered prose carries ordinary punctuation. JSX gives an operator no meaning between a tag
    // and its children — code stands there only inside a `{…}` — so a slash in `A/B` or an
    // ampersand in `R&D` is a character the page shows, and reading it as program lets a doc page
    // prove its own caller. Nor does it end the element: the paragraph under `A/B testing` is
    // still the `<div>`'s text. The interpolation and the tag beside that prose stay code.
    it("reads JSX text holding an operator as prose, and still counts the code beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/slash.tsx": "export const Doc = () => <p>A/B Widget documentation</p>;\n",
        "src/ui/prose.tsx":
          "export const Note = () => (\n" +
          "  <p>R&D + QA dropped Widget in favour of Panel</p>\n);\n",
        "src/ui/multi.tsx":
          "export const Multi = () => (\n  <div>\n    A/B testing\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx": "export const Live = () => <p>{Widget()}</p>;\n",
        "src/ui/after.tsx":
          "export const After = () => (\n  <div>\n    A/B testing\n" +
          "    <Widget />\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/after.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/slash.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/prose.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/multi.tsx");
    });

    // Prose brackets its asides. Code stands between a tag and its children only inside a `{…}`,
    // so the parentheses around `(deprecated)` are characters the page shows — reading them as
    // program lets a doc page prove its own caller, and ends the element so the sentence under the
    // aside reads as program too. The call beside that prose keeps the parentheses it really uses.
    it("reads JSX text holding parentheses as prose, and still counts a call beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/aside.tsx": "export const Doc = () => <p>(Widget was removed)</p>;\n",
        "src/ui/multi.tsx":
          "export const Multi = () => (\n  <div>\n    (deprecated)\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx": "export const Live = () => <p>{Widget()}</p>;\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/aside.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/multi.tsx");
    });

    // Prose brackets the name it labels. Code stands between a tag and its children only inside a
    // `{…}`, so the `[]` around `[Widget]` are characters the page shows — reading them as program
    // lets a doc page prove its own caller, and ends the element so the sentence under the label
    // reads as program too. Outside every element the same brackets still list and index, and the
    // module that puts the symbol in an array keeps counting.
    it("reads JSX text holding brackets as prose, and still counts an array beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/bracket.tsx": "export const Doc = () => <p>[Widget] was removed</p>;\n",
        "src/ui/multi.tsx":
          "export const Multi = () => (\n  <div>\n    [deprecated]\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx": "export const items = [Widget];\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/bracket.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/multi.tsx");
    });

    // Prose joins its clauses with a semicolon. Code stands between a tag and its children only
    // inside a `{…}`, so the `;` in `Deprecated; Widget was removed` is a character the page shows
    // — reading it as program lets a doc page prove its own caller, and ends the element so the
    // sentence under it reads as program too. The statement beside that prose keeps its own.
    it("reads JSX text holding a semicolon as prose, and still counts the statement beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/clause.tsx": "export const Doc = () => <p>Deprecated; Widget was removed</p>;\n",
        "src/ui/multi.tsx":
          "export const Multi = () => (\n  <div>\n    Deprecated; superseded\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx": "export const Live = () => {\n  const el = Widget();\n  return el;\n};\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/clause.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/multi.tsx");
    });

    // Prose writes an equals sign too. Code stands between a tag and its children only inside a
    // `{…}`, so the `=` in `Status = Widget was removed` is a character the page shows — reading it
    // as program lets a doc page prove its own caller, and ends the element so the sentence under
    // it reads as program too. Outside every element the same sign still binds a name, and the
    // module that assigns the call keeps counting.
    it("reads JSX text holding an equals sign as prose, and still counts the assignment beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/label.tsx": "export const Doc = () => <p>Status = Widget was removed</p>;\n",
        "src/ui/multi.tsx":
          "export const Multi = () => (\n  <div>\n    Status = deprecated\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx": "export const Live = () => {\n  const el = Widget();\n  return el;\n};\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/label.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/multi.tsx");
    });

    // A component spaces its children apart, and JSX gives that gap no meaning: the paragraph under
    // an empty line is still the `<div>`'s text, so closing the element there reads the prose as
    // program and lets a sentence naming a removed component prove its own caller. MDX and markup
    // do end a block at a blank line — a module does not. The call written under the same gap is
    // still the call it is.
    it("keeps a JSX element open across a blank line, and still counts a call under one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/gap.tsx":
          "export const Doc = () => (\n  <div>\n    <Header />\n\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <div>\n    <Header />\n\n" +
          "    {Widget()}\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/gap.tsx");
    });

    // A child expression wraps onto lines of its own too, and it is the element's child rather
    // than the end of it: `<div>` with `{ready &&` under it still renders the prose written after
    // the brace closes. Ending the parent's text on that opener reads the sentence below as
    // program and lets a paragraph naming a removed component prove its own caller — while the
    // lines the expression itself spans stay the code they are.
    it("keeps a JSX element open across a wrapped child expression, and still counts a call inside one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n  <div>\n    {ready &&\n      <span />}\n" +
          "    Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <div>\n    {ready &&\n      Widget()}\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // Elements nest down the page, and how many stand open is what the line under them is reading:
    // the prose after a `</span>` closed two levels deep is still the `<div>`'s text. Counting one
    // parent for any depth subtracts that child and reads the sentence as program, so a page naming
    // a removed component proves its own caller — while the interpolation after the same closing
    // tag stays the call it is.
    it("reads JSX text after a closing tag nested two deep as prose, and still counts a call there", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n  <div>\n    <span>\n      gone\n" +
          "    </span> Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <div>\n    <span>\n      gone\n" +
          "    </span> {Widget()}\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // A wrapped child expression can also end on the line that names the symbol: `{ready &&` closes
    // with `<span />}` and the parent's children resume behind that brace. Reading the whole line as
    // the program the expression opened lets the prose after it prove its own caller — while the
    // interpolation written in the same place is still the call it is.
    it("resumes JSX text past the brace that closes a wrapped expression, and still counts a call there", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/note.tsx":
          "export const Note = () => (\n  <div>\n    {ready &&\n" +
          "      <span />} Widget was removed in favour of Panel\n  </div>\n);\n",
        "src/ui/live.tsx":
          "export const Live = () => (\n  <div>\n    {ready &&\n" +
          "      <span />} {Widget()}\n  </div>\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/note.tsx");
    });

    // A tag's props wrap onto lines of their own as ordinary formatting, and so can the value of
    // one: the line carrying `title="Widget was removed"` has no opener on it, and the line under
    // `title="` has neither. Judging either alone reads a static prop as program and lets it prove
    // its own caller — while the expression prop beside them is still the call it is.
    it("reads a static prop wrapped onto its own line as prose, and still counts one that runs", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notice.tsx":
          "export const Notice = () => (\n  <Empty\n" +
          '    title="Widget was removed in favour of Panel"\n  />\n);\n',
        "src/ui/split.tsx":
          "export const Split = () => (\n  <Empty\n" +
          '    title="\n      Widget was removed in favour of Panel\n    "\n  />\n);\n',
        "src/ui/live.tsx":
          "export const Live = () => (\n  <Empty\n    body={Widget()}\n  />\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notice.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/split.tsx");
    });

    // Only the quote decides what a prop shows. JSX interpolates a braced value the attribute
    // writes bare, so a brace inside the quotes is a character the prop renders: rejecting
    // `title="Use {Widget} here"` over its own punctuation reads a rendered prop as program and
    // lets it prove its own caller — while the bare braced prop beside it is still the call it is.
    it("keeps a brace inside a quoted JSX prop inert, and still counts a bare braced one", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notice.tsx":
          'export const Notice = () => <Empty title="Use {Widget} here — it was removed" />;\n',
        "src/ui/split.tsx":
          "export const Split = () => (\n  <Empty\n" +
          '    title="Use {Widget} here — it was removed"\n  />\n);\n',
        "src/ui/live.tsx": "export const Live = () => (\n  <Empty\n    body={Widget()}\n  />\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notice.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/split.tsx");
    });

    // A wrapped value ends at the quote that opened it, not at any quote: the apostrophe in a
    // double-quoted `title` is prose, and reading it as the end of the value makes the sentence
    // behind it program — which lets a page that only names the symbol prove its own caller. Past
    // the real closing quote the line is the attribute list again, where a static prop is prose too.
    it("ends a wrapped JSX prop at its own quote, not at an apostrophe inside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/notice.tsx":
          "export const Notice = () => (\n  <Empty\n    title=\"\n" +
          "      It's Widget documentation, now gone\n    \"\n  />\n);\n",
        "src/ui/split.tsx":
          'export const Split = () => (\n  <Empty\n    body="\n      still open\n' +
          '    " title="Widget was removed"\n  />\n);\n',
        "src/ui/live.tsx":
          "export const Live = () => (\n  <Empty\n    body={Widget()}\n  />\n);\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/live.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/notice.tsx");
      expect(result.deadcode.dropped[0].reason).not.toContain("src/ui/split.tsx");
    });

    // SQL comments out the rest of a line with `--`, which can open after code: the line test the
    // unknown-language fallback runs sees a statement, and the prose behind it reads as a call.
    it("masks a SQL comment opened after code, and still counts the call beside one", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "db/notes.sql": "SELECT 1; -- neverCalled was removed\n",
        "db/caller.sql": "SELECT neverCalled(); -- still wired up\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("db/caller.sql");
      expect(result.deadcode.dropped[0].reason).not.toContain("db/notes.sql");
    });

    // A file anton has no grammar for still has block comments: `.jsonnet` writes them `/* ... */`,
    // and their continuation lines carry no marker for the line test to see. Accepting one as code
    // deletes a genuine finding — while a real call below the block still has to count.
    it("tracks block comments in a file anton has no grammar for, and still counts its callers", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "infra/notes.jsonnet": "/*\nneverCalled was removed\n*/\n{}\n",
        "infra/caller.jsonnet": "/*\nneverCalled is called below.\n*/\n{ value: neverCalled() }\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("infra/caller.jsonnet");
      expect(result.deadcode.dropped[0].reason).not.toContain("infra/notes.jsonnet");
    });

    // HCL comments with `#` and `//`, both of which can open after code — a shape the unknown-
    // language line test cannot see, so `ami = "ami-1" # neverCalled was removed` reads as a call
    // and deletes a true finding. A real HCL call on the line beside one still has to count.
    it("masks an HCL comment opened after code, and still counts the call beside one", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "infra/notes.tf":
          'variable "ami" {\n  default = "ami-1" # neverCalled was removed\n' +
          "  tags = {} // neverCalled went with it\n}\n",
        "infra/caller.tf": "locals {\n  hook = neverCalled(var.env) # still wired up\n}\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("infra/caller.tf");
      expect(result.deadcode.dropped[0].reason).not.toContain("infra/notes.tf");
    });

    it("drops an unused type the same way, and reads a whole-word reference only", async () => {
      const repo = initRepo({
        "src/lib/types.ts": "export type ScanPass = { id: string };\n",
        "src/lib/pass.ts": "import type { ScanPass } from './types';\nexport const p: ScanPass = { id: '1' };\n",
        // `neverCalledTwice` contains `neverCalled`, but a substring is not a reference to it.
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "src/lib/other.ts": "export function neverCalledTwice() {}\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/types.ts", "ScanPass", "unused-type"),
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ Title: "Unused function: neverCalled" }]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "ScanPass", kind: "unused-type" }]);
    });

    // Under-filtering costs one triaged bead; over-filtering deletes a finding nobody hears about
    // again. So anything anton cannot check rides through untouched.
    it("keeps every signal it cannot check — other collectors, unreadable titles, pathless signals", async () => {
      const repo = initRepo({ "src/lib/orphan.ts": "export function neverCalled() {}\n" });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        { Source: "todos", Kind: "todo", FilePath: "src/lib/orphan.ts", Title: "TODO: neverCalled" },
        { ...unused("src/lib/orphan.ts", "neverCalled"), Title: "Dead code found in this file" },
        { ...unused("src/lib/orphan.ts", "neverCalled"), FilePath: "" },
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(3);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // A filter that can't search the tree must under-filter rather than delete findings — and say
    // why, so the surviving signals aren't read as the repo suddenly growing dead code.
    it("counts everything and reports why when the tree cannot be searched", async () => {
      const notARepo = join(dir, "loose");
      mkdirSync(notARepo, { recursive: true });
      writeFileSync(join(notARepo, "orphan.ts"), "export function neverCalled() {}\n", "utf8");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: notARepo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(1);
      expect(result.deadcode.dropped).toEqual([]);
      expect(result.deadcode.unavailable).toBeTruthy();
      expect(describeDeadcodeFilter(result.deadcode)).toContain("could not be searched");
    });

    // `git grep -w` counts `$` as a non-word character, so a `$`-suffixed identifier still matches
    // at its own boundaries — the check has to find those callers, not read the symbol as unmatched
    // and leave a false finding standing.
    it("finds the callers of a symbol whose name ends in `$`", async () => {
      const repo = initRepo({
        "src/lib/render.ts": "export function render$() {}\n",
        "src/lib/page.ts": "import { render$ } from './render';\nrender$();\n",
      });

      const result = await filterDeadcodeSignals(repo, [unused("src/lib/render.ts", "render$")]);

      expect(result.kept).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "render$" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/page.ts");
    });

    // `git grep -w` breaks a word on `$` and `#`, but JavaScript spells identifiers with both, so
    // grep hands back `$mount` and `this.#mount` for a search on `mount`. Reading those as callers
    // deletes a true finding — while the `boot` call in the same file still has to count, so the
    // rejection is the boundary rule and not a file the check never read.
    it("reads `$` and `#` as identifier characters rather than word boundaries", async () => {
      const repo = initRepo({
        "src/lib/mount.ts": "export function mount() {}\n",
        "src/lib/boot.ts": "export function boot() {}\n",
        "src/lib/other.ts": "export const $mount = 1;\nexport const mount$ = 2;\n",
        "src/lib/klass.ts":
          "import { boot } from './boot';\nexport class K {\n  #mount() {}\n  run() {\n    this.#mount();\n    boot();\n  }\n}\n",
      });

      const result = await filterDeadcodeSignals(repo, [
        unused("src/lib/mount.ts", "mount"),
        unused("src/lib/boot.ts", "boot"),
      ]);

      expect(result.kept).toMatchObject([{ Title: "Unused function: mount" }]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "boot" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/lib/klass.ts");
    });

    // Two dead symbols with the same name in different files each mention themselves, so excluding
    // only the signal's own path makes each declaration read as the other's caller — silently
    // erasing both true findings.
    it("does not read one declaration of a symbol as a caller of its namesake", async () => {
      const repo = initRepo({
        "packages/a/format.ts": "export function format() {}\n",
        "packages/b/format.ts": "export function format() {}\n",
        "packages/b/use.ts": "export function helper() {}\n",
      });

      const result = await filterDeadcodeSignals(repo, [
        unused("packages/a/format.ts", "format"),
        unused("packages/b/format.ts", "format"),
      ]);

      expect(result.kept).toHaveLength(2);
      expect(result.deadcode.dropped).toEqual([]);
    });

    // The sibling exclusion must not swallow a real caller: a third file that calls the symbol still
    // drops both signals, so the fix stays a declaration rule rather than a blanket mute.
    it("still drops namesake declarations when a third file calls the symbol", async () => {
      const repo = initRepo({
        "packages/a/format.ts": "export function format() {}\n",
        "packages/b/format.ts": "export function format() {}\n",
        "packages/b/use.ts": "import { format } from './format';\nformat();\n",
      });

      const result = await filterDeadcodeSignals(repo, [
        unused("packages/a/format.ts", "format"),
        unused("packages/b/format.ts", "format"),
      ]);

      expect(result.kept).toEqual([]);
      expect(result.deadcode.dropped).toHaveLength(2);
      expect(result.deadcode.dropped[0].reason).toContain("packages/b/use.ts");
      expect(result.deadcode.dropped[0].reason).not.toContain("format.ts");
    });

    // The budget stops a baseline pass from spending a nightly on greps, but a truncated pass that
    // says nothing reads exactly like a verified one — the health record would count findings the
    // tree was never asked about.
    it("reports how many signals the symbol budget left unchecked, and keeps them", async () => {
      const repo = initRepo({
        "src/testing/integration.ts": "export function withOperator() {}\n",
        "src/routes/claim.test.ts": "withOperator();\n",
      });
      // One signal per distinct symbol fills the budget, then the one with a real caller sits past
      // it: unchecked, so it must survive rather than be dropped.
      const signals = [
        ...Array.from({ length: SYMBOL_BUDGET }, (_, i) => unused("src/lib/orphan.ts", `dead${i}`)),
        unused("src/testing/integration.ts", "withOperator"),
      ];

      const result = await filterDeadcodeSignals(repo, signals);

      expect(result.kept).toHaveLength(signals.length);
      expect(result.deadcode.dropped).toEqual([]);
      expect(result.deadcode.unchecked).toBe(1);
      expect(describeDeadcodeFilter(result.deadcode)).toContain("1 dead-code signal(s) were counted unchecked");
    });

    // The budget withholds greps, not answers: a symbol already searched is in hand, so a signal
    // past the budget that names one is still checked. Counting it unchecked would leave a signal
    // standing that this very pass had already contradicted.
    it("still checks a signal past the budget whose symbol was already searched", async () => {
      const repo = initRepo({
        "src/testing/integration.ts": "export function withOperator() {}\n",
        "src/routes/claim.test.ts": "withOperator();\n",
      });
      // The budget fills on withOperator plus one signal per distinct dead symbol. Past it sits an
      // unsearched symbol — which goes unchecked — and a second withOperator, whose answer is free.
      const signals = [
        unused("src/testing/integration.ts", "withOperator"),
        ...Array.from({ length: SYMBOL_BUDGET - 1 }, (_, i) =>
          unused("src/lib/orphan.ts", `dead${i}`),
        ),
        unused("src/lib/orphan.ts", "unsearched"),
        unused("src/testing/integration.ts", "withOperator"),
      ];

      const result = await filterDeadcodeSignals(repo, signals);

      expect(result.deadcode.unchecked).toBe(1);
      expect(result.deadcode.dropped).toHaveLength(2);
      expect(result.kept).toHaveLength(signals.length - 2);
    });

    // A cancelled job must stop the check, not ride it out: the greps are what the shutdown waits
    // on, and a filter that returned a verdict anyway would let the pass record itself.
    describe("cancellation", () => {
      it("starts no grep once the caller has aborted", async () => {
        const repo = initRepo({
          "src/testing/integration.ts": "export function withOperator() {}\n",
          "src/routes/claim.test.ts": "withOperator();\n",
        });

        await expect(
          filterDeadcodeSignals(repo, [unused("src/testing/integration.ts", "withOperator")], {
            abort: AbortSignal.abort(),
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
      });

      // The abort kills the grep anton is waiting on; reporting that as an unsearchable tree would
      // count the pass as verified-but-unavailable and let it finish writing.
      it("rejects rather than reporting the killed grep as an unsearchable tree", async () => {
        const repo = initRepo({
          "src/testing/integration.ts": "export function withOperator() {}\n",
          "src/routes/claim.test.ts": "withOperator();\n",
        });
        const ac = new AbortController();
        const filtering = filterDeadcodeSignals(
          repo,
          [unused("src/testing/integration.ts", "withOperator")],
          { abort: ac.signal },
        );
        ac.abort();

        await expect(filtering).rejects.toMatchObject({ name: "AbortError" });
      });
    });
  });

  // anton-vb2h: the `duplication` collector matches token windows, so this repo's house doc
  // comments, its import specifier lists and its interface field lists all read as clones. The
  // 2026-08-19 scan spent 97 of its 121 signals on `duplication` and 42 of those named a window
  // holding no statement at all; triage paid a full pass to throw them away.
  describe("duplication signals over blocks that declare rather than compute", () => {
    /** A source tree — no git, since nothing here is a claim about the index. */
    function writeRepo(files: Record<string, string>): string {
      const repo = join(dir, "dup-repo");
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(repo, name, ".."), { recursive: true });
        writeFileSync(join(repo, name), body, "utf8");
      }
      return repo;
    }

    /** stringer's own phrasing: the block's size in the title, its locations listed in the body. */
    function clone(locations: [string, number][], lines = 6) {
      return {
        Source: "duplication",
        Kind: "code-clone",
        FilePath: locations[0][0],
        Line: locations[0][1],
        Title: `Duplicated block (${lines} lines, ${locations.length} locations)`,
        Description:
          "Duplicated code found in:\n" +
          locations.map(([path, line]) => `  - ${path}:${line}`).join("\n") +
          "\n",
        Tags: ["code-clone", "duplication"],
      };
    }

    const DOC_BLOCK = [
      "/**",
      " * The single place anton runs stringer. It mines a repo for actionable signals and emits",
      " * them as JSON; the nightly job then hands the scan file to claude to convert the few worth",
      " * doing into beads.",
      " *",
      " * The binary is injectable so tests point it at a fake.",
      " */",
      "export const doc = 1;",
      "",
    ].join("\n");

    const IMPORT_BLOCK = [
      "import {",
      "  parseBdVersion,",
      "  parseSchemaVersion,",
      "  preflightBd,",
      "  resetBdBinCache,",
      "  resolveBdBin,",
      "} from './bd-bin';",
      "export const used = [parseBdVersion, resolveBdBin];",
      "",
    ].join("\n");

    const BODY_BLOCK = [
      "export function arrange(sandbox: string) {",
      "  const repo = join(sandbox, 'repo');",
      "  mkdirSync(repo);",
      "  execFileSync('git', ['init', '-q', repo]);",
      "  g(['config', 'user.email', 't@example.com']);",
      "  g(['config', 'user.name', 'anton-test']);",
      "  writeFileSync(join(repo, 'README.md'), '# sandbox');",
      "  return repo;",
      "}",
      "",
    ].join("\n");

    // The three shapes the 2026-08-19 scan was made of, side by side: only the one with statements
    // in it survives, and the verdict comes from the SOURCE at each location — all three signals
    // carry the same collector, kind, title shape and confidence.
    it("drops a doc paragraph and an import list, keeps a function body, on both sides of the seam", async () => {
      const repo = writeRepo({
        "src/doc.ts": DOC_BLOCK,
        "src/doc-twin.ts": DOC_BLOCK,
        "src/imports.ts": IMPORT_BLOCK,
        "src/imports-twin.ts": IMPORT_BLOCK,
        "src/body.ts": BODY_BLOCK,
        "src/body-twin.ts": BODY_BLOCK,
      });
      const scanFile = join(dir, "scan.json");
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), {
        signals: [
          clone([
            ["src/doc.ts", 2],
            ["src/doc-twin.ts", 2],
          ]),
          clone([
            ["src/imports.ts", 2],
            ["src/imports-twin.ts", 2],
          ]),
          clone([
            ["src/body.ts", 2],
            ["src/body-twin.ts", 2],
          ]),
        ],
        metadata: { total_count: 3 },
      });

      const result = await scan({ repoPath: repo, scanFile });

      // Not vacuous: the real clone rides through, so the drop is this filter rather than an empty read.
      expect(result.signals).toMatchObject([{ FilePath: "src/body.ts", AntonSeverity: "low" }]);
      expect(result.duplication.dropped).toMatchObject([
        { path: "src/doc.ts", kind: "code-clone" },
        { path: "src/imports.ts", kind: "code-clone" },
      ]);
      expect(result.duplication.dropped[0].reason).toContain("6 comment");
      expect(result.duplication.dropped[1].reason).toContain("6 import");
      // Counted out loud: a silent filter is indistinguishable from a collector that found nothing.
      const described = describeDuplicationFilter(result.duplication);
      expect(described).toContain("dropped 2 duplication signal(s)");
      expect(described).toContain("src/doc.ts");
      // Same set on both sides: the health record counts `signals`, triage reads the file.
      const written = JSON.parse(readFileSync(scanFile, "utf8")) as { signals: { FilePath: string }[] };
      expect(written.signals.map((s) => s.FilePath)).toEqual(["src/body.ts"]);
    });

    // A window nobody can read is a window nobody can act on either: the file was rewritten under
    // the baseline, so the block stringer measured is not there to check, extract, or verify.
    it("drops a signal whose locations no longer exist on the tree", async () => {
      const repo = writeRepo({ "src/body.ts": BODY_BLOCK });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([
          ["src/deleted.ts", 2],
          ["src/also-deleted.ts", 2],
        ]),
        clone([["src/body.ts", 9000]]),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped.map((d) => d.path)).toEqual([
        "src/deleted.ts",
        "src/body.ts",
      ]);
      for (const drop of result.duplication.dropped) {
        expect(drop.reason).toContain("exist on the tree anymore");
      }
    });

    // The other half of the class: an interface's field list, and a component's destructured props.
    it("reads the source, not the title: a field list and a props list are not clones", async () => {
      const repo = writeRepo({
        "src/shape-draft.ts": [
          "export interface ShapeDraft {",
          "  title: string;",
          "  goal: string;",
          "  acceptance: string;",
          "  context: string;",
          "  outOfScope: string;",
          "  verify: string;",
          "}",
          "",
        ].join("\n"),
        "src/card.tsx": [
          "export function EpicCard({",
          "  slug,",
          "  epic,",
          "  overlay,",
          "  muted,",
          "}: {",
          "  slug: string;",
          "  epic: Epic;",
          "  overlay: boolean;",
          "  muted?: boolean;",
          "}) {",
          "  return null;",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        // A near-duplicate: stringer's OTHER phrasing for the same class of window.
        {
          ...clone([["src/shape-draft.ts", 2]]),
          Kind: "near-duplicate",
          Title: "Near-duplicate block (6 lines, 44 locations, renamed identifiers)",
        },
        clone([["src/card.tsx", 2]]),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped[0]).toMatchObject({ kind: "near-duplicate" });
      expect(result.duplication.dropped[0].reason).toContain("6 type");
      expect(result.duplication.dropped[1].reason).toContain("6 signature");
    });

    // A dynamic `import()` is a call: it loads a module at runtime and drives whatever it resolves
    // into. Reading it as an import declaration would drop a window of real module wiring.
    it("reads a dynamic import() as the call it is, not as an import declaration", async () => {
      const repo = writeRepo({
        "src/plugins.ts": [
          "export function load(register: (m: unknown) => void) {",
          "  import('./alpha').then(register);",
          "  import('./beta').then(register);",
          "  import('./gamma').then(register);",
          "}",
          "",
        ].join("\n"),
        "src/static.ts": [
          "import { alpha } from './alpha';",
          "import { beta } from './beta';",
          "import { gamma } from './gamma';",
          "export const all = [alpha, beta, gamma];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/plugins.ts", 2]], 3),
        clone([["src/static.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/plugins.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/static.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // The argument of a dynamic import can sit on the next line. The opener alone must settle it:
    // reading `import(` as a declaration holds the `).then(register)` below it in import state and
    // drops a window of live module wiring. Go's grouped `import (` still declares.
    it("reads a dynamic import() whose argument wraps to the next line as code", async () => {
      const repo = writeRepo({
        "src/wiring.ts": [
          "export function load(register: (m: unknown) => void) {",
          "  import(",
          "    './alpha'",
          "  ).then(register);",
          "  import(",
          "    './beta'",
          "  ).then(register);",
          "}",
          "",
        ].join("\n"),
        "src/deps.go": [
          "package main",
          "",
          "import (",
          '\t"fmt"',
          '\t"os"',
          '\t"strings"',
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/wiring.ts", 2]], 6),
        clone([["src/deps.go", 3]], 4),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/wiring.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.go" }]);
      expect(result.duplication.dropped[0].reason).toContain("4 import");
    });

    // A bundler hint sits between the keyword and the paren — `import /* webpackIgnore: true */
    // ('./plugin')`. The comment is trivia; the call still loads a module and drives the promise
    // chain hanging off it, so a window of them is duplicated wiring triage can act on.
    it("reads a dynamic import() behind a magic comment as the call it is", async () => {
      const repo = writeRepo({
        "src/lazy.ts": [
          "export function load(register: (m: unknown) => void) {",
          "  import /* webpackIgnore: true */ ('./alpha').then(register);",
          "  import /* webpackIgnore: true */ ('./beta').then(register);",
          "  import /* webpackIgnore: true */ ('./gamma').then(register);",
          "}",
          "",
        ].join("\n"),
        "src/static.ts": [
          "import { alpha } from './alpha';",
          "import { beta } from './beta';",
          "import { gamma } from './gamma';",
          "export const all = [alpha, beta, gamma];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/lazy.ts", 2]], 3),
        clone([["src/static.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/lazy.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/static.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A parameter NAME declares; a parameter DEFAULT runs on every call. A signature whose whole
    // list is `x = build()` is duplicated computation, however much it looks like a props list.
    it("counts a parameter list of defaults as code and one of bare names as a declaration", async () => {
      const repo = writeRepo({
        "src/connect.ts": [
          "export function connect(",
          "  client = createClient(),",
          "  cache = createCache(),",
          "  logger = createLogger(),",
          ") {",
          "  return client;",
          "}",
          "",
        ].join("\n"),
        "src/props.ts": [
          "export function render(",
          "  client: Client,",
          "  cache: Cache,",
          "  logger: Logger,",
          ") {",
          "  return client;",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/connect.ts", 2]], 3),
        clone([["src/props.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/connect.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/props.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // Under-filtering costs one triaged bead; over-filtering deletes a real clone nobody hears
    // about again. So anything anton cannot read as a declaration rides through untouched.
    it("keeps every signal it cannot disprove", async () => {
      const repo = writeRepo({ "src/body.ts": BODY_BLOCK, "src/body-twin.ts": BODY_BLOCK });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        // A title anton can't read a block size out of — nothing to resolve, so nothing to judge.
        { ...clone([["src/body.ts", 2]]), Title: "Duplicated block" },
        // Half declaration, half statements: a tie goes to the signal.
        clone([["src/body.ts", 1]], 3),
        { Source: "todos", Kind: "todo", FilePath: "src/body.ts" },
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toHaveLength(3);
      expect(result.duplication).toEqual({ dropped: [] });
      expect(describeDuplicationFilter(result.duplication)).toBeUndefined();
    });

    // An import statement is not a JS import statement: Python and Go end one with the line, or
    // with a paren block. Reading either as unterminated would classify the whole rest of the file
    // as an import and drop every real clone under it.
    it("ends an import the way Python and Go end one, not the way JS does", async () => {
      const repo = writeRepo({
        "src/report.py": [
          "import os",
          "import sys",
          "",
          "def build(path):",
          "    total = os.stat(path).st_size",
          "    total += len(sys.argv)",
          "    return total",
          "",
        ].join("\n"),
        "src/report.go": [
          "package main",
          "",
          "import (",
          '\t"fmt"',
          '\t"os"',
          ")",
          "",
          "func main() {",
          "\tfmt.Println(len(os.Args))",
          '\tfmt.Println("done")',
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/report.py", 4]], 4),
        clone([["src/report.go", 8]], 4),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => (s as { FilePath: string }).FilePath)).toEqual([
        "src/report.py",
        "src/report.go",
      ]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `enum` is the one TYPE_START form that survives compilation: its members run at module init,
    // so a duplicated enum body can hold real computation. Only the erased spellings declare.
    it("reads a runtime enum body as code and an erased one as a declaration", async () => {
      const repo = writeRepo({
        "src/mode.ts": [
          "export enum Mode {",
          "  Draft = label('draft'),",
          "  Ready = label('ready'),",
          "  Done = label('done'),",
          "}",
          "",
        ].join("\n"),
        "src/kind.ts": [
          "export const enum Kind {",
          "  Draft = 'draft',",
          "  Ready = 'ready',",
          "  Done = 'done',",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/mode.ts", 1]], 5),
        clone([["src/kind.ts", 1]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/mode.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/kind.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("5 type");
    });

    // A `type X =` alias opens no bracket, so a repo that writes no semicolons ends one with the
    // line. Reading it as unterminated would classify every function under it as a type declaration
    // and drop the real clones among them.
    it("ends a type alias in a repo that writes no semicolons, not at the next stray brace", async () => {
      const repo = writeRepo({
        "src/status.ts": [
          'export type Status = "ready" | "done"',
          "",
          "export function tally(items: string[]) {",
          "  let ready = 0",
          "  for (const item of items) ready += item.length",
          "  return ready",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/status.ts", 3]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/status.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Each member of a union of inline objects closes a brace without ending the alias. Cutting the
    // statement there would classify the members after the first as code and keep a signal over a
    // block that only declares.
    it("carries a type alias across union members that close their own braces", async () => {
      const repo = writeRepo({
        "src/config.ts": [
          "export type Config =",
          '  | { mode: "dev"; port: number }',
          '  | { mode: "prod"; port: number }',
          '  | { mode: "test"; port: number };',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/config.ts", 1]], 4),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped[0].reason).toContain("4 type");
    });

    // A leading `*` only reads as comment text INSIDE a block comment — the branch above already
    // claims every line of one. Outside it, the operator continues an expression and computes.
    it("reads a leading `*` as multiplication, not as a comment, outside a block comment", async () => {
      const repo = writeRepo({
        "src/scale.ts": [
          "export function scale(a: number, b: number, c: number) {",
          "  return a",
          "    * b",
          "    * c",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/scale.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/scale.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The line that closes a parameter list declares nothing when it opens a body — but an
    // expression-bodied arrow puts the whole body on it, and that body runs on every call.
    it("counts the arrow body on a closing parameter line as code, and a `) {` as a signature", async () => {
      const repo = writeRepo({
        "src/multiply.ts": [
          "export const multiply = (",
          "  left: number,",
          "  right: number,",
          ") => left * right;",
          "",
        ].join("\n"),
        "src/describe.ts": [
          "export function describe(",
          "  left: number,",
          "  right: number,",
          ") {",
          "  return left;",
          "}",
          "",
        ].join("\n"),
      });
      // Both windows are the tail of the parameter list plus the line that closes it — the same
      // shape, told apart only by what that closing line carries.
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/multiply.ts", 3]], 2),
        clone([["src/describe.ts", 3]], 2),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/multiply.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/describe.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("2 signature");
    });

    // A window holding a function's WHOLE body — its parameter list and the `) => execute(…)` that
    // closes it — is a duplicated function, so the parameter lines above the body do not outvote it.
    // The same parameters whose body lives BELOW the window still declare, and so does a list whose
    // only executable line is a literal default: the override is a body, not any code line at all.
    it("keeps a window carrying the arrow's whole body, however many parameter lines precede it", async () => {
      const repo = writeRepo({
        "src/dispatch.ts": [
          "export const dispatch = (",
          "  job: Job,",
          "  repo: string,",
          "  logger: Logger,",
          "  signal: AbortSignal,",
          ") => execute(job, repo, logger, signal);",
          "",
        ].join("\n"),
        "src/collect.ts": [
          "export function collect(",
          "  job: Job,",
          "  repo: string,",
          "  logger: Logger,",
          "  signal: AbortSignal,",
          ") {",
          "  return execute(job, repo, logger, signal);",
          "}",
          "",
        ].join("\n"),
        "src/panel.ts": [
          "export function Panel({",
          "  title,",
          "  subtitle,",
          "  budgetAware = false,",
          "  onSelect,",
          "}: PanelProps) {",
          "  return render(title);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/dispatch.ts", 1]], 6),
        clone([["src/collect.ts", 1]], 6),
        clone([["src/panel.ts", 1]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/dispatch.ts" }]);
      expect(result.duplication.dropped.map((d) => d.path)).toEqual([
        "src/collect.ts",
        "src/panel.ts",
      ]);
      expect(result.duplication.dropped[0].reason).toContain("6 signature");
      expect(result.duplication.dropped[1].reason).toContain("4 signature");
    });

    // The same complete function written with a BRACED body: the parameter list closes on `) {` and
    // the work happens below it. The window holds the whole definition, so its parameter lines must
    // not outvote it — while a window cut off at the header still declares.
    it("keeps a window holding a multiline signature and the braced body it opens", async () => {
      const repo = writeRepo({
        "src/execute.ts": [
          "export function execute(",
          "  job: Job,",
          "  repo: string,",
          "  logger: Logger,",
          "  signal: AbortSignal,",
          ") {",
          "  return run(job, repo, logger, signal);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        // The whole function — five signature lines, the statement they wrap, and the closing brace.
        clone([["src/execute.ts", 1]], 8),
        // The header alone: the body lives below the window, so nothing in it computes.
        clone([["src/execute.ts", 1]], 6),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ Title: expect.stringContaining("8 lines") }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/execute.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("6 signature");
    });

    // The `=>` a closing line carries may belong to its RETURN TYPE, where nothing runs. Reading it
    // as an expression body would count the line as code and keep a signal over a bare signature.
    it("reads a return type carrying `=>` as a signature, not as an expression body", async () => {
      const repo = writeRepo({
        "src/handler.ts": [
          "export function handler(",
          "  items: string[],",
          "): (item: string) => void {",
          "  return () => {};",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/handler.ts", 2]], 2),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped[0].reason).toContain("2 signature");
    });

    // A closing line may open AND close the body on the spot — `) { return execute(); }`. That body
    // runs, so the line is code; an object RETURN TYPE brace on the same line still opens nothing.
    it("counts an inline body on the closing parameter line as code, past a return type brace", async () => {
      const repo = writeRepo({
        "src/inline.ts": [
          "export function inline(",
          "  left: number,",
          "  right: number,",
          ") { return left + right; }",
          "",
        ].join("\n"),
        "src/typed.ts": [
          "export function typed(",
          "  left: number,",
          "  right: number,",
          "): { ok: boolean } {",
          "  return { ok: true };",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/inline.ts", 3]], 2),
        clone([["src/typed.ts", 3]], 2),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/inline.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/typed.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("2 signature");
    });

    // The body an inline closing line opens can hold braces of its own — `) { return {}; }`. Reading
    // the LAST brace as the body's would measure the object literal instead, and file a return that
    // runs on every call as a parameter list.
    it("counts an inline body whose return builds an object as code", async () => {
      const repo = writeRepo({
        "src/empty.ts": [
          "export function empty(",
          "  left: number,",
          "  right: number,",
          ") { return {}; }",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/empty.ts", 3]], 2),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/empty.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A brace inside a TRAILING block comment is not nesting. Counting it would leave the import
    // open over everything below, filing the file's real statements as specifier lines.
    it("closes an import whose line ends in a block comment holding a brace", async () => {
      const repo = writeRepo({
        "src/trailing.ts": [
          'import { join } from "node:path"; /* keep { aligned */',
          "export function boot(root: string) {",
          "  return join(root, 'anton');",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/trailing.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/trailing.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // An import that binds nothing is there for its side effect: it registers, patches, polyfills.
    // A window of those repeats real load-time work, so it is not filed with the specifier lists.
    it("keeps a window of side-effect imports and still drops one of bound specifiers", async () => {
      const repo = writeRepo({
        "src/register.ts": [
          'import "./register-plugin";',
          'import "./polyfill";',
          'import "./telemetry";',
          "export const ready = true;",
          "",
        ].join("\n"),
        "src/bound.ts": [
          'import { parseBdVersion } from "./bd-bin";',
          'import { resolveBdBin } from "./bd-bin";',
          'import { preflightBd } from "./bd-bin";',
          "export const used = [parseBdVersion, resolveBdBin, preflightBd];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/register.ts", 1]], 3),
        clone([["src/bound.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/register.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/bound.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // Naming the side effect is how the idiom is usually written — the comment is the only thing
    // that says WHAT the module installs. It must not turn the line back into a specifier list.
    it("keeps side-effect imports that carry a trailing comment", async () => {
      const repo = writeRepo({
        "src/register.ts": [
          'import "./register-plugin"; // install hooks',
          'import "./polyfill"; /* patch fetch */',
          'import "./telemetry"; // start the reporter',
          "export const ready = true;",
          "",
        ].join("\n"),
        "src/bound.ts": [
          'import { parseBdVersion } from "./bd-bin"; // version',
          'import { resolveBdBin } from "./bd-bin"; // path',
          'import { preflightBd } from "./bd-bin"; // guard',
          "export const used = [parseBdVersion, resolveBdBin, preflightBd];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/register.ts", 1]], 3),
        clone([["src/bound.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/register.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/bound.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // An import-attributes clause tells the loader how to parse the module; it binds nothing, so the
    // statement still runs on load. Reading `with { … }` as a specifier list would file duplicated
    // setup with the declarations and delete it.
    it("keeps side-effect imports that carry an attributes clause", async () => {
      const repo = writeRepo({
        "src/register.ts": [
          'import "./schema.json" with { type: "json" };',
          'import "./locale.json" with { type: "json" };',
          'import "./limits.json" assert { type: "json" };',
          "export const ready = true;",
          "",
        ].join("\n"),
        "src/bound.ts": [
          'import schema from "./schema.json" with { type: "json" };',
          'import locale from "./locale.json" with { type: "json" };',
          'import limits from "./limits.json" with { type: "json" };',
          "export const used = [schema, locale, limits];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/register.ts", 1]], 3),
        clone([["src/bound.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/register.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/bound.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // The attributes clause may be wrapped over several lines. The module is still fetched and
    // evaluated, so the whole statement runs — reading its continuation lines as a specifier list
    // would drop a duplicated runtime load.
    it("keeps a side-effect import whose attributes clause is wrapped over lines", async () => {
      const repo = writeRepo({
        "src/register.ts": [
          'import "./schema.json" with {',
          '  type: "json"',
          "};",
          'import "./locale.json" with {',
          '  type: "json"',
          "};",
          "export const ready = true;",
          "",
        ].join("\n"),
        "src/bound.ts": [
          'import schema from "./schema.json" with {',
          '  type: "json"',
          "};",
          'import locale from "./locale.json" with {',
          '  type: "json"',
          "};",
          "export const used = [schema, locale];",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/register.ts", 1]], 3),
        clone([["src/bound.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/register.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/bound.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // Go spells the side-effect import `_ "pkg"` — the blank name exists to run the package's
    // `init()` and bind nothing. Both spellings of it register drivers on load, so a repeated window
    // of them is duplicated setup; only the list that actually binds names is a declaration.
    it("keeps Go blank imports, single-line and grouped, and still drops a bound import list", async () => {
      const repo = writeRepo({
        "src/blank.go": [
          "package main",
          'import _ "github.com/lib/pq"',
          'import _ "net/http/pprof"',
          'import _ "gocloud.dev/blob/s3blob"',
          "",
        ].join("\n"),
        "src/grouped.go": [
          "import (",
          '\t_ "github.com/lib/pq"',
          '\t_ "net/http/pprof"',
          '\t_ "gocloud.dev/blob/s3blob"',
          ")",
          "",
        ].join("\n"),
        "src/bound.go": [
          "import (",
          '\t"fmt"',
          '\t"net/http"',
          '\t"os"',
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/blank.go", 2]], 3),
        clone([["src/grouped.go", 2]], 3),
        clone([["src/bound.go", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/blank.go", "src/grouped.go"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/bound.go" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // Python's commonest import spelling is `from package import name`, and the parenthesized list
    // repeats across modules exactly as a TS specifier list does. Read as executable code, every one
    // of those windows reaches triage.
    it("reads Python from-imports as declarations, single-line and parenthesized", async () => {
      const repo = writeRepo({
        "src/single.py": [
          "from os.path import join",
          "from typing import Optional",
          "from . import sibling",
          "",
        ].join("\n"),
        "src/grouped.py": [
          "from package.module import (",
          "    parse_bd_version,",
          "    preflight_bd,",
          "    resolve_bd_bin,",
          ")",
          "",
        ].join("\n"),
        "src/work.py": ["total = compute(rows)", "report(total)", "flush(report)", ""].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/single.py", 1]], 3),
        clone([["src/grouped.py", 1]], 5),
        clone([["src/work.py", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/work.py" }]);
      expect(result.duplication.dropped.map((d) => d.path)).toEqual([
        "src/single.py",
        "src/grouped.py",
      ]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
      expect(result.duplication.dropped[1].reason).toContain("5 import");
    });

    // Python's other way of wrapping an import opens no bracket at all: a trailing `\` joins the
    // next line explicitly. Ended at the join, the names below it read as executable code and a
    // repeated specifier list reaches triage.
    it("continues a Python import across an explicit line join", async () => {
      const repo = writeRepo({
        "src/joined.py": [
          "from package.module import first, \\",
          "    second, \\",
          "    third",
          "",
        ].join("\n"),
        "src/work.py": ["total = compute(rows)", "report(total)", "flush(report)", ""].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/joined.py", 1]], 3),
        clone([["src/work.py", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/work.py" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/joined.py" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A Python docstring is prose with no comment marker on its lines, and it routinely quotes
    // example code. Untracked, an example `from package import (` opens import state that no real
    // `)` closes, and every executable window below it in the file is dropped as a specifier list.
    it("tracks a Python docstring so an import example inside it cannot swallow the code below", async () => {
      const repo = writeRepo({
        "src/docstring.py": [
          "def load(rows):",
          '    """Load rows.',
          "",
          "    Example:",
          "        from package.module import (",
          '    """',
          "    total = compute(rows)",
          "    report(total)",
          "    flush(report)",
          "",
        ].join("\n"),
        "src/grouped.py": [
          "from package.module import (",
          "    parse_bd_version,",
          "    preflight_bd,",
          "    resolve_bd_bin,",
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/docstring.py", 7]], 3),
        clone([["src/grouped.py", 1]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the real specifier list beside it is still dropped, so the survivor is the
      // docstring state rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/docstring.py" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/grouped.py" }]);
      expect(result.duplication.dropped[0].reason).toContain("5 import");
    });

    // A stub is Python with its bodies removed: `#` cuts a line there exactly as it does in the
    // module it describes. Read as code, a window of repeated stub notes keeps its signal and
    // reaches triage — the very thing this filter exists to stop.
    it("reads a `#` in a Python stub as the comment it is", async () => {
      const repo = writeRepo({
        "src/types.pyi": [
          "# the row shape the loader hands back, restated for callers",
          "# who only ever see the stub and never the module beside it",
          "# and who need the field order spelled out to read it at all",
          "def load(rows: list[str]) -> int: ...",
          "",
        ].join("\n"),
        "src/work.py": ["total = compute(rows)", "report(total)", "flush(report)", ""].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/types.pyi", 1]], 3),
        clone([["src/work.py", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the executable window beside it survives, so the drop is the comment rule
      // rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/work.py" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/types.pyi" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 comment");
    });

    // A `#` note trails code as readily as it leads a line, and its prose is not syntax. Counted,
    // the `{` inside `)  # keep { documented` cancels the paren that ends the import, so the state
    // never closes and every executable window below it is dropped as a specifier list.
    it("cuts a trailing hash note so an unmatched delimiter in it cannot hold an import open", async () => {
      const repo = writeRepo({
        "src/inline.py": [
          "from package.module import (",
          "    parse_bd_version,",
          ")  # keep { documented",
          "total = compute(rows)",
          "report(total)",
          "flush(report)",
          "",
        ].join("\n"),
        "src/grouped.py": [
          "from package.module import (",
          "    parse_bd_version,",
          "    preflight_bd,",
          "    resolve_bd_bin,",
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/inline.py", 4]], 3),
        clone([["src/grouped.py", 1]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the real specifier list beside it is still dropped, so the survivor is the
      // note being cut rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/inline.py" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/grouped.py" }]);
      expect(result.duplication.dropped[0].reason).toContain("5 import");
    });

    // Python starts a comment at any unquoted `#`, spaced or not — `)#{ unmatched brace`. Demanding
    // a gap leaves the `{` inside the prose to cancel the paren that ends the import, so the state
    // never closes and every executable window below it is dropped as a specifier list.
    it("cuts a hash note that follows code with no space in a language that needs none", async () => {
      const repo = writeRepo({
        "src/tight.py": [
          "from package.module import (",
          "    parse_bd_version,",
          ")#{ unmatched brace",
          "total = compute(rows)",
          "report(total)",
          "flush(report)",
          "",
        ].join("\n"),
        "src/grouped.py": [
          "from package.module import (",
          "    parse_bd_version,",
          "    preflight_bd,",
          "    resolve_bd_bin,",
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/tight.py", 4]], 3),
        clone([["src/grouped.py", 1]], 5),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the real specifier list beside it is still dropped, so the survivor is the
      // note being cut rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/tight.py" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/grouped.py" }]);
      expect(result.duplication.dropped[0].reason).toContain("5 import");
    });

    // A block comment can open AFTER code — `value: string, /* why`. Left unread, the prose below it
    // counts as syntax: its unmatched `(` holds the parameter list open past the real `)` and files
    // every call in the body as more parameter list.
    it("tracks a block comment that opens after code so the body below it stays executable", async () => {
      const repo = writeRepo({
        "src/mid-comment.ts": [
          "export function render(",
          "  value: string, /* the label, as resolve(theme",
          "   * may hand back a raw ( of its own",
          "   */",
          "  size: number,",
          ") {",
          "  emit(value, size);",
          "  flush(value);",
          "  report(size);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/mid-comment.ts", 7]], 3),
        clone([["src/mid-comment.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // The body survives; the parameter-and-prose window above it is still read as a declaration.
      expect(result.signals).toMatchObject([{ FilePath: "src/mid-comment.ts", Line: 7 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/mid-comment.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("2 comment");
    });

    // A file rewritten SHORTER leaves a remnant where the block used to start. Reading the few lines
    // that survive would let two truncated comment tails outvote the one location that still holds
    // the clone — so a window the tree cannot serve in full does not vote at all.
    it("ignores a window that runs off the end of a file rather than voting on the remnant", async () => {
      const repo = writeRepo({
        "src/live.ts": [
          "export function arrange(sandbox: string) {",
          "  const repo = join(sandbox, 'repo');",
          "  mkdirSync(repo);",
          "  execFileSync('git', ['init', '-q', repo]);",
          "  writeFileSync(join(repo, 'README.md'), '# sandbox');",
          "  return repo;",
          "}",
          "",
        ].join("\n"),
        "src/remnant-a.ts": ["// what is left of the block", "// after the rewrite", ""].join("\n"),
        "src/remnant-b.ts": ["// what is left of the block", "// after the rewrite", ""].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone(
          [
            ["src/live.ts", 1],
            ["src/remnant-a.ts", 1],
            ["src/remnant-b.ts", 1],
          ],
          6,
        ),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/live.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A remnant one line SHORT of the window is still a remnant. A file's terminal newline is not a
    // further line, so counting the empty element `split` hands back for it would let two such
    // comment tails vote as full blocks and outvote the location that still holds the clone.
    it("ignores a remnant one line short of the window despite the file's terminal newline", async () => {
      const repo = writeRepo({
        "src/live.ts": [
          "export function arrange(sandbox: string) {",
          "  mkdirSync(join(sandbox, 'repo'));",
          "  execFileSync('git', ['init', '-q', sandbox]);",
          "  writeFileSync(join(sandbox, 'README.md'), '# sandbox');",
          "  return sandbox;",
          "}",
          "",
        ].join("\n"),
        "src/remnant-a.ts": ["// what is left of the block", "// after the rewrite", ""].join("\n"),
        "src/remnant-b.ts": ["// what is left of the block", "// after the rewrite", ""].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone(
          [
            ["src/live.ts", 2],
            ["src/remnant-a.ts", 1],
            ["src/remnant-b.ts", 1],
          ],
          3,
        ),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/live.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A file emptied out holds no lines at all — the empty element `split` hands back for a source
    // with no newline in it is not a line. Counted, two locations in emptied files vote as readable
    // blank blocks and outvote the one that still holds the clone.
    it("treats a location in an emptied file as gone rather than as a blank block", async () => {
      const repo = writeRepo({
        "src/kept.ts": ["export const rate = compute(hits) / span;", ""].join("\n"),
        "src/emptied-a.ts": "",
        "src/emptied-b.ts": "",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone(
          [
            ["src/kept.ts", 1],
            ["src/emptied-a.ts", 1],
            ["src/emptied-b.ts", 1],
          ],
          1,
        ),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/kept.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `/[/*]/` carries the two characters of a comment opener inside a character class. Read as one,
    // it runs a comment over every line below it and the executable clone under it is dropped unread.
    it("steps over a regex literal whose character class holds a comment opener", async () => {
      const repo = writeRepo({
        "src/regex.ts": [
          "export const separator = /[/*]/;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/regex.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/regex.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A slash after an expression keyword can only OPEN a regex — `throw /[/*]/` throws one. Read as
    // division, its `/*` opens a comment that runs to the end of the file and every real duplication
    // window below it is dropped unread.
    it("reads a slash after an expression keyword as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/guard.ts": [
          "export function guard(value: string) {",
          "  if (!value) throw /[/*]/;",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/guard.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/guard.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A default export leads an expression too — `export default /[/*]/;` exports a regex. Read as
    // division, the `/*` inside the character class opens a comment that runs to the end of the file
    // and every real duplication window below it is dropped unread.
    it("reads a slash after a default export as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/separator.ts": [
          "export default /[/*]/;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/separator.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/separator.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // An arithmetic operator leads an expression too — `prefix + /[/*]/.source` concatenates a
    // regex source. Read as division, the `/*` inside the character class opens a comment that runs
    // to the end of the file and every real duplication window below it is dropped unread.
    it("reads a slash after an arithmetic operator as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/marker.ts": [
          'export const marker = prefix + /[/*]/.source + "tail";',
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/marker.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/marker.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A divisor is an expression too — `total / /[/*]/.source.length` divides by a regex's source
    // length. Read as division all the way through, the `/*` inside the character class opens a
    // comment that runs to the end of the file and every real duplication window below it is
    // dropped unread.
    it("reads a slash after a division operator as a regex, not as another division", async () => {
      const repo = writeRepo({
        "src/length.ts": [
          "export const parts = total / /[/*]/.source.length;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/length.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/length.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Bitwise-not leads an expression too — `~/[/*]/.test(input)` coerces a match to a number. Read
    // as division, the `/*` inside the character class opens a comment that runs to the end of the
    // file and every real duplication window below it is dropped unread.
    it("reads a slash after a bitwise-not as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/coerce.ts": [
          "export const marker = ~/[/*]/.test(input);",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/coerce.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/coerce.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A comparison leads an expression too — `value < /[/*]/.source` compares against a regex's
    // source. Read as a comparison all the way through, the `/*` inside the character class opens a
    // comment that runs to the end of the file and every real duplication window below it is
    // dropped unread.
    it("reads a slash after a comparison operator as a regex, not as a closing tag", async () => {
      const repo = writeRepo({
        "src/gate.ts": [
          "export const gated = value < /[/*]/.source;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/gate.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/gate.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The same comparison written TIGHT — `value</[/*]/.source` — is still a comparison in a file
    // that cannot hold JSX: a `.ts` has no closing tag to confuse it with. Refused as a regex
    // opener, the `/*` inside the character class opens a comment that runs to the end of the file
    // and every real duplication window below it is dropped unread.
    it("reads a tight comparison before a regex outside a JSX language", async () => {
      const repo = writeRepo({
        "src/tight.ts": [
          "export const gated = value</[/*]/.source;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/tight.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/tight.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The `)` that closes a control-flow head hands to a STATEMENT, not to a value — `if (enabled)
    // /[/*]/.test(value);` runs a regex test as its body. Read as division, the `/*` inside the
    // character class opens a comment that runs to the end of the file and every real duplication
    // window below it is dropped unread.
    it("reads a slash after a control-flow head as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/enabled.ts": [
          "export function check(enabled: boolean, value: string) {",
          "  if (enabled) /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/enabled.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/enabled.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `with` heads a clause the same way — sloppy-mode scripts still carry it, and
    // `with (obj) /[/*]/.test(value);` runs a regex test as its body. Read as division, the `/*`
    // inside that character class opens a comment that runs to the end of the file and every real
    // duplication window below it is dropped unread.
    it("reads a slash after a with head as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/sloppy.js": [
          "function check(obj, value) {",
          "  with (obj) /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/sloppy.js", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/sloppy.js", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The member of the same name is not that head: `array.with(0, seed)` yields a VALUE, so the
    // slash behind its `)` divides. Read as a head, the invented literal runs to the divisor's own
    // slash and the `/*` inside its character class comments out every line below.
    it("reads a slash after an Array#with call as division, not as a regex", async () => {
      const repo = writeRepo({
        "src/ratio.ts": [
          "export function ratio(items: number[], seed: number, limit: number) {",
          "  const rate = items.with(0, seed) / /[/*]/.source.length;",
          "  emit(rate);",
          "  flush(rate);",
          "  report(rate);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/ratio.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A `}` closes the block before it and a fresh STATEMENT begins — `if (enabled) {}
    // /[/*]/.test(value);` tests a regex. Read as division, the `/*` inside the character class opens
    // a comment that runs to the end of the file and every real duplication window below it is
    // dropped unread.
    it("reads a slash after a closed block as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/guarded.ts": [
          "export function check(enabled: boolean, value: string) {",
          "  if (enabled) {} /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/guarded.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/guarded.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // An object literal's `}` ends a VALUE, so the slash behind it divides — `{ value: 1 } /
    // /[/*]/.source.length` divides by a regex's source length. Read as a statement boundary, the
    // invented literal runs to the divisor's own slash and the `/*` inside its character class opens
    // a comment that runs to the end of the file, dropping every window below it unread.
    it("reads a slash after an object literal as division, not as a regex", async () => {
      const repo = writeRepo({
        "src/ratio.ts": [
          "export const ratio = { value: 1 } / /[/*]/.source.length;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/ratio.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The same object literal written over lines: its `{` is not on the line its `}` ends, so the
    // brace kinds the lines above opened are what say the `}` closed a VALUE. Read as a block, the
    // slash behind it opens an invented literal that runs to the divisor's own slash, and the `/*`
    // inside that character class comments out every line below.
    it("reads a slash after a multiline object literal as division, not as a regex", async () => {
      const repo = writeRepo({
        "src/ratio.ts": [
          "export const ratio = {",
          "  value: 1,",
          "} / /[/*]/.source.length;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.ts", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/ratio.ts", Line: 5 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // And the other side of the same rule: a BLOCK opened lines above still hands to a statement, so
    // the slash behind its `}` opens a regex. Reading every earlier-line `}` as a literal's would
    // leave the `/*` in this character class to open a comment over the rest of the file.
    it("reads a slash after a multiline block as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/guarded.ts": [
          "export function check(enabled: boolean, value: string) {",
          "  if (enabled) {",
          "    log(value);",
          "  } /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/guarded.ts", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/guarded.ts", Line: 5 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A LABEL's `:` is an expression prefix by spelling and a statement boundary in fact, so
    // `outer: {` opens a block. Recorded as an object literal, its `}` ends a value, the slash
    // behind it reads as division, and the `/*` in the character class beside it comments out every
    // line below.
    it("reads a slash after a labeled block as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/labeled.ts": [
          "export function check(enabled: boolean, value: string) {",
          "  outer: {",
          "    if (enabled) break outer;",
          "    log(value);",
          "  } /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/labeled.ts", 6]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/labeled.ts", Line: 6 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The other side of that rule: inside an object literal the same `key: {` is a PROPERTY whose
    // value is another literal, so the slash behind its `}` still divides. Read as a labeled block,
    // the invented literal runs to the divisor's own slash and its `/*` comments out the rest.
    it("reads a slash after a nested property literal as division, not as a regex", async () => {
      const repo = writeRepo({
        "src/config.ts": [
          "export const config = {",
          "  handler: {",
          "    value: 1,",
          "  } / /[/*]/.source.length,",
          "};",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/config.ts", 7]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/config.ts", Line: 7 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `...` can only be followed by an expression — `[.../[/*]/.source]` spreads a regex's source.
    // Read as the property-access dot it shares two characters with, the slash divides, and the `/*`
    // inside that character class opens a comment over every line below.
    it("reads a slash after spread syntax as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/spread.ts": [
          "export const chars = [.../[/*]/.source];",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/spread.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/spread.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `else` leads a STATEMENT, so the `{` behind it opens a block and the `}` that closes it is a
    // boundary: `} else { … } /[/*]/.test(value);` tests a regex. Recorded as an object literal, the
    // slash reads as division and the `/*` beside it comments out every line below.
    it("reads a slash after an else block as a regex, not as division", async () => {
      const repo = writeRepo({
        "src/branch.ts": [
          "export function check(enabled: boolean, value: string) {",
          "  if (enabled) { log(value); } else { warn(value); } /[/*]/.test(value);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/branch.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/branch.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `do {` opens a block by the same rule, and the kind it records is what the lines inside it
    // inherit: read as an object literal, the labeled block nested in the loop body is read as a
    // property, the `}` closing it stops being a boundary, and the `/*` in the class beside that
    // brace comments out the rest of the file.
    it("reads a do block as a block, so a slash after a label inside it opens a regex", async () => {
      const repo = writeRepo({
        "src/loop.ts": [
          "export function check(value: string, times: number) {",
          "  let index = times;",
          "  do {",
          "    outer: {",
          "      log(value);",
          "    } /[/*]/.test(value);",
          "    index -= 1;",
          "  } while (index > 0);",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/loop.ts", 9]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/loop.ts", Line: 9 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A brace written inside a STRING is text, not nesting. Counted, the scan behind `{ close: "}" }`
    // never balances, the object literal's `}` reads as a block's, and the divisor's slash opens an
    // invented literal that runs into the trailing note — leaving its `/*` to open a comment that
    // swallows every line below.
    it("does not count a brace inside a string when telling a literal from a block", async () => {
      const repo = writeRepo({
        "src/ratio.ts": [
          'export const ratio = { close: "}" } / total; // splits on /[/*]/ groups',
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/ratio.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // The one `}` a slash follows without a statement starting is JSX's self-close. Read as a regex
    // opener, the invented literal runs to the next slash on the line — the `{/*` of the comment
    // beside it — and the prose below is then classified as runtime work and triaged as a clone.
    it("reads a slash after a self-closing JSX tag as the tag, not as a regex", async () => {
      const repo = writeRepo({
        "src/panel.tsx": [
          "export function Panel({ size }: { size: number }) {",
          "  return (",
          "    <div>",
          "      <Icon size={size} /> {/* the note below is prose:",
          "      it explains what the icon means, at length,",
          "      over lines that hold no runtime work at all,",
          "      and none of it is worth extracting anywhere,",
          "      here or in the component beside it */}",
          "    </div>",
          "  );",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/panel.tsx", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped).toMatchObject([
        { path: "src/panel.tsx", kind: "code-clone" },
      ]);
      expect(result.duplication.dropped[0].reason).toContain("3 comment");
    });

    // `hits++ / span` divides — the trailing `+` is a postfix operator that yields a value, not one
    // that leads an expression. Read as a regex opener, the invented literal runs to the next slash
    // and eats the `)` between them, leaving the parenthesized expression open over the live code
    // below it — every line of which then reads as a parameter list and is dropped.
    it("reads a slash after a postfix increment as division, not as a regex", async () => {
      const repo = writeRepo({
        "src/ratio.ts": [
          "export function ratio(hits: number, span: number, limit: number) {",
          "  const rate = (hits++ / span) / limit;",
          "  emit(rate);",
          "  flush(rate);",
          "  report(rate);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/ratio.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `const x = (` opens a parameter list or a parenthesized expression, and only the closing line
    // says which: a `=>` cannot be pushed past it. Without that check a window of calls reads as a
    // props list and a real duplicate of runtime work is thrown away unread.
    it("reads a parenthesized expression as code and a wrapped parameter list as a signature", async () => {
      const repo = writeRepo({
        "src/result.ts": [
          "export const result = (",
          "  computeAlpha(),",
          "  computeBeta(),",
          "  computeGamma()",
          ");",
          "",
        ].join("\n"),
        "src/render.ts": [
          "export const render = (",
          "  title: string,",
          "  body: string,",
          "  footer: string,",
          ") => title;",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/result.ts", 2]], 3),
        clone([["src/render.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/result.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/render.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // The `)` that ends a parameter list ends it whatever the body opens next: `) => combine(` is
    // net-zero on parens, and reading closure off that net depth would leave the runtime calls
    // under it inheriting `signature` — dropping a clone of live work.
    it("ends the parameter list at its closing paren even when the body opens a call", async () => {
      const repo = writeRepo({
        "src/total.ts": [
          "export const total = (",
          "  seed: number,",
          ") => combine(",
          "  computeAlpha(seed),",
          "  computeBeta(seed),",
          "  computeGamma(seed),",
          ");",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/total.ts", 4]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/total.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Only the arrow the parameter list HANDS TO declares. One inside an asserted function type —
    // `) as (value: string) => string` — belongs to the type, and mistaking it for a declaration
    // would file the calls it wraps as a parameter list.
    it("reads an arrow inside a type assertion as the type's, not as a declaration", async () => {
      const repo = writeRepo({
        "src/assert.ts": [
          "export const label = (",
          "  computeAlpha(),",
          "  computeBeta(),",
          "  computeGamma()",
          ") as (value: string) => string;",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/assert.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/assert.ts" }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A regex literal is not syntax: an unmatched `(` inside one would hold the parameter list open
    // past its real `)`, and every statement below it would read as more parameter list — dropping
    // a genuine clone. Division is left alone, so `a / b(c) / d` keeps the parens it spans.
    it("does not count the delimiters inside a regex literal as syntax", async () => {
      const repo = writeRepo({
        "src/match.ts": [
          "export function match(",
          "  input: string,",
          "  pattern = /\\(/,",
          ") {",
          "  doAlpha(input);",
          "  doBeta(input);",
          "  doGamma(input);",
          "}",
          "",
        ].join("\n"),
        "src/ratio.ts": [
          "export function ratio(",
          "  numerator: number,",
          "  denominator: number,",
          ") {",
          "  return numerator / scale(denominator) / 2;",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/match.ts", 5]], 3),
        clone([["src/ratio.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // The statements below the regex default are code, so their clone survives...
      expect(result.signals).toMatchObject([{ FilePath: "src/match.ts" }]);
      // ...while the parameter list above them still reads as one, division and all.
      expect(result.duplication.dropped).toMatchObject([{ path: "src/ratio.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // A character class carries escapes of its own — `/[\(]/` matches a literal paren. Refused, the
    // whole literal goes unrecognized and the `(` inside it is counted as syntax: the parameter list
    // never closes on its real `)` and every statement below it reads as more parameter list.
    it("does not count the delimiters escaped inside a regex character class as syntax", async () => {
      const repo = writeRepo({
        "src/classed.ts": [
          "export function match(",
          "  input: string,",
          "  pattern = /[\\(]/,",
          ") {",
          "  doAlpha(input);",
          "  doBeta(input);",
          "  doGamma(input);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/classed.ts", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/classed.ts", Line: 5 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // A template literal that runs past its line is raw text, and a `(` in that text is not syntax.
    // Counting it would hold the parameter list open past its real `)` — filing every statement
    // below the signature as more parameter list and dropping a clone of live work.
    it("does not count the delimiters inside a multiline template literal as syntax", async () => {
      const repo = writeRepo({
        "src/banner.ts": [
          "export function banner(",
          "  input: string,",
          "  prefix = `raw (",
          "  more raw text`,",
          ") {",
          "  doAlpha(input);",
          "  doBeta(input);",
          "  doGamma(input);",
          "}",
          "",
        ].join("\n"),
        "src/label.ts": [
          "export function label(",
          "  prefix = `raw (",
          "  more raw text`,",
          "  suffix: string,",
          "  trailer: string,",
          ") {",
          "  return join(prefix, suffix, trailer);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/banner.ts", 6]], 3),
        clone([["src/label.ts", 4]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // The statements below the template default are code, so their clone survives...
      expect(result.signals).toMatchObject([{ FilePath: "src/banner.ts" }]);
      // ...while the parameter list holding the template still reads as one.
      expect(result.duplication.dropped).toMatchObject([{ path: "src/label.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // A template's interpolation can hold another template. Read pairwise, the nested opener closes
    // the outer literal and its raw `(` reaches the paren counter as syntax — the parameter list
    // never closes on its real `)`, and every statement below it reads as more parameter list.
    it("closes a template on its own backtick, not on one nested in its interpolation", async () => {
      const repo = writeRepo({
        "src/nested.ts": [
          "export function nested(",
          "  input: string,",
          "  label = `outer ${`inner (`} tail`,",
          ") {",
          "  doAlpha(input);",
          "  doBeta(input);",
          "  doGamma(input);",
          "}",
          "",
        ].join("\n"),
        "src/wrapped.ts": [
          "export function wrapped(",
          "  label = `outer ${`inner (`} tail`,",
          "  suffix: string,",
          "  trailer: string,",
          "  extra: string,",
          ") {",
          "  return join(label, suffix, trailer, extra);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/nested.ts", 5]], 3),
        clone([["src/wrapped.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // The statements below the nested template are code, so their clone survives...
      expect(result.signals).toMatchObject([{ FilePath: "src/nested.ts" }]);
      // ...while the parameter list holding it still reads as one.
      expect(result.duplication.dropped).toMatchObject([{ path: "src/wrapped.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // The comment scanner steps over a template through the same nesting: paired backtick to
    // backtick, a nested literal's opener closes the outer one and the scan resumes inside the
    // nested TEXT — where the `/*` of `` `src/${`**/*.ts`}` `` reads as a comment opener that runs
    // to the end of the file, dropping every executable window below a balanced one-liner.
    it("closes a template on its own backtick when scanning for a comment opener", async () => {
      const repo = writeRepo({
        "src/glob.ts": [
          "export const glob = `src/${`**/*.ts`}`;",
          "export function split(value: string) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/glob.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/glob.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Go spells an import path with a raw string just as readily as with a quoted one, and a blank
    // import written that way exists for the same reason: to run the package's `init()`. Reading
    // the raw-string spelling as a specifier list drops a window of executable registrations.
    it("keeps Go blank imports written as raw strings, single-line and grouped", async () => {
      const repo = writeRepo({
        "src/raw.go": [
          "package main",
          "import _ `github.com/lib/pq`",
          "import _ `net/http/pprof`",
          "import _ `gocloud.dev/blob/s3blob`",
          "",
        ].join("\n"),
        "src/rawgroup.go": [
          "import (",
          "\t_ `github.com/lib/pq`",
          "\t_ `net/http/pprof`",
          "\t_ `gocloud.dev/blob/s3blob`",
          ")",
          "",
        ].join("\n"),
        "src/rawbound.go": [
          "import (",
          "\t`fmt`",
          "\t`net/http`",
          "\t`os`",
          ")",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/raw.go", 2]], 3),
        clone([["src/rawgroup.go", 2]], 3),
        clone([["src/rawbound.go", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/raw.go", "src/rawgroup.go"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/rawbound.go" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // Go's bare `import "fmt"` BINDS `fmt` — the blank name is what makes an import a side effect
    // there. Reading the bare form as one keeps a duplicated window of ordinary single-line imports
    // as executable setup, where the grouped spelling of the same imports is already filtered.
    it("reads single-line Go imports without the blank alias as bound declarations", async () => {
      const repo = writeRepo({
        "src/single-bound.go": [
          "package main",
          'import "fmt"',
          'import "net/http"',
          'import "os"',
          "",
        ].join("\n"),
        "src/single-blank.go": [
          "package main",
          'import _ "github.com/lib/pq"',
          'import _ "net/http/pprof"',
          'import _ "gocloud.dev/blob/s3blob"',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/single-bound.go", 2]], 3),
        clone([["src/single-blank.go", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/single-blank.go"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/single-bound.go" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // `//` marks a comment only where the language says so. Python spells floor division `//`, so a
    // wrapped expression leads two computing lines with one — read as prose they outvote the line
    // above and a genuine clone of arithmetic is dropped as non-code.
    it("reads a leading `//` as floor division in a hash-comment language", async () => {
      const repo = writeRepo({
        "src/ratio.py": [
          "def ratio(total, divisor, scale):",
          "    return (",
          "        total",
          "        // divisor",
          "        // scale",
          "    )",
          "",
        ].join("\n"),
        "src/notes.ts": [
          "export const ready = true;",
          "// the reporter starts here",
          "// and stops on the next tick",
          "// which is what this note is for",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.py", 3]], 3),
        clone([["src/notes.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/ratio.py"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/notes.ts" }]);
    });

    // Hash comments are not what makes `//` prose: Lua has neither, and spells floor division the
    // way Python does. Derived from the absence of `#`, the marker reads as a comment there and a
    // genuine clone of wrapped arithmetic is dropped as a block of notes.
    it("reads a leading `//` as floor division in a language with no comment rule for it", async () => {
      const repo = writeRepo({
        "src/ratio.lua": [
          "local function ratio(total, divisor, scale)",
          "  return (",
          "    total",
          "    // divisor",
          "    // scale",
          "  )",
          "end",
          "",
        ].join("\n"),
        "src/notes.ts": [
          "export const ready = true;",
          "// the reporter starts here",
          "// and stops on the next tick",
          "// which is what this note is for",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/ratio.lua", 3]], 3),
        clone([["src/notes.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/ratio.lua"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/notes.ts" }]);
    });

    // `function` heads a declaration only where the language says so. In Python it is an ordinary
    // identifier, so a multiline CALL through it opens a parameter list that no `)` closes for it,
    // and every line of live work through the real closer is dropped as a signature.
    it("reads a leading `function(` as a call in a language that declares no function keyword", async () => {
      const repo = writeRepo({
        "src/dispatch.py": [
          "function = registry.lookup(name)",
          "function(",
          "    collect(rows),",
          "    summarize(rows),",
          "    flush(rows),",
          ")",
          "",
        ].join("\n"),
        "src/header.ts": [
          "export function header(",
          "  prefix: string,",
          "  suffix: string,",
          "  trailer: string,",
          ") {",
          "  return join(prefix, suffix, trailer);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/dispatch.py", 2]], 3),
        clone([["src/header.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/dispatch.py"]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/header.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 signature");
    });

    // A backtick opens a template only where one can open. Inside a quoted string or a trailing
    // comment it is text, and reading it as an opener would file every line below it as template
    // text — turning whole parameter lists into code and keeping the windows this filter is for.
    it("reads a backtick inside a string or a comment as text, not as a template opener", async () => {
      const repo = writeRepo({
        "src/quoted.ts": [
          "export function quoted(",
          '  label = "a ` backtick",',
          "  prefix: string,",
          "  suffix: string,",
          ") {",
          "  return join(label, prefix, suffix);",
          "}",
          "",
        ].join("\n"),
        "src/noted.ts": [
          "export function noted(",
          "  prefix: string, // a ` note",
          "  suffix: string,",
          "  trailer: string,",
          ") {",
          "  return join(prefix, suffix, trailer);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/quoted.ts", 3]], 3),
        clone([["src/noted.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped.map((d) => d.path)).toEqual([
        "src/quoted.ts",
        "src/noted.ts",
      ]);
      for (const drop of result.duplication.dropped) {
        expect(drop.reason).toContain("3 signature");
      }
    });

    // A window of nothing but closers is dropped too — but "declares rather than computes" would be
    // the wrong diagnosis to hand an operator, since there is nothing there that declares either.
    it("says a block holds no content line rather than blaming its declarations", async () => {
      const repo = writeRepo({
        "src/panel.tsx": [
          "export function Panel() {",
          "  return (",
          "    <section>",
          "      <Card />",
          "    </section>",
          "  );",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/panel.tsx", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      const [drop] = result.duplication.dropped;
      expect(drop.reason).toContain("holds nothing but blank and structural lines");
      expect(drop.reason).toContain("3 structural");
      expect(drop.reason).not.toContain("declares rather than computes");
    });

    // The composition quoted in the reason is the one the MOST locations share, not whichever
    // happened to be listed first: an operator checking a drop described by its outlier finds
    // something other than what the verdict was reached on.
    it("describes the drop by the composition most of its locations share", async () => {
      const repo = writeRepo({
        "src/notes.ts": [
          "// the section below explains the retry budget,",
          "// why it is spelled in attempts rather than seconds,",
          "// and what happens when a caller exhausts it",
          "",
        ].join("\n"),
        "src/a.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
        "src/b.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone(
          [
            ["src/notes.ts", 1],
            ["src/a.ts", 1],
            ["src/b.ts", 1],
          ],
          3,
        ),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      const [drop] = result.duplication.dropped;
      expect(drop.reason).toContain("3 import");
      expect(drop.reason).not.toContain("3 comment");
    });

    // A block comment that closes mid-line does not make the line prose: what follows the closer
    // runs on every pass, so a window of those lines is duplicated computation triage can act on.
    it("classifies the code that follows a closed block comment on the same line", async () => {
      const repo = writeRepo({
        "src/inline.ts": [
          "export function run(items: number[]) {",
          "  /* warm the cache */ prime(items);",
          "  /* then compute */ total(items);",
          "  /* and flush */ flush(items);",
          "}",
          "",
        ].join("\n"),
        // The same suffix, reached the other way: a comment that spans lines and ends on one.
        "src/tail.ts": [
          "export function run(items: number[]) {",
          "  /* a long",
          "     explanation */ prime(items);",
          "  total(items);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/inline.ts", 2]], 3),
        clone([["src/tail.ts", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals.map((s) => s.FilePath)).toEqual(["src/inline.ts", "src/tail.ts"]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Rust nests its block comments, and commenting out a block that already holds one is how the
    // nesting arises. Closed at the INNER `*/`, the still-commented remainder reads as syntax: the
    // `let load = (` inside it opens a parameter list nothing closes, and every executable line past
    // the real `*/` inherits `signature` and is dropped as a declaration.
    it("closes a nested block comment on the delimiter that matches it, where the language nests", async () => {
      const repo = writeRepo({
        "src/loader.rs": [
          "/* disabled while the loader moves:",
          "/* the old path, kept for reference */",
          "let load = (path,",
          "    mode,",
          "*/",
          "fn split(value: &str) {",
          "    emit(value);",
          "    flush(value);",
          "    report(value);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/loader.rs", 7]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/loader.rs", Line: 7 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Rust's `r#"…"#` holds arbitrary text that no escape can end, and a fixture inside one
    // routinely quotes source. Untracked, an `import (` in that text opens import state that no real
    // `)` closes, and every executable window past the closing `"#` is dropped as a specifier list.
    it("tracks a Rust raw string so a declaration inside it cannot swallow the code below", async () => {
      const repo = writeRepo({
        "src/fixture.rs": [
          "fn load(rows: &[Row]) {",
          "    // the opening fragment of a generated file — its `(` closes in a later chunk",
          '    let header = r#"',
          "import (",
          '    "fmt"',
          '"#;',
          "    let total = compute(rows);",
          "    report(total);",
          "    flush(total);",
          "}",
          "",
        ].join("\n"),
        "src/aliases.rs": [
          "type Rows = Vec<Row>;",
          "type Names = Vec<String>;",
          "type Counts = Vec<usize>;",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/fixture.rs", 7]], 3),
        clone([["src/aliases.rs", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the alias list beside it is still dropped, so the survivor is the raw-string
      // state rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/fixture.rs", Line: 7 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/aliases.rs" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 type");
    });

    // Kotlin, Java, Scala, Swift and Dart all spell a multiline string `"""`, and all five parse
    // imports. Untracked, an `import (` quoted inside one opens import state that no real `)`
    // closes, and every executable window past the closing delimiter is dropped as a specifier list.
    it("tracks a Kotlin multiline string so a declaration inside it cannot swallow the code below", async () => {
      const repo = writeRepo({
        "src/fixture.kt": [
          "fun load(rows: List<Row>) {",
          '    val header = """',
          "import (",
          '    "fmt"',
          '""".trimIndent()',
          "    val total = compute(rows)",
          "    report(total)",
          "    flush(total)",
          "}",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/fixture.kt", 6]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the specifier list beside it is still dropped, so the survivor is the
      // multiline-string state rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/fixture.kt", Line: 6 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A backslash at a line's end carries an ordinary quoted string onto the next line, and a
    // fixture written that way quotes source as readily as a template does. Read line by line, the
    // string's own `import {` opens import state whose unmatched brace holds every executable line
    // past the closing quote as a specifier — and the clone of real work below is dropped unread.
    it("carries a backslash-continued string, so a declaration inside it cannot swallow the code below", async () => {
      const repo = writeRepo({
        "src/fixture.ts": [
          "export function load(rows: Row[]) {",
          "  // the opening fragment of a generated file — its `}` closes in a later chunk",
          '  const header = "example \\',
          "import { readFile, \\",
          'still text";',
          "  const total = compute(rows);",
          "  report(total);",
          "  flush(total);",
          "}",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/fixture.ts", 6]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the specifier list beside it is still dropped, so the survivor is the carried
      // quote rather than a filter that read nothing.
      expect(result.signals).toMatchObject([{ FilePath: "src/fixture.ts", Line: 6 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // An unterminated quote is not a continued one: without the backslash the literal is malformed,
    // and reading the rest of the file as its text would drop every window below it. A hanging
    // apostrophe in a trailing note is the same rule — a comment opens no string at all.
    it("keeps reading code below a hanging quote that no backslash continues", async () => {
      const repo = writeRepo({
        "src/notes.ts": [
          "export function notes(rows: Row[]) {",
          "  const label = tag(rows); // don't drop the rows below",
          "  const total = compute(rows);",
          "  report(total);",
          "  flush(total);",
          "}",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/notes.ts", 3]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/notes.ts", Line: 3 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // Dart nests its block comments as Rust does. Closed at the INNER `*/`, the still-commented
    // `import (` below it opens import state that no real `)` closes, and every executable line past
    // the outer closer inherits it and is dropped as a specifier list.
    it("nests Dart block comments, so a commented import cannot swallow the code below", async () => {
      const repo = writeRepo({
        "lib/loader.dart": [
          "/* disabled while the loader moves:",
          "/* the old path, kept for reference */",
          "import (",
          "*/",
          "void split(String value) {",
          "  emit(value);",
          "  flush(value);",
          "  report(value);",
          "}",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["lib/loader.dart", 6]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "lib/loader.dart", Line: 6 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A shell heredoc's payload is the command's INPUT, and generating source is what one is for.
    // Untracked, a `function fake(` in that payload opens a parameter list no `)` closes, and every
    // command past the terminator inherits `signature` and is dropped as a declaration.
    it("tracks a shell heredoc so a function header in its payload cannot swallow the commands below", async () => {
      const repo = writeRepo({
        "scripts/publish.sh": [
          "#!/usr/bin/env bash",
          "cat <<'EOF' > /tmp/sample.js",
          "function fake(",
          "  value,",
          "EOF",
          "upload /tmp/sample.js",
          "notify team",
          "flush queue",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/publish.sh", 6]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "scripts/publish.sh", Line: 6 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A heredoc delimiter is a shell WORD, not an identifier — `cat <<'END-SQL'` is a valid opener.
    // Read as identifier characters only, the delimiter never parses, the heredoc is never tracked,
    // and the `function fake(` in its payload opens a parameter list that swallows every command
    // past the real terminator.
    it("tracks a heredoc whose quoted delimiter carries punctuation", async () => {
      const repo = writeRepo({
        "scripts/seed.sh": [
          "#!/usr/bin/env bash",
          "cat <<'END-SQL' > /tmp/seed.sql",
          "function fake(",
          "  value,",
          "END-SQL",
          "upload /tmp/seed.sql",
          "notify team",
          "flush queue",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/seed.sh", 6]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "scripts/seed.sh", Line: 6 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A plain `<<EOF` ends only on a line that is EXACTLY its delimiter, so an indented `  EOF` in
    // the payload is payload. Ending the heredoc there hands the generated `function fake(` below it
    // back to the classifiers, and the commands past the real terminator inherit its open parameter
    // list and are dropped as a declaration.
    it("keeps a heredoc open past an indented copy of its terminator", async () => {
      const repo = writeRepo({
        "scripts/render.sh": [
          "#!/usr/bin/env bash",
          "cat <<EOF > /tmp/sample.js",
          "  EOF",
          "function fake(",
          "  value,",
          "EOF",
          "upload /tmp/sample.js",
          "notify team",
          "flush queue",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/render.sh", 7]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "scripts/render.sh", Line: 7 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // Trailing whitespace is part of the terminator comparison exactly as indentation is: `EOF   `
    // under a plain `<<EOF` is payload, not the delimiter. Ended there, the generated `function
    // fake(` below it opens a parameter list no `)` closes, and the commands past the real
    // terminator inherit it and are dropped as a declaration.
    it("keeps a heredoc open past a copy of its terminator carrying trailing spaces", async () => {
      const repo = writeRepo({
        "scripts/emit.sh": [
          "#!/usr/bin/env bash",
          "cat <<EOF > /tmp/sample.js",
          "EOF   ",
          "function fake(",
          "  value,",
          "EOF",
          "upload /tmp/sample.js",
          "notify team",
          "flush queue",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/emit.sh", 7]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "scripts/emit.sh", Line: 7 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // The other half of that rule: `<<-` DOES strip leading tabs, which is what the form is for.
    // Left unstripped, the tab-indented terminator never matches, the heredoc runs to the end of the
    // file, and the prose below it reads as payload — so a duplicated comment block is triaged as a
    // clone instead of being dropped.
    it("ends a `<<-` heredoc on its tab-indented terminator", async () => {
      const repo = writeRepo({
        "scripts/notes.sh": [
          "#!/usr/bin/env bash",
          "cat <<-EOF > /tmp/config.json",
          '\t{ "mode": "fast" }',
          "\tEOF",
          "# publish uploads the artifact to the bucket",
          "# then notifies the team the release is live",
          "# and waits for the upload queue to drain",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/notes.sh", 5]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped).toMatchObject([{ path: "scripts/notes.sh" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 comment");
    });

    // `let` is an ordinary shell command — `let first;` evaluates arithmetic and sets the exit
    // status `set -e` acts on. Read as the erased binding TypeScript spells the same way, a
    // duplicated window of that arithmetic is filed as a declaration list and dropped unread.
    it("reads a shell `let` command as code, not as the bare declaration it spells", async () => {
      const repo = writeRepo({
        "scripts/count.sh": [
          "#!/usr/bin/env bash",
          "let first;",
          "let second;",
          "let third;",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/count.sh", 2]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "scripts/count.sh", Line: 2 }]);
      expect(result.duplication).toEqual({ dropped: [] });
    });

    // `for await (…)` hands to a STATEMENT exactly as a plain `for` does, so a regex may follow its
    // closing paren. Read as division, the `/*` inside the character class opens a comment that
    // swallows every line below and drops the executable windows there as prose.
    it("reads a regex after a `for await` head, not as the block comment its class spells", async () => {
      const repo = writeRepo({
        "src/stream.ts": [
          "export async function scan(rows: AsyncIterable<string>) {",
          "  for await (const row of rows) /[/*]/.test(row);",
          "  const total = compute(rows);",
          "  report(total);",
          "  flush(total);",
          "}",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["src/stream.ts", 3]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/stream.ts", Line: 3 }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // `type` is an executable BUILTIN in shell — `type git` asks whether a command is on the PATH —
    // not an erased declaration. Read as one, a duplicated block of availability checks is dropped
    // as if it were a field list and the real clone never reaches triage.
    it("reads shell's `type` as the command it is, not as a type declaration", async () => {
      const repo = writeRepo({
        "scripts/preflight.sh": [
          "#!/usr/bin/env bash",
          "type git",
          "type bun",
          "type jq",
          "",
        ].join("\n"),
        "src/kind.ts": [
          "export type Kind = 'draft';",
          "export type Mode = 'ready';",
          "export type Stage = 'done';",
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/preflight.sh", 2]], 3),
        clone([["src/kind.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the TypeScript alias list beside it is still dropped, so the gate is by
      // LANGUAGE rather than the recognizer having been removed.
      expect(result.signals).toMatchObject([{ FilePath: "scripts/preflight.sh" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/kind.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 type");
    });

    // `import` is an ordinary COMMAND in shell — ImageMagick's `import -window root shot.png` takes
    // a screenshot — not a static dependency. Read as one, a duplicated block of captures is dropped
    // as if it were a specifier list and the repeated runtime behaviour never reaches triage.
    it("reads shell's `import` as the command it is, not as an import declaration", async () => {
      const repo = writeRepo({
        "scripts/capture.sh": [
          "#!/usr/bin/env bash",
          "import -window root shot-one.png",
          "import -window root shot-two.png",
          "import -window root shot-three.png",
          "",
        ].join("\n"),
        "src/deps.ts": [
          'import { readFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { spawn } from "node:child_process";',
          "",
        ].join("\n"),
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([["scripts/capture.sh", 2]], 3),
        clone([["src/deps.ts", 1]], 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      // Not vacuous: the TypeScript specifier list beside it is still dropped, so the gate is by
      // LANGUAGE rather than the recognizer having been removed.
      expect(result.signals).toMatchObject([{ FilePath: "scripts/capture.sh" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deps.ts" }]);
      expect(result.duplication.dropped[0].reason).toContain("3 import");
    });

    // A file anton could not READ is not a file that is GONE: `EACCES`, `EMFILE` and the like say
    // nothing about the block, so the signal keeps its place instead of being dropped as rewritten
    // away. Here the unreadable path is a directory — an `EISDIR` that needs no permission games.
    it("keeps a signal whose location could not be read, and drops one that is truly absent", async () => {
      const repo = writeRepo({ "src/doc.ts": DOC_BLOCK });
      mkdirSync(join(repo, "src/unreadable.ts"), { recursive: true });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone([
          ["src/unreadable.ts", 2],
          ["src/doc.ts", 2],
        ]),
        clone([["src/deleted.ts", 2]]),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toMatchObject([{ FilePath: "src/unreadable.ts" }]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/deleted.ts" }]);
    });

    // Two spellings of one path are one FILE. Cached under the raw string a signal used, the second
    // spelling reads the file again and spends a second of the 500-file budget on it — and a scan
    // wide enough to sit at that budget then reports a location it never read, keeping a signal the
    // tree disproves. 500 files with one of them respelled is exactly that edge.
    it("spends one file budget slot on a path reported under two spellings", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 500; i += 1) {
        files[`src/doc${i}.ts`] = [
          "// what this module is for,",
          "// at length,",
          "// and why.",
          "export const doc = 1;",
          "",
        ].join("\n");
      }
      const repo = writeRepo(files);
      const locations: [string, number][] = Object.keys(files).map((path) => [path, 1]);
      locations.splice(1, 0, ["./src/doc0.ts", 1]);
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        clone(locations, 3),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.duplication.dropped).toMatchObject([{ path: "src/doc0.ts" }]);
    });

    // The regression the bead was filed on, replayed: the duplication half of scan d9eab116
    // (2026-08-19), every signal exactly as stringer wrote it, judged against this repo's own tree.
    // Sizes the filter against real evidence rather than a hand-built tree — and if the drop rate
    // collapses, it collapsed on the corpus that justified the filter.
    it("drops most of the 2026-08-19 scan's duplication half and keeps its real clones", async () => {
      const signals = JSON.parse(
        readFileSync(join(process.cwd(), "src/lib/scan-duplication.d9eab116.fixture.json"), "utf8"),
      ) as { FilePath: string; Line: number }[];
      expect(signals).toHaveLength(97);

      const { kept, duplication } = await filterDuplicationSignals(process.cwd(), signals);

      // A location the tree no longer has is repo drift, not a verdict this filter reached. Score
      // the filter as a SHARE of the signals that still resolve: an absolute floor would erode
      // silently as the sources under the fixture move on, until it failed for no reason of ours.
      const drift = duplication.dropped.filter((d) =>
        d.reason.includes("exist on the tree anymore"),
      ).length;
      const classified = duplication.dropped.length - drift;
      expect(classified / (signals.length - drift)).toBeGreaterThanOrEqual(0.4); // 41 of 95 today
      expect(kept.length + duplication.dropped.length).toBe(97);
      // The hand-verified non-code primaries from the bead — a JSDoc paragraph, an interface field
      // list, an import specifier list, a doc block, two import statements.
      const droppedAt = new Set(duplication.dropped.map((d) => d.path));
      for (const path of [
        "src/lib/approval-gate.ts",
        "src/components/shape/shape-draft.ts",
        "src/lib/beads/bd-bin.test.ts",
        "src/lib/beads/contract-report.ts",
        "src/lib/jobs/execute-epic.ts",
      ]) {
        expect(droppedAt).toContain(path);
      }
      // ...and the test arrange-block clones the bead names as REAL duplication still come through.
      expect(kept).toContainEqual(
        expect.objectContaining({ FilePath: "src/lib/git/ops.test.ts", Line: 318 }),
      );
    });
  });

  it("keeps a caller abort an AbortError rather than reporting a timeout", async () => {
    process.env[STRINGER_BIN_ENV] = writeScript("slow-stringer", ["setTimeout(() => {}, 60000);"]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await expect(
      scan({ repoPath: "/repo", scanFile: join(dir, "s.json"), signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// The ONE reader of stringer's envelope — the dispatch decision and the health record both take
// their signals from here, so a shape this misses can't make them disagree about the same scan.
describe("extractSignals", () => {
  it("reads every envelope shape stringer emits, and a bare array", () => {
    expect(extractSignals([{ Source: "todos" }])).toHaveLength(1);
    expect(extractSignals({ signals: [{ Source: "todos" }, { Source: "vuln" }] })).toHaveLength(2);
    expect(extractSignals({ issues: [{ Source: "vuln" }] })).toHaveLength(1);
    expect(extractSignals({ results: [{ Source: "vuln" }] })).toHaveLength(1);
  });

  // `undefined`, not `[]`: a shape this doesn't know is a fact the caller has to be able to report,
  // where an empty array would assert a scan that genuinely found nothing.
  it("reports output carrying no signal array as unrecognized, not as empty", () => {
    expect(extractSignals({ signals: [] })).toEqual([]);
    expect(extractSignals({ metadata: {} })).toBeUndefined();
    expect(extractSignals(null)).toBeUndefined();
    expect(extractSignals("nope")).toBeUndefined();
  });
});

// The reported deadline is what an operator will go looking for in the config, so it must round-trip
// to the configured ANTON_STRINGER_TIMEOUT_MS rather than being rounded to a nearby minute.
describe("formatTimeout", () => {
  it("reports the configured deadline without rounding it away", () => {
    expect(formatTimeout(250)).toBe("250ms");
    expect(formatTimeout(59_999)).toBe("59999ms");
    expect(formatTimeout(60_000)).toBe("1m");
    expect(formatTimeout(600_000)).toBe("10m");
    expect(formatTimeout(90_000)).toBe("90s");
    expect(formatTimeout(61_234)).toBe("61.234s");
  });
});

describe("parseCollectorFailures", () => {
  it("reports each dead collector once, from either the ERROR or the INFO line", () => {
    expect(parseCollectorFailures(WORKTREECONFIG_STDERR)).toHaveLength(1);

    // INFO-only stderr (older/quieter builds) still yields the failure.
    const infoOnly = WORKTREECONFIG_STDERR.split("\n")
      .filter((l) => !l.includes("level=ERROR"))
      .join("\n");
    expect(parseCollectorFailures(infoOnly)).toEqual([
      {
        name: "gitlog",
        error: "opening repo: core.repositoryformatversion does not support extension: worktreeconfig",
      },
    ]);
  });

  it("picks up timed-out collectors and unquoted values, and ignores healthy scans", () => {
    const stderr = [
      `time=2026-07-26T19:26:45Z level=ERROR msg="collector failed" name=deadcode error="context deadline exceeded" duration=60.0s`,
      `time=2026-07-26T19:26:45Z level=ERROR msg="collector failed" name=vuln error=timeout duration=60.0s`,
    ].join("\n");
    expect(parseCollectorFailures(stderr)).toEqual([
      { name: "deadcode", error: "context deadline exceeded" },
      { name: "vuln", error: "timeout" },
    ]);

    expect(parseCollectorFailures("")).toEqual([]);

    // A quoted value JSON can't parse (a Go \x escape, or a line truncated mid-string) still yields
    // usable error text — the failure is never dropped just because its quoting is malformed.
    expect(
      parseCollectorFailures(
        `time=2026-07-26T19:26:45Z level=ERROR msg="collector failed" name=todos error="bad\\x00byte"`,
      ),
    ).toEqual([{ name: "todos", error: "bad\\x00byte" }]);
    expect(
      parseCollectorFailures(
        `time=2026-07-26T19:26:45Z level=ERROR msg="collector failed" name=churn error="unterminated`,
      ),
    ).toEqual([{ name: "churn", error: "unterminated" }]);
    expect(
      parseCollectorFailures(
        `time=2026-07-26T19:26:45Z level=INFO msg="collector complete" name=todos signals=1 duration=15ms`,
      ),
    ).toEqual([]);
  });
});

// A silent filter is indistinguishable from a collector that found nothing, so every drop has to be
// legible on the session that made it.
describe("describeUntrackedFilter", () => {
  const drop = (path: string, kind = "large-binary", severity = "medium") => ({
    path,
    kind,
    severity,
  });

  it("names what disappeared, stays quiet when nothing did, and reports an unreadable index", () => {
    expect(describeUntrackedFilter({ dropped: [] })).toBeUndefined();

    const line = describeUntrackedFilter({
      dropped: [drop("anton.db"), drop("scratch/notes.bin")],
    });
    expect(line).toContain("dropped 2 signal(s)");
    expect(line).toContain("about 2 path(s)");
    expect(line).toContain("anton.db (medium large-binary)");
    expect(line).toContain("scratch/notes.bin (medium large-binary)");

    const many = describeUntrackedFilter({
      dropped: Array.from({ length: 12 }, (_, i) => drop(`f${i}.db`)),
    });
    expect(many).toContain("(+2 more)");

    const blind = describeUntrackedFilter({ dropped: [], unavailable: "not a git repo" });
    expect(blind).toContain("not a git repo");
    expect(blind).toContain("are counted this pass");
  });

  // Triage turns on WHAT vanished, not how much: a dropped secret has to be distinguishable from
  // the stale-binary noise this filter exists to remove, even when they share a path.
  it("names the severity and kind behind each dropped path", () => {
    const line = describeUntrackedFilter({
      dropped: [
        drop("config/.env", "committed-secret", "critical"),
        drop("config/.env", "large-binary"),
        drop("anton.db"),
      ],
    });

    expect(line).toContain("dropped 3 signal(s) about 2 path(s)");
    expect(line).toContain("config/.env (critical committed-secret, medium large-binary)");
    expect(line).toContain("anton.db (medium large-binary)");
  });
});

describe("describeCollectorFailure", () => {
  it("names what the scan lost, and points at worktreeConfig when that's the cause", () => {
    const [failure] = parseCollectorFailures(WORKTREECONFIG_STDERR);
    const line = describeCollectorFailure(failure);
    expect(line).toContain(`collector "gitlog" failed`);
    expect(line).toContain("missing from this scan");
    expect(line).toContain("extensions.worktreeConfig");

    // Unrelated failures get the plain line — no misleading git-config advice.
    const plain = describeCollectorFailure({ name: "vuln", error: "context deadline exceeded" });
    expect(plain).toContain("context deadline exceeded");
    expect(plain).not.toContain("worktreeConfig");
  });
});
