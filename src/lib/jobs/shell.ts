/**
 * Run a shell command for a job (tests, build gates), capturing combined stdout+stderr and
 * honoring the run's AbortSignal. Shared by execute-epic and review-fix. See DESIGN §4.
 */
import { spawn } from "node:child_process";

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
