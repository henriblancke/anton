import { beads, type Bead, type DepCycle } from "./bd";
import { attachCycleEvidence, cycleEvidenceFor } from "./cycle-evidence";
import {
  getBeadDescription,
  getIssueSnapshot,
  hydrateIssueSnapshot,
  issueSnapshotGeneration,
  issueSnapshotVersion,
  markCycleEvidenceRecovered,
  probeIssueSnapshot,
  readIssueSnapshot,
  refreshIssueSnapshot,
  type SnapshotRead,
  type SnapshotReadOptions,
} from "./snapshot";

function dedupeById(beadList: Bead[]): Bead[] {
  const seen = new Set<string>();
  return beadList.filter((bead) => {
    if (seen.has(bead.id)) return false;
    seen.add(bead.id);
    return true;
  });
}

async function loadWorkIssues(cwd: string): Promise<Bead[]> {
  try {
    return await beads.list(cwd, ["--status", "all"]);
  } catch {
    const [open, closed] = await Promise.all([
      beads.list(cwd),
      beads.list(cwd, ["--status", "closed"]),
    ]);
    return dedupeById([...open, ...closed]);
  }
}

/**
 * The `blocks` blockers the listing points at but does not itself contain. Such a dangling edge is
 * the ONLY thing a second read can resolve, and in practice it means a gate (see
 * {@link loadGateIssues}) — so the count of them is also the bead count a failed gate read costs
 * the board, which is what makes that failure legible in a log.
 */
function danglingBlockerIds(work: Bead[]): string[] {
  const known = new Set(work.map((b) => b.id));
  const dangling = beads
    .edgesOf(work)
    .filter((e) => e.type === "blocks" && !known.has(e.to))
    .map((e) => e.to);
  return [...new Set(dangling)];
}

const preview = (ids: string[], max = 5): string =>
  ids.length <= max ? ids.join(", ") : `${ids.slice(0, max).join(", ")}, +${ids.length - max} more`;

/**
 * Gate beads, which bd OMITS from every ordinary listing (measured against bd 1.1.2: a poured
 * molecule's gates are absent from `bd list --status all`, and `--type gate` is the only listing
 * that surfaces them) — while the `blocks` edge a gate puts on the bead it gates IS carried there.
 *
 * That asymmetry is the trap this read exists to close (anton-ve2r). Every blocker helper treats a
 * blocker missing from the list as still open (fail-safe), so without the gates present a RESOLVED
 * gate reads as an open blocker forever: its bead never returns to ready and its approve route 409s
 * permanently, `bd gate resolve` notwithstanding. Reading them makes their real status knowable;
 * keeping them OUT of the work surfaces is a separate, type-based filter (isPipelineArtifact).
 *
 * Best-effort by DEFAULT (a UI read degrades to the pre-gate behaviour — gates absent ⇒ their edges
 * read as open blockers — rather than failing the whole board read), strict when the caller asks:
 * see {@link LoadIssuesOptions.strictGates}.
 *
 * Degrading is not the same as being silent: the degraded board is cached as the snapshot and the
 * lane's ranking is computed from it, so a swallowed failure changes what the operator is shown
 * with no symptom but a bead count that quietly drops. Hence the warning.
 */
function loadGateIssues(cwd: string, strict: boolean, dangling: string[]): Promise<Bead[]> {
  const gates = beads.list(cwd, ["--status", "all", "--type", "gate"]);
  if (strict) return gates;
  return gates.catch((e: unknown) => {
    console.warn(
      `[beads.issues] ${cwd}: gate listing failed — board degraded without its gates; ` +
        `${dangling.length} blocker(s) stay unresolved and read as open (${preview(dangling)}): ` +
        (e instanceof Error ? e.message : String(e)),
    );
    return [];
  });
}

