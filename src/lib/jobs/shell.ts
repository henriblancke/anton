/**
 * Run a shell command for a job (tests, build gates), capturing combined stdout+stderr and
 * honoring the run's AbortSignal. Shared by execute-epic and review-fix. See DESIGN §4.
 */
import { spawn } from "node:child_process";
import { appendSessionLog } from "../sessions";
import { VERIFY_GATE_LOCK, withHostLock } from "./host-lock";
import type { VerifyGate } from "../projects";

export interface ShellResult {
  ok: boolean;
  code: number | null;
  output: string;
}

/**
 * Override the SIGTERM→SIGKILL grace (tests shrink it). Read per call so a change lands without a
 * module reload.
 */
export const KILL_GRACE_ENV = "ANTON_SHELL_KILL_GRACE_MS";

/** Override the captured-output ceiling (tests shrink it). Read per call, like the kill grace. */
export const MAX_OUTPUT_ENV = "ANTON_SHELL_MAX_OUTPUT";

/** Default window a cancelled gate gets to tear down its own workers before it is killed outright. */
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Ceiling on a gate's captured output, matching bd.ts's `BD_MAX_BUFFER`. Gates are arbitrary
 * operator-configured commands, so a test runner looping on a stack trace can emit output until the
 * server OOMs; past this the group is killed and the gate fails loud instead of growing without
 * bound. A full test-suite log is comfortably under it.
 */
const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * How long to keep draining stdio after the command exits. `close` is the only event that
 * guarantees the pipes drained, but a descendant that inherited stdout holds them open long after
 * the gate itself is gone — waiting on it would wedge the job run. So `exit` starts a bounded drain
 * and the promise settles either way (anton-jfjw.6).
 */
const DRAIN_AFTER_EXIT_MS = 2_000;

function killGraceMs(): number {
  const raw = Number(process.env[KILL_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_KILL_GRACE_MS;
}

function maxOutput(): number {
  const raw = Number(process.env[MAX_OUTPUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_OUTPUT;
}

/**
 * Shaped like Node's own AbortError (name + code), which is what `spawn({ signal })` used to raise
 * here — callers that discriminate cancellation from failure keep working now that runShell owns
 * cancellation itself.
 */
function abortError(): Error {
  const err: Error & { code?: string } = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

export function runShell(cmd: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    // `sh -c` immediately execs or forks the real gate command, so a test runner and its workers are
    // only reachable as a group. Leading its own process group is what lets cancellation kill them
    // instead of just the wrapper (anton-jfjw.6 — the same defect the claude driver already fixed).
    const child = spawn("sh", ["-c", cmd], { cwd, detached: process.platform !== "win32" });

    let out = "";
    let exited = false;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // The group may never have formed (spawn failed); fall back to the direct child handle.
        }
      }
      child.kill(sig);
    };

    const settle = (emit: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (drainTimer) clearTimeout(drainTimer);
      emit();
    };

    // Node's built-in `signal` support only ever SIGTERMs the direct child, once. Cancellation is
    // owned here instead: signal the whole group, then escalate for a command that traps SIGTERM.
    // The escalation deliberately outlives the promise — the run unwinds immediately, while the
    // group still gets killed — and is cleared as soon as the child actually exits.
    const onAbort = () => {
      if (!exited) {
        killGroup("SIGTERM");
        escalateTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs());
      }
      settle(() => reject(abortError()));
    };

    /** maxBuffer parity with bd.ts: kill the group and reject rather than buffer without bound. */
    const limit = maxOutput();
    const overflow = () => {
      killGroup("SIGKILL");
      settle(() => {
        // Drop the pipes a leaked descendant is still holding — nothing will read them again.
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(
          Object.assign(new Error(`gate output exceeded ${limit} bytes: ${cmd}`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
          }),
        );
      });
    };

    const capture = (c: Buffer) => {
      out += c.toString("utf8");
      if (out.length > limit) overflow();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => settle(() => resolve({ ok: code === 0, code, output: out })));
    child.on("exit", (code) => {
      exited = true;
      if (escalateTimer) clearTimeout(escalateTimer);
      if (settled) return;
      drainTimer = setTimeout(() => {
        settle(() => {
          // Drop the pipes a leaked descendant is still holding — nothing will read them again.
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({ ok: code === 0, code, output: out });
        });
      }, DRAIN_AFTER_EXIT_MS);
    });

    // A signal already aborted before spawn never fires 'abort', so cancel explicitly.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run the operator's verify gates in order (anton-3oh8), logging each to the session and throwing
 * on the first non-zero exit — the same fail path as the historical single test gate. `onFail`
 * builds the caller-specific error message (execute-epic names the ticket; review-fix names the
 * PR). An empty gate list is a no-op, preserving unchanged behavior when nothing is configured.
 *
 * The whole sequence runs under a host-wide lock (anton-0oi): concurrent runs each starting a full
 * suite starve each other into timeout failures that belong to neither change. The lock is advisory
 * — if a peer holds it too long we run anyway, because a slow gate beats a wedged queue.
 */
export async function runVerifyGates(
  gates: VerifyGate[],
  cwd: string,
  signal: AbortSignal | undefined,
  logPath: string,
  onFail: (gate: VerifyGate, code: number | null) => string,
): Promise<void> {
  if (gates.length === 0) return; // no gates: never take the lock

  await withHostLock(
    VERIFY_GATE_LOCK,
    async () => {
      for (const gate of gates) {
        const res = await runShell(gate.command, cwd, signal);
        await appendSessionLog(logPath, `\n[${gate.label}] ${gate.command}\n${res.output}\n`);
        if (!res.ok) throw new Error(onFail(gate, res.code));
      }
    },
    {
      signal,
      label: cwd,
      onWait: (holder) => {
        void appendSessionLog(
          logPath,
          `\n[verify] waiting for host verify-gate lock (held by pid ${holder?.pid ?? "?"}${holder?.label ? ` — ${holder.label}` : ""})\n`,
        );
      },
    },
  );
}
