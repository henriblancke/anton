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
    // each line alone misses the caller and the component goes on being reported dead.
    it("counts an MDX caller written across lines, and still not the prose beside it", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "docs/imports.mdx": "import {\n  Widget,\n} from '../src/ui/widget';\n",
        "docs/expression.mdx": "{\n  Widget()\n}\n",
        "docs/notes.mdx": "Widget was removed in favour of Panel.\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("docs/imports.mdx");
      expect(result.deadcode.dropped[0].reason).toContain("docs/expression.mdx");
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

    // The two shapes with no code punctuation around them at all: a Svelte directive binding
    // (`use:enhance`) and an Astro frontmatter import, which sits above the markup rather than in
    // a `<script>`. Both name the symbol as plainly as a call does.
    it("counts a template directive and an Astro frontmatter import", async () => {
      const repo = initRepo({
        "src/ui/widget.tsx": "export function Widget() {\n  return null;\n}\n",
        "src/ui/form.svelte": "<form use:Widget>\n</form>\n",
        "src/pages/index.astro":
          "---\nimport { Widget } from '../ui/widget';\n---\n<main>hello</main>\n",
        "public/notes.html": "<p>Widget was removed in favour of Panel</p>\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/ui/widget.tsx", "Widget"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "Widget" }]);
      expect(result.deadcode.dropped[0].reason).toContain("src/ui/form.svelte");
      expect(result.deadcode.dropped[0].reason).toContain("src/pages/index.astro");
      expect(result.deadcode.dropped[0].reason).not.toContain("public/notes.html");
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

    // A file anton has no grammar for still has block comments: `.hcl` writes them `/* ... */`, and
    // their continuation lines carry no marker for the line test to see. Accepting one as code
    // deletes a genuine finding — while a real call below the block still has to count.
    it("tracks block comments in a file anton has no grammar for, and still counts its callers", async () => {
      const repo = initRepo({
        "src/lib/orphan.ts": "export function neverCalled() {}\n",
        "infra/notes.hcl": "/*\nneverCalled was removed\n*/\nlocals {}\n",
        "infra/caller.hcl": "/*\nneverCalled is called below.\n*/\nvalue = neverCalled()\n",
      });
      process.env[STRINGER_BIN_ENV] = writeFakeStringer(join(dir, "argv.json"), [
        unused("src/lib/orphan.ts", "neverCalled"),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      expect(result.deadcode.dropped).toMatchObject([{ symbol: "neverCalled" }]);
      expect(result.deadcode.dropped[0].reason).toContain("infra/caller.hcl");
      expect(result.deadcode.dropped[0].reason).not.toContain("infra/notes.hcl");
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
