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
        clone([["src/panel.tsx", 5]], 4),
      ]);

      const result = await scan({ repoPath: repo, scanFile: join(dir, "scan.json") });

      expect(result.signals).toEqual([]);
      const [drop] = result.duplication.dropped;
      expect(drop.reason).toContain("holds nothing but blank and structural lines");
      expect(drop.reason).toContain("3 structural");
      expect(drop.reason).not.toContain("declares rather than computes");
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
