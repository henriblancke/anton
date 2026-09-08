/**
 * The `bd` exec seam: spawning one bd process, budgeting it, and decoding what it printed.
 *
 * The seam this module exists to keep one-way (anton-n1m0): the coalescer in ./sync-coalescer owns
 * WHEN a sync pass runs, ./dolt-sync owns the pass itself (preflight, pull → commit → push), and
 * this module owns HOW a single bd invocation runs. ./bd, ./dolt-sync and ./sync-coalescer all
 * import from here and none is imported back, so each side is testable without the others.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveBdBin } from "./bd-bin";
import { buildBdEnv } from "./bd-env";

/**
 * Wall-clock budget for ONE `bd` invocation. Note what it does NOT bound: it is a per-step budget,
 * so a full sync pass (pull → commit → push) may legitimately spend 3× it. Callers that need a
 * bounded PASS must add their own deadline on top (see beatDeadlineMs in sync-engine.ts).
 */
export const BD_STEP_TIMEOUT_MS = 60_000;

/** Override the per-step budget (tests shrink it; also an ops escape hatch). Read per call so a
 * change lands without a module reload. */
export const BD_STEP_TIMEOUT_ENV = "ANTON_BD_STEP_TIMEOUT_MS";

/** Override the SIGTERM→SIGKILL grace (tests shrink it). Read per call. */
export const BD_KILL_GRACE_ENV = "ANTON_BD_KILL_GRACE_MS";

/**
 * How long a bd that blew its budget gets to unwind on SIGTERM before SIGKILL. bd traps SIGTERM to
 * release the exclusive Dolt lock, so the polite signal comes first — but a bd that then blocks on
 * its own wedged `git fetch` survived that SIGTERM in the field for days, so the escalation is
 * mandatory, not optional (anton-jfjw.1).
 */
const DEFAULT_BD_KILL_GRACE_MS = 5_000;

/**
 * How long to keep draining stdio after bd exits. `close` is the only event that guarantees the
 * pipes drained, but a grandchild that inherited them holds them open long after bd is gone — and
 * waiting on it is exactly what left the caller's promise pending for days while a heartbeat sat
 * wedged. So `exit` starts a bounded drain and the promise settles either way. A normal bd exits
 * with nothing else holding the pipes, so `close` lands immediately and this never comes into play.
 */
const DRAIN_AFTER_EXIT_MS = 2_000;

/** Output ceiling per stream, carried over from the execFile `maxBuffer` this replaced: a runaway
 * stream is killed rather than grown until the server OOMs. A whole-board `bd list --json` is
 * comfortably under it. */
const BD_MAX_BUFFER = 32 * 1024 * 1024;

/** Override the per-stream output ceiling (tests shrink it so the overflow path is exercisable
 * without producing 32 MB). Read per call, like the budget and the kill grace. */
export const BD_MAX_BUFFER_ENV = "ANTON_BD_MAX_BUFFER";

