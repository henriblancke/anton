/**
 * Per-project heartbeat that keeps every managed project's local beads DB fresh against its
 * configured Dolt remote (anton-live-sync). Each beat runs a PULL-ONLY pass through the shared
 * coalescer in bd.ts — pushes belong to write-nudged passes only, so idle anton instances never
 * hammer a shared remote (see SyncMode in bd.ts). Started once at server boot alongside the job
 * runner; status lands in the globalThis sync-status registry that API routes read.
 */
import { beads, getSyncStatus } from "./bd";
import { listProjects } from "../projects";

export interface SyncEngineDeps {
  /** Projects to heartbeat; only those with a .beads workspace are synced. */
  listProjects: () => Promise<Array<{ repoPath: string; hasBeads: boolean }>>;
  /** Pull-only sync for one project (defaults to beads.pull through the shared coalescer). */
  pull: (cwd: string) => Promise<void>;
  heartbeatMs: number;
  /** Recheck cadence for not-wired projects — no full-rate churn against nothing. */
  notWiredRecheckMs: number;
  /** Ceiling for the doubling failure backoff. */
  maxBackoffMs: number;
  log: { info: (msg: string) => void; error: (msg: string) => void };
  now: () => number;
}

const defaultDeps = (): SyncEngineDeps => ({
  listProjects,
  pull: (cwd) => beads.pull(cwd),
  heartbeatMs: Number(process.env.ANTON_SYNC_HEARTBEAT_MS) || 30_000,
  notWiredRecheckMs: Number(process.env.ANTON_SYNC_NOT_WIRED_RECHECK_MS) || 60_000,
  maxBackoffMs: 60_000,
  log: {
    info: (msg) => console.log(`[sync-engine] ${msg}`),
    error: (msg) => console.error(`[sync-engine] ${msg}`),
  },
  now: () => Date.now(),
});

interface ProjectBeat {
  nextDueAt: number;
  backoffMs: number;
  lastLoggedError: string | null;
}

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** One scheduler pass: pulls every due project. Exposed for tests; start() loops it. */
  tick(): Promise<void>;
}

export function createSyncEngine(overrides: Partial<SyncEngineDeps> = {}): SyncEngine {
  const deps = { ...defaultDeps(), ...overrides };
  const beats = new Map<string, ProjectBeat>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  async function beatProject(repoPath: string): Promise<void> {
    const beat = beats.get(repoPath) ?? {
      nextDueAt: 0,
      backoffMs: deps.heartbeatMs,
      lastLoggedError: null,
    };
    try {
      await deps.pull(repoPath);
      const state = getSyncStatus(repoPath).state;
      beat.backoffMs = deps.heartbeatMs;
      beat.lastLoggedError = null;
      beat.nextDueAt =
        deps.now() + (state === "not-wired" ? deps.notWiredRecheckMs : deps.heartbeatMs);
    } catch (e) {
      // Failure is already recorded in the status registry by the coalescer; here we only pace
      // retries (doubling backoff, capped) and keep the log to one line per distinct error.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== beat.lastLoggedError) {
        deps.log.error(`pull failed for ${repoPath}: ${msg}`);
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
      (p) => p.hasBeads && (beats.get(p.repoPath)?.nextDueAt ?? 0) <= deps.now(),
    );
    // One project's failure must not starve the others — settle all beats independently.
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
