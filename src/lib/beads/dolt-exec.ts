/**
 * The `bd` exec seam and the one sync pass it runs.
 *
 * The seam this module exists to keep one-way (anton-n1m0): the coalescer in ./sync-coalescer owns
 * WHEN a pass runs — per-repo coalescing, the backstop's mode resolution, the stall window — and
 * this module owns HOW one runs: spawning bd, classifying its output, and executing pull → commit →
 * push. Both ./bd and ./sync-coalescer import from here and neither is imported back, so each side
 * is testable without the other.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveBdBin } from "./bd-bin";
import { buildBdEnv, passwordVarHint } from "./bd-env";
import { BOARD_READ_PROBE, formatServerTarget } from "./config.mjs";
import { isServerMode, readBoardMode, type BoardModeInfo } from "./board-mode";

/**
 * Wall-clock budget for ONE `bd` invocation. Note what it does NOT bound: it is a per-step budget,
 * so a full sync pass (pull → commit → push) may legitimately spend 3× it. Callers that need a
 * bounded PASS must add their own deadline on top (see beatDeadlineMs in sync-engine.ts).
 */
export const BD_STEP_TIMEOUT_MS = 60_000;

/** Override the per-step budget (tests shrink it; also an ops escape hatch). Read per call so a
 * change lands without a module reload. */
export const BD_STEP_TIMEOUT_ENV = "ANTON_BD_STEP_TIMEOUT_MS";

/** Override the SIGTERM→SIGKILL grace (tests shrink it). Read per call. */
export const BD_KILL_GRACE_ENV = "ANTON_BD_KILL_GRACE_MS";

/**
 * How long a bd that blew its budget gets to unwind on SIGTERM before SIGKILL. bd traps SIGTERM to
 * release the exclusive Dolt lock, so the polite signal comes first — but a bd that then blocks on
 * its own wedged `git fetch` survived that SIGTERM in the field for days, so the escalation is
 * mandatory, not optional (anton-jfjw.1).
 */
const DEFAULT_BD_KILL_GRACE_MS = 5_000;

/**
 * How long to keep draining stdio after bd exits. `close` is the only event that guarantees the
 * pipes drained, but a grandchild that inherited them holds them open long after bd is gone — and
 * waiting on it is exactly what left the caller's promise pending for days while a heartbeat sat
 * wedged. So `exit` starts a bounded drain and the promise settles either way. A normal bd exits
 * with nothing else holding the pipes, so `close` lands immediately and this never comes into play.
 */
const DRAIN_AFTER_EXIT_MS = 2_000;

/** Output ceiling per stream, carried over from the execFile `maxBuffer` this replaced: a runaway
 * stream is killed rather than grown until the server OOMs. A whole-board `bd list --json` is
 * comfortably under it. */
const BD_MAX_BUFFER = 32 * 1024 * 1024;

/** Override the per-stream output ceiling (tests shrink it so the overflow path is exercisable
 * without producing 32 MB). Read per call, like the budget and the kill grace. */
export const BD_MAX_BUFFER_ENV = "ANTON_BD_MAX_BUFFER";

