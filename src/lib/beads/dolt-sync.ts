/**
 * One Dolt sync pass and the shared-server preflight that guards it (anton-lsad).
 *
 * ./dolt-exec owns the bd spawn; this module owns the one thing anton does with it on a schedule:
 * classify bd's sync output, probe a shared server before a read-only pass, and execute
 * pull → commit → push. ./sync-coalescer decides WHEN a pass runs and imports the pass from here;
 * ./bd re-exports the public surface. Neither imports back, so each side is testable alone.
 */
import { passwordVarHint } from "./bd-env";
import { isServerMode, readBoardMode, type BoardModeInfo } from "./board-mode";
import { BOARD_READ_PROBE, formatServerTarget } from "./config.mjs";
import { bd, type BdExec } from "./dolt-exec";

// ── Dolt sync: push every bd write to the remote explicitly (anton-nyf) ──
//
// refs/dolt/data only moves when `bd dolt push` runs; git hooks are per-machine and don't fire
// for anton's own writes, so every write path syncs explicitly through here.

/**
 * Benign sync outcomes that must NOT fail a sync: a clean working set ("Nothing to commit.")
 * and a workspace with no Dolt remote ("No remote is configured — skipping."). Current bd exits
 * 0 for both; the matcher keeps sync tolerant if a bd version turns them into errors.
 */
const BENIGN_SYNC_OUTPUT = [/nothing to commit/i, /no remotes? (?:is )?configured/i];

export function isBenignSyncOutput(output: string): boolean {
  return BENIGN_SYNC_OUTPUT.some((re) => re.test(output));
}

/**
 * A workspace with no Dolt remote — not an error, but a distinct visible state (not-wired): the
 * board must show "not wired to a shared remote" rather than pretending it's synced.
 *
 * bd words the SAME condition differently per verb: `dolt push` prints "No remote is configured —
 * skipping.", while `dolt pull` fails with dolt's own `fetch from origin/main: Error 1105: no
 * remote`. Matching only the push wording left a solo board reading as `failing` on every heartbeat
 * pull, and would have failed a verified claim closed on a board that has no second machine to race
 * (anton-9anc). The pull pattern is deliberately strict — the whole `fetch from <ref>: Error <n>: no
 * remote` shape, and it must END the line, so a genuine fetch failure that merely starts that way
 * ("… no remote branch found") can't be read as "this workspace has no remote".
 */
const NOT_WIRED_OUTPUT = [
  /no remotes? (?:is )?configured/i,
  /fetch from \S+: Error \d+: no remote\s*$/im,
];

export function isNotWiredOutput(output: string): boolean {
  return NOT_WIRED_OUTPUT.some((re) => re.test(output));
}

/**
 * The ONLY `bd dolt pull` failure that is benign: a never-pushed remote has no refs/dolt/data yet,
 * so the first pull finds no dolt branches on the remote ("no branches found in remote", or on some
 * git backends "couldn't find remote ref"). In a full pass the push that follows publishes it; on a
 * heartbeat it just means "nothing to pull yet" and must NOT mark the project failing. Every OTHER
 * pull failure (auth, network, unreachable remote, dirty local state, real divergence) must reject —
 * in a full pass, before push — or a pass that never applied inbound changes could still be recorded
 * as "synced" whenever the trailing push happens to be a no-op (anton-live-sync review).
 */
