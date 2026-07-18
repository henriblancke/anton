/**
 * Run a shell command for a job (tests, build gates), capturing combined stdout+stderr and
 * honoring the run's AbortSignal. Shared by execute-epic and review-fix. See DESIGN §4.
 */
import { spawn } from "node:child_process";
import { appendSessionLog } from "../sessions";
import type { VerifyGate } from "../projects";

export interface ShellResult {
  ok: boolean;
  code: number | null;
  output: string;
}

export function runShell(cmd: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { cwd, signal });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, code, output: out }));
  });
}

/**
 * Run the operator's verify gates in order (anton-3oh8), logging each to the session and throwing
 * on the first non-zero exit — the same fail path as the historical single test gate. `onFail`
 * builds the caller-specific error message (execute-epic names the ticket; review-fix names the
 * PR). An empty gate list is a no-op, preserving unchanged behavior when nothing is configured.
 */
export async function runVerifyGates(
  gates: VerifyGate[],
  cwd: string,
  signal: AbortSignal | undefined,
  logPath: string,
  onFail: (gate: VerifyGate, code: number | null) => string,
): Promise<void> {
  for (const gate of gates) {
    const res = await runShell(gate.command, cwd, signal);
    await appendSessionLog(logPath, `\n[${gate.label}] ${gate.command}\n${res.output}\n`);
    if (!res.ok) throw new Error(onFail(gate, res.code));
  }
}
