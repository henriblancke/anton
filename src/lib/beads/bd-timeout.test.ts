/**
 * Process-lifecycle tests for the single bd invoker (anton-jfjw.1). These drive REAL fake-`bd`
 * scripts (pointed at via ANTON_BD_BIN) rather than a mocked child_process, because the defect they
 * pin lives entirely in process semantics:
 *
 * A `bd dolt pull` whose `git fetch` wedged on a dead peer stayed alive for two days. Node's
 * `execFile({ timeout })` signalled only bd itself — leaving the git child running and holding the
 * exclusive Dolt lock — and promisified execFile settles on stdio `close`, which the inherited pipes
 * kept from ever firing. So the caller's promise never settled at all.
 *
 * A regression here HANGS the test rather than quietly passing, which is the point: budgets are
 * shrunk via ANTON_BD_STEP_TIMEOUT_MS so a lost reap shows up as a timeout, not a slow pass.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BD_KILL_GRACE_ENV,
  BD_MAX_BUFFER_ENV,
  BD_STEP_TIMEOUT_ENV,
  runBdForTest as runBd,
  runDoltSync,
} from "./bd";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

/** Budget for the hang tests: long enough to clear process startup, short enough to stay a unit test. */
const BUDGET_MS = 1_500;
/** SIGTERM→SIGKILL grace for the escalation test — short, so the whole suite stays quick. */
const GRACE_MS = 750;

let dir: string;
const strays: number[] = [];

/** Write an executable fake `bd` and point resolveBdBin() at it. Returns its path. */
function fakeBd(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, [...lines, ""].join("\n"), "utf8");
  chmodSync(path, 0o755);
  process.env[BD_BIN_ENV] = path;
  resetBdBinCache();
  return path;
}

// Mirrors the liveness helpers in jobs/shell.test.ts — a pid is the only handle a test has on a
// process it did not spawn itself.
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

/** Poll for a pid the fake bd wrote to disk — the only handle a test has on a grandchild. */
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-bd-timeout-"));
});

beforeEach(() => {
  process.env[BD_STEP_TIMEOUT_ENV] = String(BUDGET_MS);
});