export interface LoadIssuesOptions {
  /**
   * Read and attach authoritative `bd dep cycles` evidence for consumers that must refuse cycles.
   *
   * A snapshot without this option remains a cheap UI read. A caller that can approve, unapprove, or
   * enqueue work must opt in so every pure approval gate it composes sees the same graph evidence.
   */
  withCycles?: boolean;
  /**
   * Fail the whole read when the gate listing fails, instead of degrading to a gate-less board.
   *
   * For a page render, degrading is right: a gate edge that reads as an open blocker renders one
   * card as blocked and self-corrects on the next read. For a JOB it inverts the fail-safe. A run
   * target's own `gh:pr` merge gate is a `blocks` edge on the target, and the gate bead is the only
   * evidence that the edge is the target's own merge wait rather than a prerequisite — so a
   * transient `bd list` failure makes execute-epic read that dangling id as a real blocker and
   * PoisonEpic the run. For a PR closed without merging that gate never resolves, and a plain
   * target's gate is not rediscoverable through `bd ready --gated`, so a park there needs a human.
   * A rejected read is a normal retry instead — the same transient failure, handled where it can be.
   */
  strictGates?: boolean;
}

export async function loadAllIssues(
  cwd: string,
  opts: LoadIssuesOptions = {},
): Promise<Bead[]> {
  // Fired alongside `loadWorkIssues`, not after the board is fully assembled (PR #274 review,
  // round 5 on this file): `bd dep cycles` and `bd list` are two independent CLI reads with no
  // shared transaction, so SOME window where they see different graph revisions is unavoidable.
  // Starting this one concurrently shrinks that window to the listing's own duration instead of
  // stacking the cycles read after it (and after the conditional gate read besides) — the gap in
  // which a concurrently-repaired cycle could make the attached evidence stale against `board`'s
  // own edges.
  const cyclesPromise = opts.withCycles ? beads.depCycles(cwd) : undefined;
  // Observed right away: if `loadWorkIssues` throws first, this function returns before the
  // `await cyclesPromise` below ever runs, and a `cyclesPromise` that also rejects would
  // otherwise be an unhandled rejection — which Bun can escalate to a process-level failure
  // instead of the recoverable board-read error it actually is. This handler only marks the
  // rejection observed; the `await` below still sees (and propagates) the original rejection.
  cyclesPromise?.catch(() => {});
  const work = await loadWorkIssues(cwd);
  // CONDITIONAL, not unconditional: a board read sits on the operator's critical path behind the
  // Dolt lock, and anton-hwkx trimmed approve down to exactly one. A board with no dangling blocker
  // has no gate that could change any answer, so it keeps paying for one read; only a board that
  // actually holds a gate edge pays for the second.
  const dangling = danglingBlockerIds(work);
  // Deduped rather than concatenated: a future bd that starts carrying gates in the ordinary
  // listing must not double them (and a test double answering both reads alike must not either).
  const board = dangling.length === 0
    ? work
    : dedupeById([...work, ...await loadGateIssues(cwd, opts.strictGates ?? false, dangling)]);
  return cyclesPromise ? attachCycleEvidence(board, await cyclesPromise) : board;
}


/**
 * Per-repo, per-generation in-flight `bd dep cycles` fetch, shared by every best-effort
 * cycle-evidence path (`attachCyclesBestEffort` below and {@link probeCycleEvidence}) so
 * concurrent callers coalesce into one CLI call instead of each spawning their own (PR #274
 * review, round 6 on this file): several cold page renders sharing one snapshot load each reach
 * `readAllIssues`/`allIssues` with `withCycles` before the first enrichment finishes, and every
 * poller running `probeCycleEvidence` is racing the same gap. Global-keyed for the same
 * cross-module-registry reason as `cyclesByBoard`/the snapshot registry.
 *
 * Keyed by {@link issueSnapshotGeneration} alongside `cwd` (PR #274 review, round 7 on
 * `issues.ts:154`; round 8 extended the generation bump itself to cover a content-changed TTL
 * refresh, not just an explicit invalidation): the generation moves whenever the cached snapshot is
 * replaced with different content, but a cycles fetch started against the OLD graph can still be in
 * flight. A repo-only key would let a
 * reader enriching the NEW snapshot reuse that stale-graph result and attach it as if it were
 * current — a newly introduced cycle could be recorded as cycle-free, and because evidence then
 * reads as present, every probe stops retrying until unrelated content changes. Scoping the key to
 * the generation makes a write start a fresh fetch for readers of the new snapshot while letting
 * in-flight readers of the old one still coalesce on the original call.
 */
