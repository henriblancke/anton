/**
 * Resolve external CLI binaries to an ABSOLUTE path for the server's own spawns (anton-346).
 *
 * A background-launched anton server (launchd / systemd / nohup) inherits a minimal PATH — often
 * just `/usr/bin:/bin` — that omits the user-local and package-manager bin dirs where tools like
 * `bd` are installed (`~/.local/bin`, `~/go/bin`, homebrew, …). So a bare `execFile("bd", …)`,
 * which resolves against that PATH, fails intermittently with `spawn bd ENOENT` even though an
 * interactive shell resolves it fine. We resolve the binary once against an AUGMENTED search path
 * (PATH + the common install locations a login shell would have) and spawn the absolute path
 * thereafter. An explicit `ANTON_<NAME>_BIN` override wins, for pinned installs and tests.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** True when `p` is a regular file the process can execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories anton searches IN ADDITION to PATH — the common user-local and package-manager
 * install locations a login shell has but a daemon's minimal PATH omits. This is what lets a
 * background-launched server find `bd` in `~/.local/bin` even when its PATH is `/usr/bin:/bin`.
 */
export function extraBinDirs(home = homedir()): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, "go", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/**
 * First absolute path to an executable named `name` across `searchPath` (a PATH-style string)
 * then `extraDirs`, or undefined when none resolves. Earlier dirs win; duplicates are skipped.
 * `isExec` is injectable for tests.
 */
export function findOnPath(
  name: string,
  searchPath: string,
  extraDirs: string[] = [],
  isExec: (p: string) => boolean = isExecutableFile,
): string | undefined {
  const dirs = [...searchPath.split(delimiter), ...extraDirs].filter(Boolean);
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (isExec(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/** A CLI anton spawns and must resolve reliably. */
export interface BinSpec {
  /** Command name as it appears on PATH, e.g. "bd". */
  name: string;
  /** Env var that pins an absolute path (or a bare name to resolve), e.g. "ANTON_BD_BIN". */
  envVar: string;
  /** Actionable install guidance appended to the not-found error. */
  install: string;
}

export interface ResolveBinOptions {
  /** Environment to read the override + PATH from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  extraDirs?: string[];
  isExec?: (p: string) => boolean;
}

/**
 * Resolve `spec.name` to an absolute path, honoring the `spec.envVar` override. Throws a clear,
 * actionable error when it can't be resolved — callers surface it (a startup preflight refuses to
 * boot; a spawn fails loud) rather than letting a bare-name spawn park a job with `ENOENT`.
 *
 * An override that names a real executable wins (absolute path used directly; a bare name is itself
 * resolved on the augmented path). An override that resolves to nothing is a hard error — silently
 * falling back to PATH would reintroduce the very unreliability the override exists to pin down.
 */
export function resolveBin(spec: BinSpec, opts: ResolveBinOptions = {}): string {
  const env = opts.env ?? process.env;
  const isExec = opts.isExec ?? isExecutableFile;
  const extraDirs = opts.extraDirs ?? extraBinDirs();
  const searchPath = env.PATH ?? "";

  const override = env[spec.envVar]?.trim();
  if (override) {
    if (isAbsolute(override)) {
      if (isExec(override)) return override;
    } else {
      const resolved = findOnPath(override, searchPath, extraDirs, isExec);
      if (resolved) return resolved;
    }
    throw new Error(
      `${spec.envVar}=${override} does not point at an executable ${spec.name} binary. ` +
        `Set it to the absolute path of ${spec.name}, or unset it to resolve ${spec.name} on PATH.`,
    );
  }

  const resolved = findOnPath(spec.name, searchPath, extraDirs, isExec);
  if (resolved) return resolved;
  throw new Error(
    `Could not resolve the '${spec.name}' binary. The anton server was likely launched with a ` +
      `minimal PATH that omits where ${spec.name} is installed. ` +
      `Install ${spec.name} (${spec.install}), or set ${spec.envVar} to its absolute path ` +
      `(e.g. ${spec.envVar}=$(command -v ${spec.name})).`,
  );
}