afterEach(() => {
  delete process.env[BD_STEP_TIMEOUT_ENV];
  delete process.env[BD_KILL_GRACE_ENV];
  delete process.env[BD_MAX_BUFFER_ENV];
  delete process.env[BD_BIN_ENV];
  resetBdBinCache();
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

describe("bd timeout reaps the whole process group (anton-jfjw.1)", () => {
  it("kills bd AND the grandchild that inherited its stdio, rejecting within the budget", async () => {
    const bdPidFile = join(dir, "group-bd.pid");
    const kidPidFile = join(dir, "group-kid.pid");
    // The field shape: bd forks a child that inherits stdio (its `git fetch`) and then blocks. Under
    // a direct-child-only kill the grandchild outlives the reap and keeps the Dolt lock; because it
    // also holds the pipes, `close` never fires and the caller's promise never settles.
    fakeBd("bd-leaks-grandchild", [
      "#!/bin/sh",
      `echo $$ > ${bdPidFile}`,
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}`,
      "sleep 30",
    ]);

    const startedAt = Date.now();
    const promise = runBd(dir, ["dolt", "pull"]);
    const bdPid = await readPid(bdPidFile);
    const kidPid = await readPid(kidPidFile);
    strays.push(bdPid, kidPid);

    await expect(promise).rejects.toThrow(/exceeded its \d+ms budget/);
    // The caller is released at the budget (plus the reap's own grace), never held hostage.
    expect(Date.now() - startedAt).toBeLessThan(BUDGET_MS + 5_000);

    expect(await waitForDeath(kidPid), "the leaked grandchild must be reaped too").toBe(true);
    expect(await waitForDeath(bdPid), "bd itself must be reaped").toBe(true);
  });

  it("escalates SIGTERM to SIGKILL for a bd that traps the signal", async () => {
    // bd traps SIGTERM to release the Dolt lock, so it can be alive and unkillable-by-SIGTERM at the
    // budget — the field case exactly. Without escalation the reap is a no-op and the lock stays held.
    process.env[BD_KILL_GRACE_ENV] = String(GRACE_MS);
    const bdPidFile = join(dir, "trap-bd.pid");
    fakeBd("bd-traps-sigterm", [
      "#!/bin/sh",
      'trap "" TERM',
      `echo $$ > ${bdPidFile}`,
      "while true; do sleep 0.1; done",
    ]);

    const promise = runBd(dir, ["dolt", "pull"]);
    const bdPid = await readPid(bdPidFile);
    strays.push(bdPid);

    await expect(promise).rejects.toThrow(/exceeded its \d+ms budget/);
    // The trap makes SIGTERM a no-op, so bd is still up when the caller unwinds...
    expect(isAlive(bdPid)).toBe(true);
    // ...and only the escalation can end it.
    expect(await waitForDeath(bdPid)).toBe(true);
  });

  it("still escalates for a descendant that outlived a bd which exited on the SIGTERM", async () => {
    // The other escalation test keeps bd alive (it traps SIGTERM), so it never exercises the
    // `exit` handler. This is the field shape that does: SIGTERM ends bd itself, while its wedged
    // `git fetch` ignores the signal and keeps the exclusive Dolt lock. Cancelling the pending
    // SIGKILL just because the group leader exited leaves that survivor running forever.
    process.env[BD_KILL_GRACE_ENV] = String(GRACE_MS);
    const bdPidFile = join(dir, "survivor-bd.pid");
    const kidPidFile = join(dir, "survivor-kid.pid");
    fakeBd("bd-exits-leaving-survivor", [
      "#!/bin/sh",
      `sh -c 'trap "" TERM; echo $$ > ${kidPidFile}; while true; do sleep 0.1; done' &`,
      `echo $$ > ${bdPidFile}`,
      "sleep 30",
    ]);

    const promise = runBd(dir, ["dolt", "pull"]);
    const bdPid = await readPid(bdPidFile);
    const kidPid = await readPid(kidPidFile);
    strays.push(bdPid, kidPid);

    await expect(promise).rejects.toThrow(/exceeded its \d+ms budget/);
    // bd takes the SIGTERM and goes — the exit that used to disarm the escalation...
    expect(await waitForDeath(bdPid), "bd itself exits on the SIGTERM").toBe(true);
    // ...while only the escalation can reach the descendant that ignored it.
    expect(
      await waitForDeath(kidPid),
      "the SIGTERM-immune descendant must still be SIGKILLed after bd exits",
    ).toBe(true);
  });

  it("names the cwd, the argv and the budget in the timeout error", async () => {
    fakeBd("bd-hangs", ["#!/bin/sh", "sleep 30"]);
    const err: Error = await runBd(dir, ["dolt", "pull"]).then(
      () => {
        throw new Error("expected a timeout rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain(dir); // which repo is wedged
    expect(err.message).toContain("dolt pull"); // which step
    expect(err.message).toContain(`${BUDGET_MS}ms budget`); // and the budget it blew
  });

  it("surfaces the wedge through runDoltSync instead of burying it under partial output", async () => {
    // A wedged step's captured stderr is startup noise; runDoltSync prefers attached output over the
    // message, so attaching it would hide the real cause (the anton-be1s failure mode). It must not.
    fakeBd("bd-noisy-hang", [
      "#!/bin/sh",
      'echo "warning: whatever" >&2',
      "sleep 30",
    ]);
    await expect(runDoltSync(dir)).rejects.toThrow(/bd dolt pull failed[\s\S]*exceeded its \d+ms budget/);
  });
});

describe("bd caps captured output per stream (anton-jfjw.1)", () => {
  // The ceiling replaced execFile's native `maxBuffer`, so it is hand-rolled code with a process
  // kill in it. ANTON_BD_MAX_BUFFER shrinks it to 64 KB (as ANTON_SHELL_MAX_OUTPUT does for gates)
  // so the path is provable in milliseconds instead of needing 32 MB of output.
  const CAP = 65_536;

  it("kills the group and rejects once a flooding bd blows the stdout ceiling", async () => {
    process.env[BD_STEP_TIMEOUT_ENV] = String(30_000); // the overflow, not the budget, must reject
    process.env[BD_MAX_BUFFER_ENV] = String(CAP);
    const kidPidFile = join(dir, "flood-kid.pid");
    // The backgrounded node inherits bd's stdout, so nothing but a group kill ends it.
    fakeBd("bd-floods-stdout", [
      "#!/bin/sh",
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}`,
      "while :; do echo flood-flood-flood-flood-flood-flood; done",
    ]);

    const err = (await runBd(dir, ["list", "--json"]).then(
      () => {
        throw new Error("expected an overflow rejection");
      },
      (e: Error) => e,
    )) as Error & { code?: string; killed?: boolean };
    expect(err.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(err.killed).toBe(true);
    expect(err.message).toContain("stdout");
    expect(err.message).toContain(String(CAP)); // the ceiling actually in force, not the default

    const kidPid = await readPid(kidPidFile);
    strays.push(kidPid);
    expect(await waitForDeath(kidPid), "the leaked grandchild must be reaped too").toBe(true);
  });

  it("applies the ceiling to stderr as well", async () => {
    process.env[BD_STEP_TIMEOUT_ENV] = String(30_000);
    process.env[BD_MAX_BUFFER_ENV] = String(CAP);
    fakeBd("bd-floods-stderr", [
      "#!/bin/sh",
      "while :; do echo flood-flood-flood-flood-flood-flood >&2; done",
    ]);

    await expect(runBd(dir, ["dolt", "pull"])).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      message: expect.stringContaining("stderr"),
    });
  });

  it("leaves a call under the ceiling untouched", async () => {
    process.env[BD_MAX_BUFFER_ENV] = String(CAP);
    fakeBd("bd-under-cap", ["#!/bin/sh", 'printf "%s" "[]"']);
    await expect(runBd(dir, ["list", "--json"])).resolves.toBe("[]");
  });
});

