/**
 * Resolve the `bd` binary to an absolute path for every server-side bd spawn (anton-346).
 *
 * beads is anton's work source of truth, spawned via `execFile("bd", …)` from bd.ts on hot job
 * paths (execute-epic, review-fix). A background-launched server whose PATH omits bd's install dir
 * would otherwise fail those spawns intermittently with `spawn bd ENOENT`, parking jobs mid-run.
 * Resolving once here — against PATH plus the common install locations — and spawning the absolute
 * path makes bd reliably invokable regardless of the launcher's PATH. See ../bin for the mechanics.
 */
import { spawnSync } from "node:child_process";
import { resolveBin, type BinSpec } from "../bin";

/** Override: absolute path (or bare name) of the bd binary. Also used by tests to point at a fake. */
export const BD_BIN_ENV = "ANTON_BD_BIN";

const BD_SPEC: BinSpec = {
  name: "bd",
  envVar: BD_BIN_ENV,
  install: "https://github.com/gastownhall/beads",
};

/** The floor bd version anton requires (anton-qwsq). See config.mjs MIN_BD_VERSION for the why. */
export const MIN_BD_VERSION = "1.1.0";
const MIN_BD = { major: 1, minor: 1, patch: 0 };

/** A `bd --version` runner, injectable for tests. */
export type VersionRun = (bin: string) => { status: number | null; stdout?: string; stderr?: string; error?: unknown };

/** Parse a `bd --version` line into `{ major, minor, patch }`, or null when no version is present. */
export function parseBdVersion(output: string): { major: number; minor: number; patch: number } | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * Throw a loud, actionable error when the bd at `bin` is older than MIN_BD_VERSION or its version
 * can't be read. Called by the startup preflight so a server on an unsupported bd refuses to boot
 * rather than limping on and, worse, risking the remote-backed schema fork the 1.1.0 upgrade guards
 * against. `run` is injectable for tests.
 */
export function assertBdVersion(
  bin: string,
  run: VersionRun = (b) => spawnSync(b, ["--version"], { encoding: "utf8" }),
): void {
  const guidance = `Upgrade bd (${BD_SPEC.install}); for a remote-backed board follow docs/runbooks/bd-1.0.4-to-1.1.0-migration.md.`;
  let r: ReturnType<VersionRun>;
  try {
    r = run(bin);
  } catch {
    r = { status: 1 };
  }
  const v = r.error || (r.status ?? 1) !== 0 ? null : parseBdVersion(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!v) {
    throw new Error(`Could not read the bd version from ${bin} (\`bd --version\`). anton requires bd >= ${MIN_BD_VERSION}. ${guidance}`);
  }
  const ok = v.major !== MIN_BD.major ? v.major > MIN_BD.major : v.minor !== MIN_BD.minor ? v.minor > MIN_BD.minor : v.patch >= MIN_BD.patch;
  if (!ok) {
    throw new Error(`bd ${v.major}.${v.minor}.${v.patch} at ${bin} is too old — anton requires bd >= ${MIN_BD_VERSION}. ${guidance}`);
  }
}

let cached: string | undefined;

/**
 * Absolute path to the bd binary, resolved once and cached (bd is spawned on hot paths, so we
 * don't re-stat per call). Throws with actionable guidance when bd can't be found. Pass
 * `force` to bypass the cache — the startup preflight does, so a fresh boot re-resolves.
 */
export function resolveBdBin(force = false): string {
  if (force || cached === undefined) cached = resolveBin(BD_SPEC);
  return cached;
}

/**
 * Startup preflight: resolve bd up front AND enforce the minimum version (anton-qwsq), so a server
 * launched with a PATH that can't reach bd — or an unsupported older bd — FAILS LOUD at boot with a
 * clear, actionable message, rather than booting and then parking jobs mid-run (`spawn bd ENOENT`)
 * or running against a bd that lacks the 1.1.0 behavior anton depends on. Throws on failure; returns
 * the resolved path on success. Called from startRunner().
 */
export function preflightBd(): string {
  const bin = resolveBdBin(true);
  assertBdVersion(bin);
  return bin;
}

/** Test-only: drop the memoized path so an env override change takes effect on the next resolve. */
export function resetBdBinCache(): void {
  cached = undefined;
}
