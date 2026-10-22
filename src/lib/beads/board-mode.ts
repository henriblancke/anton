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
 * This module owns the typed accessor and the metadata-stamped cache on top of it.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { configYamlValue } from "./config.mjs";
import { readDoltMetadata } from "./config.mjs";
import { readMetadataFile } from "./server-mode.mjs";

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
 * Cache keyed by repo path, invalidated by the identity of `.beads/metadata.json` itself.
 *
 * Caching keeps the read off the hot path — `readBoardMode` is consulted on every bd spawn and
 * every sync pass. It may NOT outlive the file: these fields decide which password a bd spawn is
 * given and whether it speaks TLS (`bd-env.ts`), and correcting a wrong host, user or transport in
 * metadata.json is exactly how an operator recovers from a bad connection. A cache pinned for the
 * life of the process would keep authenticating for the old account against the old transport while
 * bd itself reads the corrected file — a mismatch curable only by a restart nobody documented
 * (PR #174 review). Stamping instead means the very next read picks the correction up.
 *
 * Held on `globalThis` for the same reason as the sync-status registry: the instrumentation-started
 * sync engine and Next.js route handlers can load different compiled instances of this module, and
 * a plain module-level Map would leave one of them re-reading the file forever.
 */
const CACHE = Symbol.for("anton.beads.boardMode");
type CacheEntry = { info: BoardModeInfo; stamp: string };
type CacheHolder = { [CACHE]?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  const holder = globalThis as CacheHolder;
  return (holder[CACHE] ??= new Map());
}

/** A stamp no real file can produce, so a pinned entry survives every edit (see {@link pinBoardMode}). */
const PINNED = "pinned";

/**
 * Identity of `<repoPath>/.beads/metadata.json` as one comparable string: inode, size and
 * nanosecond mtime, so a rewrite that preserves any one of them still reads as a change. A stat is
 * far cheaper than the read-and-parse it guards, which is what keeps this affordable per bd spawn.
 *
 * An absent or unreadable file stamps as `absent` rather than throwing — creating one later is a
 * change like any other, and the read that follows resolves to `embedded` on its own terms.
 */
function metadataStamp(repoPath: string): string {
  try {
    const s = statSync(join(repoPath, ".beads", "metadata.json"), { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    return "absent";
  }
}

/** Drop cached modes, pins included. Tests only — production entries expire off the file's stamp. */
export function resetBoardModeCache(): void {
  cache().clear();
}

/**
 * Pin what `readBoardMode` answers for `repoPath`, ignoring metadata.json until
 * {@link resetBoardModeCache}.
 *
 * Tests only, and only for the one thing the file cannot express: a board anton must believe lives
 * on a shared server while the bd it spawns keeps talking to the embedded board CI actually has
 * (`execute-epic.server-mode.integration.test.ts`). Simulating that by flipping the file relied on
 * the cache never noticing the flip back — the exact staleness this module now refuses to have.
 */
export function pinBoardMode(repoPath: string, info: BoardModeInfo): void {
  cache().set(repoPath, { info, stamp: PINNED });
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
  if (hit?.stamp === PINNED) return hit.info;
  const stamp = metadataStamp(repoPath);
  if (hit && hit.stamp === stamp) return hit.info;

  const { mode, host, port, database, user, tls } = readDoltMetadata(repoPath);
  // Connection fields are dropped on an embedded board: they describe a server there is none of,
  // and callers read their presence as "this is where the board lives".
  const info: BoardModeInfo = mode === "server" ? { mode, host, port, database, user, tls } : { mode: "embedded" };

  cache().set(repoPath, { info, stamp });
  return info;
}

/** Convenience predicate for the many call sites that only branch on server-vs-not. */
export function isServerMode(repoPath: string): boolean {
  return readBoardMode(repoPath).mode === "server";
}

/**
 * Whether `repoPath`'s board connection is anything other than a PROVEN embedded board (originally
 * `boardConnectionUnproven`, review-gate.ts, PR #284 review round 18, "Deny Bash instead of only the
 * bd command prefix"; hoisted here so every fail-closed consumer — not just the review gate's tool
 * denial — shares one classification).
 *
 * `isServerMode` alone is not enough for a caller that must fail closed: it reads a
 * missing/unreadable/malformed `.beads/metadata.json` as `embedded` (the safe default for sync — see
 * this module's own docstring), which is exactly wrong for a caller deciding whether it is safe to
 * assume no server exists. Only an EXPLICIT `"dolt_mode": "embedded"` counts as proof; anything else
 * — absent, unreadable, or a `{}`/unrecognised `dolt_mode` that `readDoltMetadata` also defaults to
 * embedded — falls through to checking whether the COMMITTED `.beads/config.yaml` still declares a
 * server connection. `configureServerMode`'s switch flow (server-mode.mjs, `publishedConfigWrites`)
 * publishes the server's host, port, database and user into that file, so a clone with metadata.json
 * missing or unreadable can still have `bd` connect from config.yaml alone (bd's own precedence is
 * env > metadata.json > config.yaml, so config.yaml is consulted whenever the higher sources are
 * silent).
 */
export function boardConnectionUnproven(repoPath: string): boolean {
  const meta = readMetadataFile(repoPath);
  if (meta.status === "read" && meta.raw?.dolt_mode === "embedded") return false;
  const beadsDir = join(repoPath, ".beads");
  return ["dolt.host", "dolt.port", "dolt.database", "dolt.user"].some(
    (key) => configYamlValue(beadsDir, key) !== undefined,
  );
}

/**
 * The fail-closed predicate for anything that must not treat an unreadable/ambiguous board as safely
 * embedded — a confirmed server, OR a connection this project's own files cannot prove is embedded.
 * `undefined` (no repo to check) reads as "cannot reach a server", the same as every other
 * `repoPath === undefined` guard in these call sites.
 *
 * One shared classification for every consumer that denies capability based on it: `reviewDeniedTools`
 * (review-gate.ts) denying `Bash` outright, and `review-context.ts` deciding whether the reviewer gets
 * a live `bd -C <repoPath>` instruction or anton's own host-side confirmed-bead snapshot. Two separate
 * `isServerMode`-only checks answering that question drift apart the moment one of them is hardened —
 * exactly what happened before this predicate existed (chatgpt-codex-connector, PR #284 review, "Use
 * the fail-closed board mode when supplying review evidence"): `reviewDeniedTools` denied Bash while
 * `boardEvidenceSection` still told a board-only reviewer to reach for the very tool it was denied.
 */
export function mayReachServerBoard(repoPath: string | undefined): boolean {
  return repoPath !== undefined && (isServerMode(repoPath) || boardConnectionUnproven(repoPath));
}