const CYCLE_FETCHES_KEY = Symbol.for("anton.beads.cycleFetches");

function cycleFetches(): Map<string, Promise<DepCycle[]>> {
  const global = globalThis as unknown as Record<symbol, Map<string, Promise<DepCycle[]>> | undefined>;
  return (global[CYCLE_FETCHES_KEY] ??= new Map());
}

function fetchCyclesShared(cwd: string, generation: number): Promise<DepCycle[]> {
  const fetches = cycleFetches();
  const key = `${cwd}::${generation}`;
  const existing = fetches.get(key);
  if (existing) return existing;
  const fetch = beads.depCycles(cwd).finally(() => {
    if (fetches.get(key) === fetch) fetches.delete(key);
  });
  fetches.set(key, fetch);
  return fetch;
}

/**
 * Enrich an already-loaded snapshot with `bd dep cycles` evidence WITHOUT failing the read that
 * produced it. `allIssues`/`readAllIssues` back page renders and the board polling API, where the
 * ordinary bead listing succeeding (often off a cached snapshot) must not be undone by this
 * auxiliary query timing out or returning unreadable output. Leaving evidence unattached on failure
 * is not silently unsafe: every startability projection that consumes `cycleEvidenceFor` already
 * fails closed on `undefined` (see `missingCycleEvidenceGap`), so a transient failure here degrades
 * "can this be approved" answers rather than crashing the board. A caller that must NOT proceed on
 * stale/absent evidence uses `loadAllIssues` directly, which still lets `depCycles` reject (jobs
 * rely on that to retry — see execute-epic-start).
 *
 * The CLI call itself goes through {@link fetchCyclesShared}, so several concurrent readers hitting
 * the same missing-evidence snapshot (or a `probeCycleEvidence` poll landing at the same moment)
 * spawn `bd dep cycles` once. The board is rechecked after that shared fetch settles before
 * attaching + bumping the version (PR #274 review, round 6): whichever caller resumes first performs
 * both, and every later caller sees evidence already on its (shared) board array and skips both —
 * only the call that actually transitions the retained board from missing to present pays for the
 * version bump.
 *
 * Bumps the snapshot version on success (PR #274 review, round 4 on this file), same as
 * {@link probeCycleEvidence}: without it, a page that rendered a cached board with no evidence and
 * then recovers it here leaves the poll path's freshness token untouched, so a concurrent poller
 * that already matched the pre-recovery version keeps 304-ing an empty-startability board until
 * unrelated bead content changes.
 */
