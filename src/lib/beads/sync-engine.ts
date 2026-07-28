/**
 * Per-project heartbeat that keeps every managed project's local beads DB fresh against its
 * configured Dolt remote (anton-live-sync). Each beat runs one BACKSTOP pass through the shared
 * coalescer in bd.ts: always a pull, plus a push when the repo is ahead of its remote — i.e. a
 * prior write-nudged push failed and left work committed-but-unpushed (anton-sr8f), plus one
 * reconciling full pass on the first beat after a (re)start so commits stranded by a crash still
 * ship (the in-memory backlog count can't survive a restart). A caught-up, reconciled repo pulls
 * only, so idle anton instances never hammer a shared remote (see SyncRequest in bd.ts). Started
 * once at server boot alongside the job runner; status lands in the globalThis
 * sync-status registry that API routes read.
 *
 * Beats are contained per repo (anton-jfjw.2): each one is deadline-bounded and, past its deadline,
 * abandoned rather than awaited, so a repo whose sync never settles degrades to "that one board is
 * stale" instead of stopping the scheduler for every project.
 */
import { BD_STEP_TIMEOUT_MS, beads, getSyncStatus } from "./bd";
import { listProjects } from "../projects";

export interface SyncEngineDeps {
  /** Projects to heartbeat; only those with a .beads workspace are synced. */
  listProjects: () => Promise<Array<{ repoPath: string; hasBeads: boolean }>>;
  /** One heartbeat pass for a project: pull + backstop push if it's ahead of its remote (defaults
   * to beads.backstop through the shared coalescer). */
  sync: (cwd: string) => Promise<void>;
  heartbeatMs: number;
  /** Recheck cadence for not-wired projects — no full-rate churn against nothing. */
  notWiredRecheckMs: number;
  /** Ceiling for the doubling failure backoff. */
  maxBackoffMs: number;
  /** Wall-clock deadline for ONE beat; past it the beat is a failure (see beatDeadlineMs). */
  beatTimeoutMs: number;
  log: { info: (msg: string) => void; error: (msg: string) => void };
  now: () => number;
}

/** Steps in the widest pass a beat can run — `bd dolt` pull → commit → push (runDoltSync). */
const FULL_PASS_STEPS = 3;

/** Beat deadline in heartbeats: six missed beats is unambiguously wedged, not merely slow. */
const BEAT_DEADLINE_HEARTBEATS = 6;

/**
 * Wall-clock budget for one beat, past which the scheduler abandons it (anton-jfjw.2). The per-step
 * budget in bd.ts now reaps bd's whole process group and settles on exit (anton-jfjw.1), so a wedged
 * step no longer pends forever — but this bound stays load-bearing: it covers a pass that legitimately
 * spans several steps, and anything that outlives even that reap (a descendant in uninterruptible
 * kernel wait survives SIGKILL). Without it, one wedged repo froze the heartbeat for EVERY project —
 * tick() never settled, so loop() never rescheduled.
 *
 * Scaled to the heartbeat so the bound stays meaningful when the cadence is tuned, with a floor at
 * the widest legitimate pass: pull+commit+push each get the full per-step budget, so relying on that
 * budget alone would let one honest pass run 3× it. The floor keeps a genuinely slow — but
 * progressing — repo from being reported as wedged.
 */
export function beatDeadlineMs(heartbeatMs: number): number {
  const configured = Number(process.env.ANTON_SYNC_BEAT_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return Math.max(heartbeatMs * BEAT_DEADLINE_HEARTBEATS, FULL_PASS_STEPS * BD_STEP_TIMEOUT_MS);
}

const defaultDeps = (): SyncEngineDeps => {
  const heartbeatMs = Number(process.env.ANTON_SYNC_HEARTBEAT_MS) || 30_000;
  return {
    listProjects,
    sync: (cwd) => beads.backstop(cwd),
    heartbeatMs,
    notWiredRecheckMs: Number(process.env.ANTON_SYNC_NOT_WIRED_RECHECK_MS) || 60_000,
    maxBackoffMs: 60_000,
    beatTimeoutMs: beatDeadlineMs(heartbeatMs),
    log: {
      info: (msg) => console.log(`[sync-engine] ${msg}`),
      error: (msg) => console.error(`[sync-engine] ${msg}`),
    },
    now: () => Date.now(),
  };
};

/**
 * Reject with `onTimeout()` if `p` hasn't settled within `ms`. `p` keeps running — a wedged pass
 * can't be cancelled from here (that's the spawn reap's job); this only stops the SCHEDULER from
 * waiting on it. The timer is unref'd and always cleared, so an idle engine never holds the process
 * open and a fast pass leaves nothing pending.
 */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

interface ProjectBeat {
  nextDueAt: number;
  backoffMs: number;
  lastLoggedError: string | null;
}

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** One scheduler pass: syncs every due project. Exposed for tests; start() loops it. */
  tick(): Promise<void>;
}

