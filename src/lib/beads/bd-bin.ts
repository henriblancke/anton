/**
 * Resolve the `bd` binary to an absolute path for every server-side bd spawn (anton-346).
 *
 * beads is anton's work source of truth, spawned via `execFile("bd", …)` from bd.ts on hot job
 * paths (execute-epic, review-fix). A background-launched server whose PATH omits bd's install dir
 * would otherwise fail those spawns intermittently with `spawn bd ENOENT`, parking jobs mid-run.
 * Resolving once here — against PATH plus the common install locations — and spawning the absolute
 * path makes bd reliably invokable regardless of the launcher's PATH. See ../bin for the mechanics.
 */
import { resolveBin, type BinSpec } from "../bin";

/** Override: absolute path (or bare name) of the bd binary. Also used by tests to point at a fake. */
export const BD_BIN_ENV = "ANTON_BD_BIN";

const BD_SPEC: BinSpec = {
  name: "bd",
  envVar: BD_BIN_ENV,
  install: "https://github.com/gastownhall/beads",
};

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
 * Startup preflight: resolve bd up front so a server launched with a PATH that can't reach bd
 * FAILS LOUD at boot with a clear, actionable message — rather than booting and then parking jobs
 * mid-run with `spawn bd ENOENT`. Throws the resolution error on failure; returns the path on
 * success. Called from startRunner().
 */
export function preflightBd(): string {
  return resolveBdBin(true);
}

/** Test-only: drop the memoized path so an env override change takes effect on the next resolve. */
export function resetBdBinCache(): void {
  cached = undefined;
}