function stepTimeoutMs(): number {
  const raw = Number(process.env[BD_STEP_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_STEP_TIMEOUT_MS;
}

function maxBuffer(): number {
  const raw = Number(process.env[BD_MAX_BUFFER_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_MAX_BUFFER;
}

function killGraceMs(): number {
  const raw = Number(process.env[BD_KILL_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BD_KILL_GRACE_MS;
}

/** Per-invocation knobs for {@link bd}: extra env, and stdin for the commands that read it. */
export interface BdOpts {
  /** Merged over `process.env` (e.g. BEADS_ACTOR for an attributed write). An `undefined` value
   * REMOVES the variable rather than inheriting the server's — see `bd-env.ts`'s `buildBdEnv`. */
  env?: Record<string, string | undefined>;
  /** Written to bd's stdin, which is then closed. Required by `bd batch`, which reads its
   * commands from stdin — without it bd would block on an open pipe until the step budget. */
  stdin?: string;
}

/**
 * Run one `bd` command and return its stdout.
 *
 * Two properties this owes its callers, both learned the hard way (anton-jfjw.1 — a `bd dolt pull`
 * whose `git fetch` entered uninterruptible wait when the network died under it, leaving the parent
 * alive for two days, the Dolt lock held, and anton's heartbeat pinned forever):
 *
 * 1. **The reap targets the process group.** bd's own git/dolt children are what actually wedge, and
 *    signalling only bd leaves them running — still holding the exclusive Dolt lock that then fails
 *    every later `bd list` in that repo. So bd leads its own group and the budget kills the group,
 *    escalating SIGTERM → SIGKILL.
 * 2. **The promise settles on `exit`, not on stdio `close`.** A leaked grandchild holds the inherited
 *    pipes open, so `close` may never fire; and past the budget the caller is released immediately —
 *    the reap runs on in the background, because a grandchild in uninterruptible wait can survive
 *    even SIGKILL and must not be able to hold a caller hostage while it does.
 *
 * `async` so a resolveBdBin() failure (no bd on the box) surfaces as a rejection rather than a
 * synchronous throw — every call site awaits or `.catch()`es this.
 *
 * Exported for ./bd, which wraps it as the `beads` verb seam; nothing outside this directory
 * spawns bd directly.
 */
export async function bd(cwd: string, args: string[], opts?: BdOpts): Promise<string> {
  // Spawn bd by its resolved absolute path (anton-346): a background-launched server's PATH may not
  // reach bd's install dir, so a bare `spawn("bd", …)` fails with `spawn bd ENOENT`.
  const bin = resolveBdBin();
  const budgetMs = stepTimeoutMs();
  const bufferLimit = maxBuffer();
  const startedAt = Date.now();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // POSIX: make bd the leader of a new process group so the whole tree is reachable as one.
      detached: process.platform !== "win32",
      // Always built through buildBdEnv, even with no overrides: it is what strips the
      // project-scoped BEADS_DOLT_* that would otherwise route this call at another project's
      // database, and what narrows the password to THIS project's user (anton-ffmw.1).
      env: buildBdEnv(cwd, opts?.env ?? {}),
    });

    if (opts?.stdin !== undefined) {
      // EPIPE is expected whenever bd rejects its input and exits before draining the pipe (a batch
      // whose first line is malformed): the exit code carries the verdict, so the write error is
      // noise. Ignoring it keeps the real failure — bd's own stderr — as the one the caller sees.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }

    // StringDecoder, not per-chunk toString: a multi-byte character split across two chunks would
    // otherwise corrupt the JSON every read path parses.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // The group may never have formed (spawn failed, or the leader is already reaped) — fall
          // back to the direct child handle so the reap still reaches bd itself.
        }
      }
      child.kill(sig);
    };

    const settle = (emit: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      if (drainTimer) clearTimeout(drainTimer);
      emit();
    };

    /** Drop the pipes a leaked grandchild is still holding — nothing will read them again. */
    const dropPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    /**
     * execFile-shaped failure for a non-zero exit: promisified execFile attached the captured
     * streams to the error, and runDoltSync's benign/first-publish matchers read them off it.
     */
    const exitFailure = (code: number | null, signal: NodeJS.Signals | null) =>
      Object.assign(new Error(`Command failed: ${[bin, ...args].join(" ")}\n${stderr}`), {
        cmd: [bin, ...args].join(" "),
        code: code ?? undefined,
        signal,
        killed: child.killed,
        stdout,
        stderr,
      });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      // Flush whatever the decoders held back (an output that ends mid-character), as execFile did.
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (code === 0) resolve(stdout);
      else reject(exitFailure(code, signal));
    };

    const budgetTimer = setTimeout(() => {
      killGroup("SIGTERM");
      // The escalation deliberately outlives the promise: the caller unwinds now, while the group
      // still gets killed. It is never disarmed — bd's own exit says nothing about the descendants
      // the reap is actually for (see the `exit` handler). Unlike runShell, which waits for the
      // group before it settles: nothing here rolls a worktree back on this rejection.
      setTimeout(() => killGroup("SIGKILL"), killGraceMs());
      settle(() => {
        dropPipes();
        // Partial stdout/stderr is deliberately NOT attached: a wedged step's captured output is
        // startup noise, and runDoltSync prefers it over the message — which would bury the real
        // cause exactly as it did for stringer (anton-be1s).
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd} exceeded its ${budgetMs}ms budget ` +
                `(elapsed ${Date.now() - startedAt}ms) and its process group was killed. ` +
                `bd or a child of it (typically \`git fetch\` against an unreachable remote) hung; ` +
                `if it held the Dolt lock, later bd calls in this repo may fail until the tree is gone.`,
            ),
            { killed: true, signal: "SIGTERM" as NodeJS.Signals },
          ),
        );
      });
    }, budgetMs);

    /** maxBuffer parity: kill the tree and reject rather than buffer without bound. */
    const overflow = (stream: "stdout" | "stderr") => {
      killGroup("SIGKILL");
      settle(() => {
        dropPipes();
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd}: ${stream} exceeded ${bufferLimit} bytes ` +
                `(maxBuffer length exceeded)`,
            ),
            { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, stdout, stderr },
          ),
        );
      });
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout += outDecoder.write(c);
      if (stdout.length > bufferLimit) overflow("stdout");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += errDecoder.write(c);
      if (stderr.length > bufferLimit) overflow("stderr");
    });

    // `spawn bd ENOENT` and friends — bd never ran, so there is no group to reap.
    child.on("error", (err) => settle(() => reject(err)));

    // The fast path for every healthy call: `close` follows `exit` immediately when nothing else
    // holds the pipes, so stdout is complete and capture is byte-identical to the execFile it replaced.
    child.on("close", (code, signal) => settle(() => finish(code, signal)));

    child.on("exit", (code, signal) => {
      // A pending SIGKILL is deliberately NOT cancelled here. The reap targets the process group,
      // and bd exiting on the SIGTERM proves nothing about the wedged `git fetch` that ignored it —
      // that survivor is what holds the Dolt lock and what the escalation exists to reach. Disarming
      // on the leader's exit would restore the very leak the group kill was added to close. When the
      // group is already empty the escalation is a harmless ESRCH inside killGroup.
      if (settled) return; // already timed out (or overflowed) — the caller has its verdict
      drainTimer = setTimeout(
        () =>
          settle(() => {
            dropPipes();
            finish(code, signal);
          }),
        DRAIN_AFTER_EXIT_MS,
      );
    });
  });
}

/**
 * Test-only handle on the single bd invoker (anton-jfjw.1): the process-lifecycle suite drives real
 * fake-`bd` scripts through it to prove the group reap and the settle-on-exit contract. Production
 * code goes through the `beads` object.
 */
export const runBdForTest = bd;

export type BdExec = typeof bd;

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

