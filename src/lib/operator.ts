/**
 * The human operator who owns this anton instance (anton-live-sync). Beads claims made by
 * anton's jobs are assigned to this identity so a shared board shows WHOSE pipeline holds each
 * bead. Machine-scoped, not project-scoped: ANTON_OPERATOR env wins, else the global git
 * user.name, else the OS user ($USER / $USERNAME).
 *
 * Why resolve the $USER fallback here rather than returning undefined (anton-g3v): claims pass
 * this value as the explicit BEADS_ACTOR, so whatever we return IS the assignee bd stamps. If we
 * returned undefined, bd would still stamp a non-empty assignee from ITS own fallback (the same
 * `git user.name, $USER` chain) — and review-fix's ownership filter, comparing that assignee
 * against `undefined`, would then reject the very PRs this instance created. Resolving the final
 * fallback ourselves keeps the claim actor and the ownership identity in lockstep. undefined is
 * returned only when even $USER is unset (no OS user at all), which the ownership check tolerates.
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
  cached = (await gitGlobalUserName()) ?? osUser();
  return cached;
}

/** Global (machine-scoped) git user.name, or undefined when unset/unreadable. */
async function gitGlobalUserName(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "user.name"], {
      timeout: 5_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** bd's final actor fallback: the OS user ($USER on POSIX, $USERNAME on Windows). */
function osUser(): string | undefined {
  return process.env.USER?.trim() || process.env.USERNAME?.trim() || undefined;
}

/** Test hook: clear the memoized identity. */
export function resetOperatorCache(): void {
  cached = null;
}
