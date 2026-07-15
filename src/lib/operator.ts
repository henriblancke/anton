/**
 * The human operator who owns this anton instance (anton-live-sync). Beads claims made by
 * anton's jobs are assigned to this identity so a shared board shows WHOSE pipeline holds each
 * bead. Machine-scoped, not project-scoped: ANTON_OPERATOR env wins, else the global git
 * user.name; undefined lets bd fall back to its own actor resolution ($USER).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cached: string | undefined | null = null; // null = not resolved yet

export async function resolveOperator(): Promise<string | undefined> {
  if (cached !== null) return cached;
  const fromEnv = process.env.ANTON_OPERATOR?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "user.name"], {
      timeout: 5_000,
    });
    cached = stdout.trim() || undefined;
  } catch {
    cached = undefined;
  }
  return cached;
}

/** Test hook: clear the memoized identity. */
export function resetOperatorCache(): void {
  cached = null;
}