describe("bd settles on exit, not on stdio close (anton-jfjw.1)", () => {
  it("resolves promptly with bd's stdout while a leaked descendant still holds the pipes", async () => {
    // bd exits normally but leaves a backgrounded child holding stdout, so `close` never fires.
    // Waiting for it is what pinned the heartbeat forever; the bounded drain settles anyway.
    const kidPidFile = join(dir, "leak-kid.pid");
    process.env[BD_STEP_TIMEOUT_ENV] = String(30_000); // a lost settle must not merely time out
    fakeBd("bd-leaks-on-exit", [
      "#!/bin/sh",
      `${process.execPath} -e 'setInterval(() => {}, 1 << 30)' & echo $! > ${kidPidFile}`,
      'printf "%s" "[]"',
    ]);

    const startedAt = Date.now();
    const out = await runBd(dir, ["list", "--json"]);
    const elapsed = Date.now() - startedAt;
    strays.push(await readPid(kidPidFile));

    expect(out).toBe("[]");
    expect(elapsed, "settled on exit + a bounded drain, not on close").toBeLessThan(10_000);
  });
});

describe("bd normal calls are unchanged (anton-jfjw.1)", () => {
  it("returns the full stdout of a fast call, byte for byte", async () => {
    // Large enough to arrive in several chunks, and multi-byte, so a decoder that splits a character
    // across chunk boundaries would corrupt the JSON every read path parses.
    const payload = JSON.stringify(
      Array.from({ length: 4_000 }, (_, i) => ({ id: `bd-${i}`, title: `título ✅ ${i}` })),
    );
    const payloadFile = join(dir, "payload.json");
    writeFileSync(payloadFile, payload, "utf8");
    fakeBd("bd-fast", ["#!/bin/sh", `cat ${payloadFile}`]);

    const out = await runBd(dir, ["list", "--json"]);
    expect(out).toBe(payload);
    expect(out.length).toBeGreaterThan(64 * 1024); // spans chunk boundaries
    expect(JSON.parse(out)).toHaveLength(4_000);
  });

  it("passes the caller's env through to bd", async () => {
    fakeBd("bd-echo-actor", ["#!/bin/sh", 'printf "%s" "$BEADS_ACTOR"']);
    await expect(runBd(dir, ["note", "bd-1", "hi"], { env: { BEADS_ACTOR: "ada" } })).resolves.toBe(
      "ada",
    );
  });

  it("rejects a non-zero exit with the captured streams attached (runDoltSync reads them)", async () => {
    fakeBd("bd-fails", ["#!/bin/sh", 'echo "partial" ', 'echo "Error: boom" >&2', "exit 3"]);
    const err = (await runBd(dir, ["dolt", "push"]).catch((e: Error) => e)) as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    expect(err.code).toBe(3);
    expect(err.stdout).toContain("partial");
    expect(err.stderr).toContain("Error: boom");
    expect(err.message).toContain("Command failed");
  });

  it("keeps runDoltSync's benign/not-wired classification working end to end", async () => {
    // The classification reads err.stderr/err.stdout off the rejection, so it is the sharpest check
    // that the error shape survived the move off execFile.
    fakeBd("bd-unwired", [
      "#!/bin/sh",
      'echo "No remote is configured — skipping." >&2',
      "exit 1",
    ]);
    await expect(runDoltSync(dir)).resolves.toBe("not-wired");

    fakeBd("bd-nothing-to-commit", [
      "#!/bin/sh",
      'if [ "$2" = "commit" ]; then echo "Nothing to commit."; exit 1; fi',
      "exit 0",
    ]);
    await expect(runDoltSync(dir)).resolves.toBe("synced");
  });

  it("rejects loudly when bd cannot be spawned at all", async () => {
    const missing = join(dir, "not-executable-bd");
    writeFileSync(missing, "#!/bin/sh\n", "utf8");
    chmodSync(missing, 0o644); // present but not executable
    process.env[BD_BIN_ENV] = missing;
    resetBdBinCache();
    await expect(runBd(dir, ["list"])).rejects.toThrow();
  });
});
