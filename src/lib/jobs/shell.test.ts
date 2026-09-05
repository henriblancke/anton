import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KILL_GRACE_ENV, MAX_OUTPUT_ENV, runShell, runVerifyGates } from "./shell";
import type { VerifyGate } from "../projects";

// runVerifyGates is the shared backstop (anton-3oh8) that both execute-epic and review-fix run
// before committing/pushing: a non-zero gate throws, so the commit never happens. These tests
// pin that fail path plus ordering and the no-op-when-empty guarantee.
describe("runVerifyGates (anton-3oh8)", () => {
  let dir: string;
  let logPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-gates-test-"));
    logPath = join(dir, "session.log");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fail = (gate: VerifyGate, code: number | null) => `${gate.label} failed (exit ${code})`;

  it("resolves when every gate exits zero, running them in order", async () => {
    const gates: VerifyGate[] = [
      { label: "tests", command: "echo tests-ran" },
      { label: "lint", command: "echo lint-ran" },
    ];
    await expect(runVerifyGates(gates, dir, undefined, logPath, fail)).resolves.toBeUndefined();
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("[tests] echo tests-ran");
    expect(log).toContain("tests-ran");
    expect(log).toContain("[lint] echo lint-ran");
  });

  it("throws on the first non-zero gate — blocking the commit — and skips later gates", async () => {
    const marker = join(dir, "should-not-exist");
    const gates: VerifyGate[] = [
      { label: "tests", command: "true" },
      { label: "lint", command: "exit 3" },
      { label: "build", command: `touch ${marker}` },
    ];
    await expect(runVerifyGates(gates, dir, undefined, logPath, fail)).rejects.toThrow(
      "lint failed (exit 3)",
    );
    // The build gate after the failing lint gate never ran.
    expect(() => readFileSync(marker)).toThrow();
  });

  it("is a no-op when there are no gates (unchanged behavior)", async () => {
    await expect(runVerifyGates([], dir, undefined, logPath, fail)).resolves.toBeUndefined();
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Poll for a pid the gate command wrote to disk — the only handle a test has on a grandchild. */
async function readPid(path: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid file ${path} never appeared`);
}

// A cancelled gate must take its whole process tree with it (anton-jfjw.6). `sh -c` execs or forks
// the real test runner, so signalling only the wrapper orphans the runner and its workers: they keep
// burning CPU, hold ports, and can pin the promise open by inheriting stdio.
describe("runShell cancellation (anton-jfjw.6)", () => {
  let dir: string;
  const strays: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-shell-test-"));
  });

  afterEach(() => {
    delete process.env[KILL_GRACE_ENV];
    while (strays.length) {
      const pid = strays.pop()!;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone — the point of most of these tests
      }
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills the gate's grandchildren, not just the sh wrapper", async () => {
    const shPidFile = join(dir, "group-sh.pid");
    const kidPidFile = join(dir, "group-kid.pid");
    // sh waits on a forked node, so under the old direct-child-only kill the node outlived it.
    const cmd =
      `echo $$ > ${shPidFile}; ` +
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}; wait`;

    const ac = new AbortController();
    const promise = runShell(cmd, dir, ac.signal);
    const shPid = await readPid(shPidFile);
    const kidPid = await readPid(kidPidFile);
    strays.push(shPid, kidPid);

    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    expect(await waitForDeath(kidPid)).toBe(true);
    expect(await waitForDeath(shPid)).toBe(true);
  });

  // The rejection is what the timeout-preservation path reads as "this gate is done", and it rolls
  // the worktree back on it — so a gate still alive at that moment can write past the cleanliness
  // check and have its leftovers swept into the next ticket's commit (PR #228 review).
  it("escalates to SIGKILL and settles only once the trapping gate is gone", async () => {
    process.env[KILL_GRACE_ENV] = "1000";
    const shPidFile = join(dir, "trap-sh.pid");
    const cmd = `trap "" TERM; echo $$ > ${shPidFile}; while true; do sleep 0.1; done`;

    const ac = new AbortController();
    const promise = runShell(cmd, dir, ac.signal);
    const shPid = await readPid(shPidFile);
    strays.push(shPid);

    ac.abort();
    // The trap makes SIGTERM a no-op, so only the escalation can end it — and the promise waits
    // for that rather than rejecting into a caller that would then roll back under a live gate.
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(isAlive(shPid)).toBe(false);
  });

  it("keeps escalating for a worker that outlived the shell, and settles only once it is gone", async () => {
    process.env[KILL_GRACE_ENV] = "200";
    const kidPidFile = join(dir, "outlive-kid.pid");
    // `exec` replaces the shell with a short sleep, so the direct child exits while its worker is
    // still running: the escalation used to be cancelled by that exit, leaving the worker alive.
    const cmd =
      `${process.execPath} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1 << 30)' & ` +
      `echo $! > ${kidPidFile}; exec sleep 0.2`;

    const ac = new AbortController();
    const promise = runShell(cmd, dir, ac.signal);
    const kidPid = await readPid(kidPidFile);
    strays.push(kidPid);

    await new Promise((r) => setTimeout(r, 600)); // let the shell exit, leaving only the worker
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(isAlive(kidPid)).toBe(false);
  });

  it("settles on exit even when a leaked descendant still holds stdio", async () => {
    const kidPidFile = join(dir, "leak-kid.pid");
    // The backgrounded node inherits sh's stdout, so 'close' never fires — waiting for it would
    // hang the job run behind a process nobody is tracking any more.
    const cmd =
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}; ` +
      `echo parent-done`;

    const res = await runShell(cmd, dir);
    strays.push(await readPid(kidPidFile));

    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.output).toContain("parent-done");
  });
});

// A verify gate is an arbitrary operator-configured command, so its output is untrusted in size:
// a runaway test runner must be killed, not buffered until the server OOMs (PR #89 review).
describe("runShell output ceiling", () => {
  let dir: string;
  const strays: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-shell-cap-"));
  });

  afterEach(() => {
    delete process.env[MAX_OUTPUT_ENV];
    while (strays.length) {
      const pid = strays.pop()!;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone — the point of the test
      }
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills the group and rejects once a flooding gate blows the ceiling", async () => {
    process.env[MAX_OUTPUT_ENV] = "65536";
    const kidPidFile = join(dir, "flood-kid.pid");
    // The backgrounded node inherits sh's stdout, so nothing but a group kill ends the flood.
    const cmd =
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}; ` +
      `while :; do echo flood-flood-flood-flood-flood-flood; done`;

    const promise = runShell(cmd, dir);
    await expect(promise).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });

    const kidPid = await readPid(kidPidFile);
    strays.push(kidPid);
    expect(await waitForDeath(kidPid)).toBe(true);
  });

  it("leaves a gate under the ceiling untouched", async () => {
    process.env[MAX_OUTPUT_ENV] = "65536";
    const res = await runShell("echo under-the-cap", dir);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("under-the-cap");
  });
});

describe("runShell result (anton-jfjw.6)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-shell-result-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns combined stdout+stderr and a zero code for a passing gate", async () => {
    const res = await runShell("echo to-stdout; echo to-stderr >&2", dir);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.output).toContain("to-stdout");
    expect(res.output).toContain("to-stderr");
  });

  it("returns the real exit code and the output so far for a failing gate", async () => {
    const res = await runShell("echo before-fail; echo why >&2; exit 7", dir);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(7);
    expect(res.output).toContain("before-fail");
    expect(res.output).toContain("why");
  });

  it("captures the full output of a chatty gate (no truncation at exit)", async () => {
    const res = await runShell("i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done", dir);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("line-0");
    expect(res.output).toContain("line-1999");
  });
});
