/**
 * Aggregate ready-queue size across projects — the "backlog" measure behind the shaping nudge
 * (anton-eklj). When quota is idle but this is thin, the nav prompts the operator to shape more.
 *
 * Fail-soft, mirroring src/lib/claude/usage.ts: this feeds a nav render and must never throw into
 * a page. A project whose `bd ready` read fails is skipped (its work is counted as unknown, not
 * zero); when *every* read fails — or there are no beads projects — the total is `null`, which
 * suppresses the nudge rather than claiming an empty backlog on a broken read.
 *
 * Cached server-side on the same short TTL as usage so a burst of nav polls collapses to one
 * sweep, with concurrent callers sharing a single in-flight read (single-flight).
 */
import { beads } from "@/lib/beads/bd";
import { listProjects } from "@/lib/projects";

import { USAGE_CACHE_TTL_MS } from "./usage";

/**
 * Sum truly-claimable beads across every project that has a beads DB. Returns `null` when no such
 * project exists or none could be read; a partial failure returns the sum of the readable ones.
 */
export async function readReadyCount(): Promise<number | null> {
  let projects;
  try {
    projects = await listProjects();
  } catch {
    return null; // no db / query failure — unknown, not empty
  }

  const withBeads = projects.filter((p) => p.hasBeads);
  if (withBeads.length === 0) return null;

  const counts = await Promise.all(
    withBeads.map(async (p) => {
      try {
        return (await beads.ready(p.repoPath)).length;
      } catch {
        return null; // one project's read failed — skip it, don't zero the total
      }
    }),
  );

  const readable = counts.filter((c): c is number => c !== null);
  if (readable.length === 0) return null;
  return readable.reduce((sum, c) => sum + c, 0);
}

interface ReadyCountCacheEntry {
  at: number;
  value: number | null;
}
let readyCache: ReadyCountCacheEntry | null = null;
let readyInFlight: Promise<number | null> | null = null;

/**
 * Cached ready-count read for the nudge route. Collapses bursts of nav polls into one sweep within
 * {@link USAGE_CACHE_TTL_MS}; `null` results cache too, so a broken read doesn't hammer `bd`.
 * `reader`/`now` are injectable for deterministic tests.
 */
export async function getReadyCountCached(
  reader: () => Promise<number | null> = readReadyCount,
  now: () => number = Date.now,
): Promise<number | null> {
  const ts = now();
  if (readyCache && ts - readyCache.at < USAGE_CACHE_TTL_MS) return readyCache.value;
  if (readyInFlight) return readyInFlight;
  readyInFlight = (async () => {
    try {
      const value = await reader();
      readyCache = { at: ts, value };
      return value;
    } finally {
      readyInFlight = null;
    }
  })();
  return readyInFlight;
}

/** Clear the module-level cache. Test-only. */
export function resetReadyCountCache(): void {
  readyCache = null;
  readyInFlight = null;
}