async function attachCyclesBestEffort(cwd: string, board: Bead[]): Promise<void> {
  try {
    const generation = issueSnapshotGeneration(cwd);
    const cycles = await fetchCyclesShared(cwd, generation);
    // A write replaced the snapshot while this fetch was in flight: `cycles` describes the graph
    // this generation's board no longer represents. Leave evidence unattached rather than stamp a
    // stale-graph result as current — the next probe or read retries against the new generation.
    if (issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
      attachCycleEvidence(board, cycles);
      markCycleEvidenceRecovered(cwd);
    }
  } catch (e) {
    console.warn(
      `[beads.issues] ${cwd}: dep cycles read failed — board stays readable without cycle evidence; ` +
        `startability projections fail closed until the next successful read: ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

/**
 * Attach `bd dep cycles` evidence to an already-loaded, forced-fresh board, for a caller that has a
 * `bd list` read it must not repeat (unlike a plain `withCycles: true` load, this reuses the board
 * already in hand instead of paying for a second one) but still must NOT proceed on missing evidence
 * — unlike {@link attachCyclesBestEffort}, this lets a failed `depCycles` call reject.
 *
 * A no-op when the board already carries evidence, so a caller may call it defensively without ever
 * risking a redundant `bd dep cycles` spawn.
 */
export async function ensureCycleEvidence(cwd: string, board: Bead[]): Promise<Bead[]> {
  if (cycleEvidenceFor(board) === undefined) {
    attachCycleEvidence(board, await beads.depCycles(cwd));
    markCycleEvidenceRecovered(cwd);
  }
  return board;
}

export async function allIssues(
  cwd: string,
  opts?: SnapshotReadOptions & { withCycles?: boolean },
): Promise<Bead[]> {
  const board = await getIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
  // The snapshot key is the repository, not every reader's projection needs. A warm page snapshot
  // may therefore predate an approval reader: enrich that exact array rather than treating absent
  // evidence as an authoritative empty result.
  if (opts?.withCycles && cycleEvidenceFor(board) === undefined) {
    await attachCyclesBestEffort(cwd, board);
  }
  return board;
}

/** Beads plus the snapshot version they carry, read atomically — for callers that stamp a response
 * with the version (the board freshness token) and must not desync data from version. */
export async function readAllIssues(
  cwd: string,
  opts?: SnapshotReadOptions & { withCycles?: boolean },
): Promise<SnapshotRead> {
  const snapshot = await readIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
  // Keep evidence attached to the cached array itself: `SnapshotRead` is a wrapper and copying the
  // board would lose the sidecar that pure approval projections consume.
  if (opts?.withCycles && cycleEvidenceFor(snapshot.beads) === undefined) {
    const generation = issueSnapshotGeneration(cwd);
    await attachCyclesBestEffort(cwd, snapshot.beads);
    // Only re-read the version if THIS array actually got enriched. `attachCyclesBestEffort` skips
    // attaching when a concurrent refresh already replaced the retained board (its own generation
    // guard) — in that case `snapshot.beads` is untouched and pairing it with a freshly-read version
    // (which may have advanced for that unrelated replacement) would return a mismatched pair: the
    // caller (getBoard) stamps a response with a version describing beads it never actually returned,
    // and the next `/board?version=...` poll would 304 against content the client never received.
    // When this array WAS enriched, `markCycleEvidenceRecovered` bumped the version for it specifically
    // (PR #274 review, round 4), so `snapshot.version` (captured before that bump) would understate it —
    // re-read to describe the exact (now-enriched) board being returned.
    if (cycleEvidenceFor(snapshot.beads) !== undefined) {
      // Evidence attaching only proves THIS array was enriched, not that it's still the retained
      // board (PR #274 review, round 12): `attachCyclesBestEffort`'s own generation guard closes the
      // race during ITS internal await, but the outer `await` above still yields a microtask tick on
      // the way back here, wide enough for a concurrent content-changing refresh or local
      // invalidation to advance the retained snapshot past this array in between. Pairing the old,
      // now-enriched array with `issueSnapshotVersion` read after that gap would stamp it with a
      // version describing beads the caller never actually returned — the same stale-304 failure mode
      // this whole re-read exists to avoid. Re-checking the generation here closes that gap: on a
      // mismatch, the board moved, so get a consistent pair fresh rather than trust this one.
      if (issueSnapshotGeneration(cwd) !== generation) {
        return readAllIssues(cwd, opts);
      }
      return { beads: snapshot.beads, version: issueSnapshotVersion(cwd) };
    }
  }
  return snapshot;
}

export async function refreshAllIssues(cwd: string, opts: LoadIssuesOptions = {}): Promise<Bead[]> {
  const board = await refreshIssueSnapshot(cwd, () => loadAllIssues(cwd, opts));
  // A concurrent non-authoritative refresh may have won the snapshot loader. Enrich the exact board
  // returned here so callers that must make approval decisions never lose the requested evidence.
  // Routed through `fetchCyclesShared` (PR #274 review) rather than a direct `beads.depCycles` call:
  // several concurrent `refreshAllIssues({ withCycles: true })` callers can hit this same race at
  // once (e.g. concurrent approval/proposal-apply requests against one repo), and a direct call here
  // would spawn its own `bd dep cycles` process per caller instead of coalescing like every other
  // cycles path in this file. Bumping the version on success, same as `attachCyclesBestEffort`: this
  // evidence lands OUTSIDE `refreshIssueSnapshot`'s own recovery bump (its loader returned a board
  // with none, so from its point of view nothing changed), so without this a poller stuck on missing
  // evidence would still never see a fresh token for the one recovery that happens to land through
  // this exact race.
  if (opts.withCycles && cycleEvidenceFor(board) === undefined) {
    const cycles = await fetchCyclesShared(cwd, issueSnapshotGeneration(cwd));
    attachCycleEvidence(board, cycles);
    markCycleEvidenceRecovered(cwd);
  }
  // Same race, for gates (PR #274 review): `refreshIssueSnapshot`'s single-flight is loader-blind, so
  // a concurrent `probeAllIssues` already in flight when this call lands can win the race and hand
  // back a board whose gate read never asked for `strictGates` — including one that failed and
  // silently degraded to []. A dangling blocker on the board actually returned is always a gate by
  // construction (see `loadGateIssues`), so any left over here means this exact board's gate read
  // was non-strict or never ran. Re-fetch strictly and let it throw, never accept a board whose gates
  // might be silently missing under a caller that asked to fail loud on exactly that.
  if (opts.strictGates) {
    const dangling = danglingBlockerIds(board);
    if (dangling.length > 0) {
      // Hydrate the RETAINED snapshot too, not just this function's return value (PR #274 review):
      // `dedupeById` builds a new array, so without writing it back the entry stays on the degraded,
      // gate-less board `refreshIssueSnapshot` just cached — and a same-request caller that rebuilds
      // the board from the snapshot afterward (e.g. the approve route's `getBoard`) would read a
      // resolved gate's `blocks` edge as still dangling and open. See `hydrateIssueSnapshot`.
      const generation = issueSnapshotGeneration(cwd);
      const hydrated = dedupeById([...board, ...await loadGateIssues(cwd, true, dangling)]);
      // `dedupeById` allocates a new array, and the cycle sidecar is WeakMap-keyed on array identity
      // (cycle-evidence.ts) — so a caller combining `withCycles` and `strictGates` would otherwise
      // lose the evidence just attached to `board` above the moment this branch rebuilds it (PR #274
      // review). Re-attach onto the rebuilt array before it's cached or returned.
      const cycles = cycleEvidenceFor(board);
      if (cycles !== undefined) attachCycleEvidence(hydrated, cycles);
      hydrateIssueSnapshot(cwd, hydrated, generation);
      return hydrated;
    }
  }
  return board;
}

export function probeAllIssues(cwd: string): void {
  probeIssueSnapshot(cwd, () => loadAllIssues(cwd));
}

/** Per-repo in-flight cycle-evidence probe, so concurrent pollers (multiple open tabs, a slow or
 * failing `bd`) share one `bd dep cycles` call instead of each spawning their own CLI process.
 * Global-keyed for the reason {@link onBoardChanged}'s registry is: a module-scoped map would leave
 * a probe started from one Next.js module registry invisible to a caller in another. */
const CYCLE_PROBES_KEY = Symbol.for("anton.beads.cycleProbes");

function cycleProbes(): Map<string, Promise<void>> {
  const global = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (global[CYCLE_PROBES_KEY] ??= new Map());
}

/** Test-only reset; runtime code should let in-flight probes finish and remove themselves. */
export function resetCycleProbes(): void {
  cycleProbes().clear();
}

/**
 * Nudge a stuck cycle-evidence gap toward recovery without making the caller wait (PR #274 review,
 * round 2 on this file: a failed `bd dep cycles` call has no retry path once the poll stops reaching
 * `allIssues`/`readAllIssues`). Those two are only where {@link attachCyclesBestEffort} retries, and
 * they only run when the board route's freshness token has already changed — a token sourced solely
 * from `issueSnapshotVersion`, which never moves on a `bd` recovery, only on the bead CONTENT
 * changing. So a transient `bd` failure on the first authoritative read leaves every following poll
 * 304-ing the same "evidence unavailable" verdict until an unrelated bead edit or a manual reload
 * happens to force a fresh read.
 *
 * Called alongside {@link probeAllIssues} on the poll path: it retries the missing evidence against
 * the CURRENTLY retained snapshot and, on success, attaches it AND bumps the snapshot version, so a
 * poll that already matched the pre-recovery token stops 304-ing and rebuilds the board with the
 * evidence startability needs.
 *
 * A repository with a probe already in flight is a no-op call (PR #274 review, round 3: without this
 * guard, several concurrent pollers each launch their own `bd dep cycles` process and each bumps the
 * version on success — avoidable Dolt contention and repeated full board rebuilds for evidence one
 * call already retrieves). The version bump itself stays conditional on the retained board actually
 * lacking evidence at the moment this probe's `bd` call lands, so only the probe that transitions the
 * snapshot from missing to present pays for a rebuild.
 */
export function probeCycleEvidence(cwd: string): void {
  const probes = cycleProbes();
  if (probes.has(cwd)) return;
  // No stale-clobber guard needed on cleanup: the has-check above guarantees at most one probe
  // per repo is ever registered at a time, unlike `entry.refresh` in snapshot.ts which a write can
  // orphan mid-flight.
  probes.set(
    cwd,
    (async () => {
      try {
        const board = await getIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, {
          blockOnPendingWrite: false,
        });
        if (cycleEvidenceFor(board) !== undefined) return;
        const generation = issueSnapshotGeneration(cwd);
        const cycles = await fetchCyclesShared(cwd, generation);
        // Recheck evidence: a concurrent `attachCyclesBestEffort` sharing this fetch (or a probe
        // that beat this one to it) may already have attached it — and bumped the version — while
        // this awaited the shared CLI call. Recheck generation too: a write replacing the snapshot
        // mid-fetch means `cycles` describes a graph this board no longer represents, so it must
        // not be stamped onto it as current (PR #274 review, round 7).
        if (issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
          attachCycleEvidence(board, cycles);
          markCycleEvidenceRecovered(cwd);
        }
      } catch {
        // Still unavailable — the next probe (or an explicit `withCycles` read) retries.
      } finally {
        probes.delete(cwd);
      }
    })(),
  );
}

/**
 * Return a snapshot bead guaranteed to carry its description, so detail views can be served off the
 * already-loaded list without a fresh `bd show`. `bd list --json` carries the description on
 * structured boards, so a snapshot bead is returned as-is — zero bd spawns. When the list omits it
 * (the one field it can drop), the description is fetched once via `bd show` and memoized (see
 * getBeadDescription), so repeat opens of the same bead stay warm.
 */
export async function ensureDescription(
  cwd: string,
  lite: Bead,
): Promise<Bead> {
  if (lite.description !== undefined) return lite;
  const description = await getBeadDescription(cwd, lite.id, async () => {
    // Let transient bd failures reject: getBeadDescription must not turn a failed read into a
    // successfully cached empty contract. A later detail open can then retry the read.
    const full = await beads.show(cwd, lite.id);
    return full?.description;
  });
  return { ...lite, description };
}
