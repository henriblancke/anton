/**
 * Board mode: is this project's beads database embedded (a Dolt directory under `.beads/`, one
 * copy per machine) or served by a shared `dolt sql-server` that every machine connects to
 * (anton-4gd2)?
 *
 * The distinction drives real behaviour differences, not cosmetics:
 *
 *   - **Sync is meaningless in server mode** (anton-0tul). `bd dolt pull/push` exists to reconcile
 *     per-machine embedded copies through `refs/dolt/data` on a git remote. When everyone writes to
 *     one server there is nothing to reconcile, and the calls fail noisily: the pull executes ON THE
 *     SERVER, and the `dolt-sql-server` image ships no ssh client and no keys, so a `git+ssh://`
 *     remote is unreachable from there by construction.
 *
 *   - **Connection config is per-project, but the environment is per-process** (anton-ffmw.1).
 *     The mode, the connection target, the database USER and the TLS setting read here are what
 *     `bd-env.ts` uses to scope a bd spawn's environment — see that module for why inheriting them
 *     corrupts across projects.
 *
 * bd's own precedence is env > metadata.json > config.yaml. We deliberately read ONLY
 * `.beads/metadata.json`: it is per-directory, so it describes *this* project no matter which
 * process asks or what that process was launched with. Reading the environment instead would
 * reintroduce exactly the cross-project confusion this module exists to prevent.
 *
 * Absent/unreadable/unparseable metadata is reported as `embedded`. That is the historical
 * behaviour and the safe default: embedded mode syncs, and a spurious sync is noise, whereas
 * wrongly concluding "server" would silently disable a solo user's only propagation path.
 *
 * The parse itself lives in `config.mjs` — the same mode decides which team-config profile setup
 * enforces, and one reader means the CLI and the server can never disagree about what a project is.
 * This module owns the typed accessor and the per-process cache on top of it.
 */
import { readDoltMetadata } from "./config.mjs";

export type BoardMode = "embedded" | "server";

export interface BoardModeInfo {
  mode: BoardMode;
  /** Present only in server mode, and only when metadata.json carries them — used by preflight to
   * name the target in its failure message (anton-eg46) rather than saying "unreachable" alone. */
  host?: string;
  port?: number;
  database?: string;
  /** The configured database user. Also what scopes the password a bd spawn is given, so that a
   * per-project account can authenticate without the environment leaking across projects
   * (anton-ffmw.1 — see `bd-env.ts`). */
  user?: string;
  /** Whether this project's server requires TLS (`dolt_server_tls`), when it says so at all.
   * Undefined means "not declared" — the ambient `BEADS_DOLT_SERVER_TLS` is inherited then, and
   * only then (`bd-env.ts`). */
  tls?: boolean;
}

/**
 * Cache keyed by repo path. Mode is fixed for a process: switching it means editing
 * `.beads/metadata.json`, which is a deliberate act followed by a restart. Caching keeps the
 * read off the hot path — `readBoardMode` is consulted on every bd spawn and every sync pass.
 *
 * Held on `globalThis` for the same reason as the sync-status registry: the instrumentation-started
 * sync engine and Next.js route handlers can load different compiled instances of this module, and
 * a plain module-level Map would leave one of them re-reading the file forever.
 */
const CACHE = Symbol.for("anton.beads.boardMode");
type CacheHolder = { [CACHE]?: Map<string, BoardModeInfo> };

function cache(): Map<string, BoardModeInfo> {
  const holder = globalThis as CacheHolder;
  return (holder[CACHE] ??= new Map());
}

/** Drop cached modes. Tests only — production mode is fixed for the life of the process. */
export function resetBoardModeCache(): void {
  cache().clear();
}

/**
 * The board mode for `repoPath`, read from `<repoPath>/.beads/metadata.json`.
 *
 * Never throws: a missing file, a directory without `.beads/`, malformed JSON, or an unrecognised
 * `dolt_mode` all resolve to `embedded`. Callers gate behaviour on this, so a parse error must not
 * take down a board write.
 */
export function readBoardMode(repoPath: string): BoardModeInfo {
  const hit = cache().get(repoPath);
  if (hit) return hit;

  const { mode, host, port, database, user, tls } = readDoltMetadata(repoPath);
  // Connection fields are dropped on an embedded board: they describe a server there is none of,
  // and callers read their presence as "this is where the board lives".
  const info: BoardModeInfo = mode === "server" ? { mode, host, port, database, user, tls } : { mode: "embedded" };

  cache().set(repoPath, info);
  return info;
}

/** Convenience predicate for the many call sites that only branch on server-vs-not. */
export function isServerMode(repoPath: string): boolean {
  return readBoardMode(repoPath).mode === "server";
}