function stepTimeoutMs(): number {
  const raw = Number(process.env[BD_STEP_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_STEP_TIMEOUT_MS;
}

function maxBuffer(): number {
  const raw = Number(process.env[BD_MAX_BUFFER_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_MAX_BUFFER;
}

function killGraceMs(): number {
  const raw = Number(process.env[BD_KILL_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BD_KILL_GRACE_MS;
}

/** Per-invocation knobs for {@link bd}: extra env, and stdin for the commands that read it. */
export interface BdOpts {
  /** Merged over `process.env` (e.g. BEADS_ACTOR for an attributed write). An `undefined` value
   * REMOVES the variable rather than inheriting the server's — see `bd-env.ts`'s `buildBdEnv`. */
  env?: Record<string, string | undefined>;
  /** Written to bd's stdin, which is then closed. Required by `bd batch`, which reads its
   * commands from stdin — without it bd would block on an open pipe until the step budget. */
  stdin?: string;
}

/**
 * Run one `bd` command and return its stdout.
 *
 * Two properties this owes its callers, both learned the hard way (anton-jfjw.1 — a `bd dolt pull`
 * whose `git fetch` entered uninterruptible wait when the network died under it, leaving the parent
 * alive for two days, the Dolt lock held, and anton's heartbeat pinned forever):
 *
 * 1. **The reap targets the process group.** bd's own git/dolt children are what actually wedge, and
 *    signalling only bd leaves them running — still holding the exclusive Dolt lock that then fails
 *    every later `bd list` in that repo. So bd leads its own group and the budget kills the group,
 *    escalating SIGTERM → SIGKILL.
 * 2. **The promise settles on `exit`, not on stdio `close`.** A leaked grandchild holds the inherited
 *    pipes open, so `close` may never fire; and past the budget the caller is released immediately —
 *    the reap runs on in the background, because a grandchild in uninterruptible wait can survive
 *    even SIGKILL and must not be able to hold a caller hostage while it does.
 *
 * `async` so a resolveBdBin() failure (no bd on the box) surfaces as a rejection rather than a
 * synchronous throw — every call site awaits or `.catch()`es this.
 *
 * Exported for ./bd, which wraps it as the `beads` verb seam; nothing outside this directory
 * spawns bd directly.
 */
export async function bd(cwd: string, args: string[], opts?: BdOpts): Promise<string> {
  // Spawn bd by its resolved absolute path (anton-346): a background-launched server's PATH may not
  // reach bd's install dir, so a bare `spawn("bd", …)` fails with `spawn bd ENOENT`.
  const bin = resolveBdBin();
  const budgetMs = stepTimeoutMs();
  const bufferLimit = maxBuffer();
  const startedAt = Date.now();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // POSIX: make bd the leader of a new process group so the whole tree is reachable as one.
      detached: process.platform !== "win32",
      // Always built through buildBdEnv, even with no overrides: it is what strips the
      // project-scoped BEADS_DOLT_* that would otherwise route this call at another project's
      // database, and what narrows the password to THIS project's user (anton-ffmw.1).
      env: buildBdEnv(cwd, opts?.env ?? {}),
    });

    if (opts?.stdin !== undefined) {
      // EPIPE is expected whenever bd rejects its input and exits before draining the pipe (a batch
      // whose first line is malformed): the exit code carries the verdict, so the write error is
      // noise. Ignoring it keeps the real failure — bd's own stderr — as the one the caller sees.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }

    // StringDecoder, not per-chunk toString: a multi-byte character split across two chunks would
    // otherwise corrupt the JSON every read path parses.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // The group may never have formed (spawn failed, or the leader is already reaped) — fall
          // back to the direct child handle so the reap still reaches bd itself.
        }
      }
      child.kill(sig);
    };

    const settle = (emit: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      if (drainTimer) clearTimeout(drainTimer);
      emit();
    };

    /** Drop the pipes a leaked grandchild is still holding — nothing will read them again. */
    const dropPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    /**
     * execFile-shaped failure for a non-zero exit: promisified execFile attached the captured
     * streams to the error, and runDoltSync's benign/first-publish matchers read them off it.
     */
    const exitFailure = (code: number | null, signal: NodeJS.Signals | null) =>
      Object.assign(new Error(`Command failed: ${[bin, ...args].join(" ")}\n${stderr}`), {
        cmd: [bin, ...args].join(" "),
        code: code ?? undefined,
        signal,
        killed: child.killed,
        stdout,
        stderr,
      });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      // Flush whatever the decoders held back (an output that ends mid-character), as execFile did.
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (code === 0) resolve(stdout);
      else reject(exitFailure(code, signal));
    };

    const budgetTimer = setTimeout(() => {
      killGroup("SIGTERM");
      // The escalation deliberately outlives the promise: the caller unwinds now, while the group
      // still gets killed. It is never disarmed — bd's own exit says nothing about the descendants
      // the reap is actually for (see the `exit` handler). Unlike runShell, which waits for the
      // group before it settles: nothing here rolls a worktree back on this rejection.
      setTimeout(() => killGroup("SIGKILL"), killGraceMs());
      settle(() => {
        dropPipes();
        // Partial stdout/stderr is deliberately NOT attached: a wedged step's captured output is
        // startup noise, and runDoltSync prefers it over the message — which would bury the real
        // cause exactly as it did for stringer (anton-be1s).
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd} exceeded its ${budgetMs}ms budget ` +
                `(elapsed ${Date.now() - startedAt}ms) and its process group was killed. ` +
                `bd or a child of it (typically \`git fetch\` against an unreachable remote) hung; ` +
                `if it held the Dolt lock, later bd calls in this repo may fail until the tree is gone.`,
            ),
            { killed: true, signal: "SIGTERM" as NodeJS.Signals },
          ),
        );
      });
    }, budgetMs);

    /** maxBuffer parity: kill the tree and reject rather than buffer without bound. */
    const overflow = (stream: "stdout" | "stderr") => {
      killGroup("SIGKILL");
      settle(() => {
        dropPipes();
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd}: ${stream} exceeded ${bufferLimit} bytes ` +
                `(maxBuffer length exceeded)`,
            ),
            { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, stdout, stderr },
          ),
        );
      });
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout += outDecoder.write(c);
      if (stdout.length > bufferLimit) overflow("stdout");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += errDecoder.write(c);
      if (stderr.length > bufferLimit) overflow("stderr");
    });

    // `spawn bd ENOENT` and friends — bd never ran, so there is no group to reap.
    child.on("error", (err) => settle(() => reject(err)));

    // The fast path for every healthy call: `close` follows `exit` immediately when nothing else
    // holds the pipes, so stdout is complete and capture is byte-identical to the execFile it replaced.
    child.on("close", (code, signal) => settle(() => finish(code, signal)));

    child.on("exit", (code, signal) => {
      // A pending SIGKILL is deliberately NOT cancelled here. The reap targets the process group,
      // and bd exiting on the SIGTERM proves nothing about the wedged `git fetch` that ignored it —
      // that survivor is what holds the Dolt lock and what the escalation exists to reach. Disarming
      // on the leader's exit would restore the very leak the group kill was added to close. When the
      // group is already empty the escalation is a harmless ESRCH inside killGroup.
      if (settled) return; // already timed out (or overflowed) — the caller has its verdict
      drainTimer = setTimeout(
        () =>
          settle(() => {
            dropPipes();
            finish(code, signal);
          }),
        DRAIN_AFTER_EXIT_MS,
      );
    });
  });
}

/**
 * Test-only handle on the single bd invoker (anton-jfjw.1): the process-lifecycle suite drives real
 * fake-`bd` scripts through it to prove the group reap and the settle-on-exit contract. Production
 * code goes through the `beads` object.
 */
export const runBdForTest = bd;

export type BdExec = typeof bd;