export function createSyncEngine(overrides: Partial<SyncEngineDeps> = {}): SyncEngine {
  const deps: SyncEngineDeps = { ...defaultDeps(), ...overrides };
  // Derive the deadline from the EFFECTIVE heartbeat — an overridden cadence must carry its own
  // bound rather than the one the env-configured default happened to produce.
  if (overrides.beatTimeoutMs === undefined) deps.beatTimeoutMs = beatDeadlineMs(deps.heartbeatMs);
  const beats = new Map<string, ProjectBeat>();
  // Repos whose pass is still running. A beat abandoned at its deadline stays here until the
  // underlying pass actually settles, so a permanently wedged repo holds exactly ONE in-flight beat
  // instead of accumulating a new one every heartbeat.
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  async function beatProject(repoPath: string): Promise<void> {
    const beat = beats.get(repoPath) ?? {
      nextDueAt: 0,
      backoffMs: deps.heartbeatMs,
      lastLoggedError: null,
    };
    try {
      const pass = deps.sync(repoPath);
      inFlight.add(repoPath);
      // Release on the PASS, not on the deadline race: the pass outlives an abandoned beat.
      void pass.catch(() => {}).finally(() => inFlight.delete(repoPath));
      await withDeadline(
        pass,
        deps.beatTimeoutMs,
        () => new Error(`sync exceeded its ${deps.beatTimeoutMs}ms beat deadline`),
      );
      const state = getSyncStatus(repoPath).state;
      beat.backoffMs = deps.heartbeatMs;
      beat.lastLoggedError = null;
      beat.nextDueAt =
        deps.now() + (state === "not-wired" ? deps.notWiredRecheckMs : deps.heartbeatMs);
    } catch (e) {
      // Failure is already recorded in the status registry by the coalescer; here we only pace
      // retries (doubling backoff, capped) and keep the log to one line per distinct error. A
      // deadline miss takes this same path deliberately — including the registry silence, since a
      // pass that never rejected is still `syncing` there and ages into `stalled` on its own
      // (anton-jfjw.3), which is a truer report of a wedge than a synthetic `failing`.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== beat.lastLoggedError) {
        deps.log.error(`sync failed for ${repoPath}: ${msg}`);
        beat.lastLoggedError = msg;
      }
      beat.backoffMs = Math.min(beat.backoffMs * 2, deps.maxBackoffMs);
      beat.nextDueAt = deps.now() + beat.backoffMs;
    }
    beats.set(repoPath, beat);
  }

  async function tick(): Promise<void> {
    let projects: Array<{ repoPath: string; hasBeads: boolean }>;
    try {
      projects = await deps.listProjects();
    } catch (e) {
      deps.log.error(`listProjects failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const due = projects.filter(
      (p) =>
        p.hasBeads &&
        (beats.get(p.repoPath)?.nextDueAt ?? 0) <= deps.now() &&
        !inFlight.has(p.repoPath),
    );
    // One project's failure must not starve the others — settle all beats independently. Every beat
    // is deadline-bounded, so a wedged repo can't hold this open and stop loop() rescheduling.
    await Promise.allSettled(due.map((p) => beatProject(p.repoPath)));
  }

  function loop(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(loop);
    }, deps.heartbeatMs);
    // Don't hold the process open for heartbeats (matters for CLI/test processes).
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      deps.log.info(`heartbeat started (every ${deps.heartbeatMs}ms)`);
      // Give the first user-facing read a chance to seed the snapshot before embedded Dolt pulls.
      // Starting both at boot made a cold board request contend with the initial pull for seconds.
      loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
  };
}

// Idempotent process-wide start, anchored on globalThis: Next.js dev recompiles can re-evaluate
// this module, and a second engine instance would double every heartbeat.
const ENGINE_KEY = Symbol.for("anton.beads.syncEngine");

export function startSyncEngine(): void {
  const g = globalThis as unknown as Record<symbol, SyncEngine | undefined>;
  const engine = (g[ENGINE_KEY] ??= createSyncEngine());
  engine.start();
}