const FIRST_PUBLISH_PULL_OUTPUT = [
  /no branches found in remote/i,
  /(?:could ?n['’]t|could not) find remote ref/i,
  /remote ref .*does not exist/i,
];

export function isFirstPublishPullOutput(output: string): boolean {
  return FIRST_PUBLISH_PULL_OUTPUT.some((re) => re.test(output));
}

// ── The pass's shape ──
//
// SyncMode/SyncOutcome describe what runDoltSync does, so they live with it rather than with the
// coalescer that picks between them (anton-n1m0). ./sync-coalescer re-exports both, and ./bd
// re-exports them from here, so every existing import site is unchanged.

/**
 * Concrete sync passes runDoltSync executes. "full" (write-nudged): pull → commit → push.
 * "pull": pull only — the heartbeat's default, which must NOT push when there are no local
 * changes; every anton instance pushing a shared remote every ~10s is the concurrent-push
 * manifest-corruption pattern (beads GH#2466).
 */
export type SyncMode = "full" | "pull";

export type SyncOutcome = "synced" | "not-wired" | "shared-server";

/**
 * Server-mode preflight (anton-eg46). Runs {@link PREFLIGHT_PROBES} — the connection test AND a board
 * read — at most once per {@link PREFLIGHT_TTL_MS} per repo, on the sync pass that would otherwise
 * have run, and throws an actionable error when this machine cannot use the board. Carried only by
 * passes with no board write of their own behind them
 * — the heartbeat and the read-freshness pulls; see `probeServer` on {@link runDoltSync} for why a
 * post-write pass must not add this second failure boundary.
 *
 * Why it belongs here rather than at boot: it piggybacks on the heartbeat, so the failure lands in
 * the sync-status registry the operator is already watching, and a server that comes back up is
 * picked up on the next beat without a restart.
 *
 * Why the message names the host/port/database: the raw failure does not. A blocked direnv approval
 * (which silently drops BEADS_DOLT_*) produced this, which names neither the configured target nor
 * the real cause, and sends the reader off installing Dolt they do not need:
 *
 *   Dolt server unreachable at 127.0.0.1:0 and auto-start failed:
 *   dolt is not installed (not found in PATH)
 */
/**
 * Versioned because the registry's SHAPE changed (PR #174 review): the previous implementation
 * stored a `Set<string>` under the unversioned `anton.beads.preflight`. `Symbol.for` is
 * process-global and outlives module replacement, so under a Next.js dev hot reload this module
 * would adopt that Set and the first heartbeat would die on `.get is not a function`. A new key
 * makes the old value unreachable instead of mistyped; bump it again if the value shape changes.
 */
const PREFLIGHTED_KEY = Symbol.for("anton.beads.preflight.v2");

/**
 * How long a successful probe stands in for the server being up.
 *
 * A success EXPIRES rather than being remembered forever (PR #174 review): in server mode the
 * preflight is the only thing the heartbeat does, so a permanently-cached pass means an outage
 * after startup never reaches the sync-status registry — the UI keeps reporting a healthy shared
 * board until some unrelated board operation happens to fail. Five minutes bounds that blind spot
 * while keeping the probes off the ~10s beat (one round per repo per five minutes).
 */
export const PREFLIGHT_TTL_MS = 5 * 60_000;

/** A successful probe: when it landed (epoch ms) and which server it proved reachable. */
type Preflighted = { at: number; server: string };

/**
 * Each repo's last SUCCESSFUL probe.
 *
 * Anchored on `globalThis` for the same cross-bundle reason as the status registry above: a route
 * handler bundle and the instrumentation-started sync engine each load their own compiled copy of
 * this module, and a plain module-level Map would give each one its own — turning "once per TTL"
 * into "once per TTL per bundle" and re-running `bd dolt test` for every one of them.
 */
function preflightedAt(): Map<string, Preflighted> {
  const g = globalThis as unknown as Record<symbol, Map<string, Preflighted> | undefined>;
  return (g[PREFLIGHTED_KEY] ??= new Map());
}

/**
 * Everything about the configured target a probe's result is only valid for — host, port, database,
 * account and transport, which is exactly what `bd dolt test` exercises (`bd-env.ts` scopes the
 * spawn by the same fields).
 *
 * The repo path alone is NOT that key (PR #174 review): correcting metadata.json from one server to
 * another is how an operator recovers from a bad connection, and a cache keyed on the path would
 * keep reporting the OLD server's pass for up to a TTL — vouching for a target nothing has probed
 * while `readBoardMode` has already picked the correction up.
 */
function serverIdentity(board: BoardModeInfo): string {
  return JSON.stringify([board.host, board.port, board.user, board.database, board.tls]);
}

/** Tests only — production expires probes on the TTL by design. */
export function resetServerPreflight(): void {
  preflightedAt().clear();
}

/**
 * The two probes, in order, with the message each failure needs. `bd dolt test` answers only "the
 * server accepted a connection" — it names no database and reads nothing — so a preflight that
 * stopped there would keep the sync status at `shared-server` while every board operation fails on a
 * `dolt_database` that is missing, unmigrated, or another project's (bd's identity guard: `PROJECT
 * IDENTITY MISMATCH — refusing to connect`). The board read is what closes that (PR #174 review),
 * and it is the same one the CLI's gate uses ({@link checkSharedServer}), so the heartbeat and
 * `anton doctor` cannot disagree about whether this board works.
 */
const PREFLIGHT_PROBES = [
  {
    args: ["dolt", "test"],
    message: (cwd: string, target: string) =>
      `shared Dolt server unreachable for ${cwd} (configured target ${target}). ` +
      `Check the server is up and reachable, that .beads/metadata.json names the right ` +
      `host/port/user, and that this project's password is set in this process — ` +
      `${passwordVarHint(cwd)} — or set dolt_mode back to "embedded" to work from the local copy.`,
  },
  {
    args: BOARD_READ_PROBE,
    message: (cwd: string, target: string) =>
      `shared Dolt server ${target} accepted the connection but will not serve the board for ${cwd}. ` +
      `Check that .beads/metadata.json names the database this project's board actually lives in, ` +
      `that its database account may read it, and that the board has been copied onto the server — ` +
      `or set dolt_mode back to "embedded" to work from the local copy.`,
  },
] as const;

export async function preflightSharedServer(cwd: string, exec: BdExec = bd): Promise<void> {
  const board = readBoardMode(cwd);
  const server = serverIdentity(board);
  const last = preflightedAt().get(cwd);
  if (last !== undefined && last.server === server && Date.now() - last.at < PREFLIGHT_TTL_MS) return;
  const target = formatServerTarget(board);
  for (const probe of PREFLIGHT_PROBES) {
    try {
      await exec(cwd, [...probe.args]);
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string };
      const output = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim() || err.message;
      throw new Error(`${probe.message(cwd, target)} Underlying error: ${output}`, { cause: e });
    }
  }
  // Stamped only after BOTH probes pass, so a server that was down — or a board it would not serve —
  // is retried on the next beat rather than waiting out a TTL it never earned.
  preflightedAt().set(cwd, { at: Date.now(), server });
}

/**
 * One sync pass. Full mode: `bd dolt pull` (remote changes land locally, and pull-before-push
 * shrinks divergence windows), then `bd dolt commit` (a no-op under dolt.auto-commit, but
 * catches externally-made changes), then `bd dolt push`. Pull mode runs only the pull.
 *
 * Outcomes: benign steps are skipped; a workspace with no remote resolves "not-wired" and stops
 * the pass. A pull failure in FULL mode is tolerated (a never-pushed remote has no refs/dolt
 * yet — the push that follows publishes it); a real commit/push failure (auth, network, remote
 * conflict) rejects with the bd output attached — callers surface it, never swallow it.
 * `exec` is injectable for tests.
 *
 * No explicit `bd recompute-blocked` here: bd 1.1.0 recomputes the denormalized `is_blocked` flag
 * automatically on every pull, scoped to what the merge changed, so `bd ready` never reads a stale
 * flag on the hot sync path. The unconditional repair (`bd recompute-blocked`) is reserved for the
 * places that gap can't reach — a freshly bootstrapped clone that never ran a local merge (see
 * configureBeadsForRepo in config.mjs) — rather than paid on every heartbeat pull.
 *
 * `probeServer` gates the server-mode health probe, and must be FALSE for a pass that follows this
 * caller's own board write (PR #174 review). On a shared server the write IS the publication — it
 * landed on the one database the moment bd committed it — so callers like `publishLease` and the
 * step-3c claim publish await this pass only to confirm delivery that already happened. Probing
 * there adds a SECOND, independent failure boundary after a successful write: a blip between the
 * write and `bd dolt test` rejects the pass, and the caller reads that as "the lease/claim never
 * published" and fails the run closed over a mutation every other machine can already see. The
 * probe belongs on the passes with no write to vouch for them — the heartbeat and the read-
 * freshness pulls — which is where anton-eg46's fail-loud lands anyway.
 */
export async function runDoltSync(
  cwd: string,
  exec: BdExec = bd,
  mode: SyncMode = "full",
  probeServer = true,
): Promise<SyncOutcome> {
  // Server mode: there is nothing to reconcile, so this resolves without spawning bd at all
  // (anton-0tul). Every writer is already on the one database, and the pull/push would run ON THE
  // SERVER, which has no ssh client or keys and therefore cannot reach a git+ssh remote. Left
  // enabled it fails on every heartbeat:
  //   Error: failed to pull from origin/main: Error 1105 (HY000): command denied to user
  // Distinct from "not-wired": that means a board with no propagation path and is worth surfacing;
  // this means propagation is inherent and there is nothing to report.
  if (isServerMode(cwd)) {
    if (probeServer) await preflightSharedServer(cwd, exec);
    return "shared-server";
  }

  const steps =
    mode === "pull"
      ? [["dolt", "pull"]]
      : [
          ["dolt", "pull"],
          ["dolt", "commit"],
          ["dolt", "push"],
        ];
  for (const args of steps) {
    try {
      await exec(cwd, args);
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string };
      const output = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim() || err.message;
      if (isNotWiredOutput(output)) return "not-wired";
      if (isBenignSyncOutput(output)) continue;
      // A pull tolerates ONLY the first-publish case (a never-pushed remote has no dolt branches
      // yet): in a full pass the push that follows publishes them; on a heartbeat it's just
      // "nothing to pull yet". Any OTHER pull failure (auth, network, unreachable remote, dirty
      // local state, real divergence) rejects here — in a full pass, before push — so a pass that
      // never applied inbound changes is never silently recorded as "synced" on a no-op push.
      if (args[1] === "pull" && isFirstPublishPullOutput(output)) continue;
      throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${output}`, { cause: e });
    }
  }
  return "synced";
}
