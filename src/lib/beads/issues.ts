import { beads, type Bead, type DepCycle } from "./bd";
import { attachCycleEvidence, cycleEvidenceFor } from "./cycle-evidence";
import {
  getBeadDescription,
  hydrateIssueSnapshot,
  issueSnapshotGeneration,
  issueSnapshotVersion,
  markCycleEvidenceRecovered,
  probeIssueSnapshot,
  readIssueSnapshot,
  refreshIssueSnapshotRead,
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
  } catch (error) {
    // Only old CLI versions rejecting this status need two listings. Retrying timeouts or
    // connection failures doubles load precisely when the database is already struggling.
    const message = error instanceof Error ? error.message : String(error);
    if (!/(?:invalid|unknown|unsupported) (?:value for |flag: )?(?:issue )?(?:--)?status[: =]*["']?all\b/i.test(message)) throw error;
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
  /**
   * Skip the `sameBlocksEdges` consistency recheck below even when `work` carries a `blocks` edge.
   *
   * The recheck exists for `orderTickets` (execute-epic-board.ts), which sorts `board`'s raw edges
   * directly and can hit a pair that `bd dep cycles` already resolved but this snapshot's
   * `dependencies` still encode, falling back to unvalidated input order for the tickets it
   * touches.
   *
   * NOT a safe opt-out for a `structureGaps`/`makeApprovalGate` consumer (PR #274 review,
   * round 17 — corrects the previous version of this doc, which claimed `approveAndClaim`'s
   * locked guard could skip it): those gates read `cycleEvidenceFor(board)` for the cycle rule
   * only, but `structureGaps` also walks `board`'s raw `blocks` edges DIRECTLY for the dangling
   * blocker, self-block and duplicates-parent rules — the same stale edges `sameBlocksEdges`
   * exists to catch. Skipping the recheck there lets an edge that changed between the `work` read
   * and the `bd dep cycles` read (another writer landing on a shared-server board) go unnoticed by
   * BOTH the cycle check (which only ever sees the fresher `cycles` result) and these structural
   * rules (which are stuck on the older `work` snapshot) — approving or claiming a target whose
   * structure just changed. Only a caller whose guard consumes cycle evidence and NOTHING else off
   * `board`'s edges may set this.
   */
  skipCycleConsistencyRecheck?: boolean;
  /**
   * When the `bd dep cycles` fetch itself fails (timeout, unreadable output), return `board`
   * without cycle evidence attached instead of rejecting the whole read.
   *
   * Mirrors gardener/apply.ts's `withCycleEvidenceIfNeeded`: a caller whose approve/unapprove
   * write-time re-check is documented to degrade the same way its decide-time counterpart does
   * (apply-steps.ts `readWholeBoard`, consumed by `lockedWrite`/`assertStartHolds`) must not have
   * a `bd dep cycles` outage hard-fail the whole re-read — the move's own approval-gap check
   * already fails closed on the missing evidence via `missingCycleEvidenceGap`. NOT the default:
   * `approveAndClaim`'s locked guard deliberately wants the hard failure when it opts into cycles
   * at all (see its own `withCycles` doc) — only a caller that reads `LoadIssuesOptions` docs and
   * decides it wants graceful degradation should set this.
   */
  degradeCyclesOnFailure?: boolean;
}

/**
 * Bound on the `sameBlocksEdges` consistency retry below. Each retry is a full re-read of the
 * board plus `bd dep cycles`, so an unbounded loop lets a board under sustained shaping (or
 * concurrent writers on a shared-server board) keep a caller inside this function indefinitely,
 * repeatedly spawning `bd list`/`bd dep cycles` with no wall-clock limit — per-command timeouts
 * don't bound the *count* of commands. Past this many attempts the graph is moving faster than we
 * can read it consistently, so this fails closed (rejects) rather than pairing evidence with a
 * board it may not describe. Callers that need withCycles already treat rejection as a normal
 * retry-elsewhere signal (see the `strictGates`/`withCycles` doc above and execute-epic-start).
 */
const MAX_CYCLE_CONSISTENCY_RETRIES = 3;

export async function loadAllIssues(
  cwd: string,
  opts: LoadIssuesOptions = {},
  attempt = 0,
): Promise<Bead[]> {
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
  // Fetched AFTER `board` is fully assembled, not alongside `loadWorkIssues` (PR #274 review):
  // `bd dep cycles` and `bd list`/gate listing are independent CLI reads with no shared transaction,
  // so starting the cycles read first — or even just concurrently — lets it settle against an OLDER
  // graph revision than the one `board`'s edges end up reflecting (another machine can repair or
  // introduce a cycle in the gap). `structureGaps` trusts this evidence rather than re-traversing
  // `board`'s edges, so stale-but-empty evidence would let a genuinely cyclic board read as clean.
  // Starting this read only once `board` is in hand guarantees (under the store's monotonic-read
  // guarantee) it observes a graph at least as current as `board`'s own — evidence can be newer than
  // the board it's attached to, never older.
  if (!opts.withCycles) return board;
  let cycles: DepCycle[];
  try {
    cycles = await beads.depCycles(cwd);
  } catch (e) {
    if (!opts.degradeCyclesOnFailure) throw e;
    console.warn(
      `[beads.issues] ${cwd}: dep cycles read failed on a re-check that opted into graceful ` +
        `degradation — returning the board without cycle evidence rather than failing the whole ` +
        `read: ` + (e instanceof Error ? e.message : String(e)),
    );
    return board;
  }
  // "Never older" is not "consistent": a `cycles` result only proves the graph's cycle set is
  // accurate AS OF this call, not that `work`'s own edges (snapshotted before it) still describe
  // that same graph. A repair landing in the gap between the two reads can remove one edge of a
  // cycle `work` already captured, so `cycles` comes back empty (or non-empty but missing that
  // cycle) while `board`'s edges still encode the now-resolved cycle. `structureGaps` scopes
  // reported cycle membership to the approval/claim target's own subtree (PR #274 review, round
  // 17): a non-empty `cycles` result is the fail-safe answer only for the cycle(s) it actually
  // names — a board can hold cycle A inside the target and an unrelated cycle B elsewhere, and a
  // concurrent writer repairing A between the two reads leaves `cycles` non-empty (still reporting
  // B) while `board`'s raw edges still encode the resolved A. `structureGaps` never sees A (it isn't
  // in the evidence and isn't B's target) and declares the target clean, while `orderTickets`
  // (execute-epic-board.ts), which sorts `board`'s raw edges directly, hits the still-cyclic A pair
  // and falls back to input order for the tickets it touches — dispatching by an ordering nobody
  // validated. So this must run for a non-empty `cycles` too, not only when it's empty: re-listing
  // and comparing edges catches either case — if the graph moved between the two reads, retry
  // against whatever is current instead of pairing evidence with a board it no longer describes.
  //
  // Also gated on `board` actually carrying a `blocks` edge: a board with zero `blocks` edges has no
  // cyclic pair that could be stale, so the second `bd list` this recheck costs would buy nothing.
  // That alone is not enough to keep approve's read-economy invariant (at most two `bd list` calls)
  // true, though — any repo with an established `blocks` edge ANYWHERE still pays it on every
  // `withCycles` read, which is the common case, not the rare one. `skipCycleConsistencyRecheck` is
  // what actually restores the invariant for the callers that don't need this guarantee (see its
  // doc above) — this `boardHasBlocksEdge` clause only spares the genuinely edge-free board on top
  // of that.
  //
  // Compared against a fresh `loadAllIssues` (work + gates), not `loadWorkIssues` (work only, P2
  // badge review, PR #274): `bd dep cycles` walks `blocks` edges owned by gate beads too, and a gate
  // is exactly the thing `board` carries that `work` doesn't. A gate-owned edge added or removed
  // between the `cycles` fetch above and this recheck would leave `work`'s own edge set unchanged,
  // so comparing only `work` waves the recheck through with evidence that no longer describes
  // `board`'s actual graph.
  const boardHasBlocksEdge = beads.edgesOf(board).some((e) => e.type === "blocks");
  if (
    boardHasBlocksEdge &&
    !opts.skipCycleConsistencyRecheck &&
    !sameBlocksEdges(board, await loadAllIssues(cwd))
  ) {
    if (attempt >= MAX_CYCLE_CONSISTENCY_RETRIES) {
      throw new Error(
        `[beads.issues] ${cwd}: dependency graph kept moving across ${MAX_CYCLE_CONSISTENCY_RETRIES + 1} ` +
          "reads of bd list/bd dep cycles — giving up rather than pairing cycle evidence with a board it may not describe",
      );
    }
    return loadAllIssues(cwd, opts, attempt + 1);
  }
  return attachCycleEvidence(board, cycles);
}

/** Whether two bead lists agree on every `blocks` edge — the only edge type `bd dep cycles` walks. */
function sameBlocksEdges(a: Bead[], b: Bead[]): boolean {
  const key = (e: { from: string; to: string; type: string }) => `${e.from}>${e.to}:${e.type}`;
  const toSet = (list: Bead[]) =>
    new Set(beads.edgesOf(list).filter((e) => e.type === "blocks").map(key));
  const [setA, setB] = [toSet(a), toSet(b)];
  return setA.size === setB.size && [...setA].every((k) => setB.has(k));
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
 *
 * `generation` must be the value read atomically alongside `board` (i.e. from the same
 * `readIssueSnapshot`/`getIssueSnapshot` call), never a fresh `issueSnapshotGeneration(cwd)` read
 * taken here (PR #274 review, round 13): a caller that fetches `board` and only then asks this
 * function to resolve the generation leaves a gap — bridged by at least one `await` back up the
 * call stack — in which a background refresh can replace the retained snapshot. A fresh read at
 * that point returns the NEW generation while `board` is still the OLD, retired array; the guard
 * below would then compare the new generation against itself and happily stamp the new graph's
 * cycle result onto the old board.
 */
async function attachCyclesBestEffort(cwd: string, board: Bead[], generation: number): Promise<void> {
  try {
    const cycles = await fetchCyclesShared(cwd, generation);
    // A write replaced the snapshot while this fetch was in flight: `cycles` describes the graph
    // this generation's board no longer represents. Leave evidence unattached rather than stamp a
    // stale-graph result as current — the next probe or read retries against the new generation.
    if (issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
      // Neither an empty NOR a non-empty `cycles` result proves `board`'s OWN `blocks` edges
      // (captured earlier, possibly by another process's snapshot load) still describe the graph
      // `cycles` was just computed against. On a shared-server board another machine can repair one
      // cycle while leaving an unrelated one in place between this fetch starting and settling: the
      // generation guard above only catches THIS process replacing its own snapshot, not the
      // underlying repo moving without a local refresh noticing yet — so a non-empty result can
      // still be paired with a stale `board` whose edges no longer match what `cycles` describes
      // (PR #274 review, round 21: the `cycles.length > 0` shortcut here let that stale pairing
      // through). Always re-list and compare, same as `loadAllIssues`'s `sameBlocksEdges` retry (PR
      // #274 review, round 18). Compared against a fresh `loadAllIssues`, not `loadWorkIssues`, so a
      // board that merged in gate beads is compared like-for-like instead of always mismatching on
      // their edges.
      //
      // Gated on `board` actually carrying a `blocks` edge, same as `loadAllIssues`'s own
      // `workHasBlocksEdge` clause: a board with zero `blocks` edges has no cyclic pair that could be
      // stale, so this second full read would buy nothing — and every `getBoard`/`allIssues` caller
      // hits this path on a cold read, so paying for it unconditionally breaks the documented
      // at-most-one-`bd list` invariant for the common edge-free case.
      const boardHasBlocksEdge = beads.edgesOf(board).some((e) => e.type === "blocks");
      const consistent = !boardHasBlocksEdge || sameBlocksEdges(board, await loadAllIssues(cwd));
      // Re-check generation and evidence AFTER the `sameBlocksEdges` await, not just before it (PR
      // #274 review, round 19): that inner `loadAllIssues` call can itself take long enough for the
      // snapshot to be invalidated/replaced, or for a concurrent enrichment path to attach evidence to
      // this same `board` (evidence is keyed by array identity, not by caller). Attaching on the stale
      // pre-await checks alone would pair this cycles result with a board it may no longer describe,
      // or clobber evidence a racing caller already attached, while still bumping the version as if
      // this were the recovery — nothing downstream re-validates that pairing (`allIssues` has no
      // post-enrichment generation check), so a mismatched board would flow straight to consumers.
      if (consistent && issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
        attachCycleEvidence(board, cycles);
        markCycleEvidenceRecovered(cwd);
      }
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
 *
 * Neither an empty NOR a non-empty `cycles` result proves `board`'s OWN `blocks` edges still
 * describe the graph `cycles` was just computed against: on a shared-server board another writer can
 * repair or introduce a cycle in the gap between the caller's read and this fetch settling (codex
 * review, PR #274). `board` is typically the caller's own cached snapshot array (not a defensive
 * copy), so blindly attaching here would both pair a stale board with fresher evidence — the
 * pre-lock caller's own gate could then 422 a since-repaired board, or wave through a since-broken
 * one — AND publish that mismatched pairing to every other reader sharing the snapshot. Always
 * re-list and compare, same as `attachCyclesBestEffort`/`probeCycleEvidence`; gated on `board`
 * actually carrying a `blocks` edge, same as those siblings' own guard, since an edge-free board has
 * no cyclic pair that could be stale. An inconsistent board is left without evidence rather than
 * retried here — every consumer of `cycleEvidenceFor` already fails closed on `undefined`
 * (`missingCycleEvidenceGap`), and a caller that must not proceed on a stale pairing gets exactly
 * that by falling through to the same closed failure a genuinely missing read produces.
 *
 * Also guarded by `generation` — rechecked against `issueSnapshotGeneration` after the `depCycles`
 * call AND after the `sameBlocksEdges` re-list (P2 badge review, PR #274, round 22): the
 * `consistent` check alone only proves `board`'s `blocks` edges still match a fresh listing, not
 * that `board` is still the entry's retained array. A background refresh (or another writer, on a
 * shared-server board) can swap the retained snapshot for a new array that happens to preserve the
 * same edges while either await above is in flight — `sameBlocksEdges` reads as consistent, but
 * `board` is now a retired object no later reader can reach. Attaching evidence to it and calling
 * `markCycleEvidenceRecovered` would still bump the shared version, telling every poller the
 * retained board recovered when it, in fact, remains evidence-less.
 *
 * `generation` MUST be the value the caller captured atomically alongside `board` itself (e.g. from
 * {@link refreshAllIssuesRead}/{@link readIssueSnapshot}), never sampled fresh from
 * `issueSnapshotGeneration` inside this function (P2 badge review, PR #274, round 24 on this line):
 * a caller routinely does real work — resolving an operator, parsing the request body, walking the
 * bead contract — between fetching `board` and reaching this call, and a background refresh can
 * replace the retained snapshot in that gap. Sampling the generation only here would then compare
 * "current" against itself and trivially pass, even though `board` is already the retired array —
 * exactly the bug {@link attachCyclesBestEffort} guards against by requiring its own `generation`
 * parameter for the same reason.
 */
export async function ensureCycleEvidence(
  cwd: string,
  board: Bead[],
  generation: number,
): Promise<Bead[]> {
  if (cycleEvidenceFor(board) === undefined) {
    const cycles = await beads.depCycles(cwd);
    const boardHasBlocksEdge = beads.edgesOf(board).some((e) => e.type === "blocks");
    const consistent = !boardHasBlocksEdge || sameBlocksEdges(board, await loadAllIssues(cwd));
    // Recheck evidence AFTER the `sameBlocksEdges` await, not just before it, mirroring
    // `attachCyclesBestEffort`: a concurrent enrichment path sharing this same `board` array (evidence
    // is keyed by array identity) may have already attached it while the re-list above was in flight.
    if (
      consistent &&
      issueSnapshotGeneration(cwd) === generation &&
      cycleEvidenceFor(board) === undefined
    ) {
      attachCycleEvidence(board, cycles);
      markCycleEvidenceRecovered(cwd);
    }
  }
  return board;
}

export async function allIssues(
  cwd: string,
  opts?: SnapshotReadOptions & { withCycles?: boolean },
): Promise<Bead[]> {
  // Read via `readIssueSnapshot`, not `getIssueSnapshot`, so the generation passed to
  // `attachCyclesBestEffort` below is the one this exact `board` array was returned with, not a
  // fresh (possibly already-advanced) one read after the fact (PR #274 review, round 13).
  const { beads: board, generation } = await readIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
  // The snapshot key is the repository, not every reader's projection needs. A warm page snapshot
  // may therefore predate an approval reader: enrich that exact array rather than treating absent
  // evidence as an authoritative empty result.
  if (opts?.withCycles && cycleEvidenceFor(board) === undefined) {
    await attachCyclesBestEffort(cwd, board, generation);
  }
  return board;
}

/**
 * Bound on the "board moved during enrichment" retry below (mirrors `MAX_CYCLE_CONSISTENCY_RETRIES`
 * for `loadAllIssues`). Each retry re-runs the full snapshot read plus a `bd dep cycles` spawn, so
 * sustained shaping or a busy shared-server board can otherwise keep a caller (a board poll, an
 * approval read) inside this function indefinitely. Fail closed once the graph outraces this many
 * attempts rather than pairing evidence with a board it may no longer describe.
 */
const MAX_ENRICHMENT_RETRIES = 3;

/** Beads plus the snapshot version they carry, read atomically — for callers that stamp a response
 * with the version (the board freshness token) and must not desync data from version. */
export async function readAllIssues(
  cwd: string,
  opts?: SnapshotReadOptions & { withCycles?: boolean },
  attempt = 0,
): Promise<SnapshotRead> {
  const snapshot = await readIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
  // Keep evidence attached to the cached array itself: `SnapshotRead` is a wrapper and copying the
  // board would lose the sidecar that pure approval projections consume.
  if (opts?.withCycles && cycleEvidenceFor(snapshot.beads) === undefined) {
    // Read from the snapshot itself, not a fresh `issueSnapshotGeneration(cwd)` call: a concurrent
    // background refresh can land (and bump the generation) in the microtask gap between the `await
    // readIssueSnapshot` above resolving and this line running, which would otherwise pair the OLD
    // `snapshot.beads` with an already-advanced "current" generation and let `attachCyclesBestEffort`
    // (whose own guard compares against that same already-advanced value) enrich a retired array.
    const generation = snapshot.generation;
    await attachCyclesBestEffort(cwd, snapshot.beads, generation);
    // Check the move BEFORE the evidence-attached check, not nested inside it (PR #274 review,
    // round 13): `attachCyclesBestEffort` now declines to attach when the board moved out from
    // under it (its own generation guard, checked against the SAME `generation` passed in here), so
    // a mismatch means `snapshot.beads` is a retired array that never got enriched at all — nesting
    // this check inside "evidence attached" would let that retired, evidence-less board fall through
    // to the plain `return snapshot` below instead of retrying, silently serving stale beads with no
    // cycle evidence. Retry unconditionally on a mismatch so the caller always gets a consistent,
    // current (board, version) pair rather than one the write already left behind.
    if (issueSnapshotGeneration(cwd) !== generation) {
      if (attempt >= MAX_ENRICHMENT_RETRIES) {
        throw new Error(
          `[beads.issues] ${cwd}: dependency graph kept moving across ${MAX_ENRICHMENT_RETRIES + 1} ` +
            "cycle-enrichment reads — giving up rather than pairing evidence with a board it may not describe",
        );
      }
      return readAllIssues(cwd, opts, attempt + 1);
    }
    // No move: only re-read the version if THIS array actually got enriched. When it did,
    // `markCycleEvidenceRecovered` bumped the version for it specifically (PR #274 review, round 4),
    // so `snapshot.version` (captured before that bump) would understate it — re-read to describe the
    // exact (now-enriched) board being returned. When it didn't (a `bd dep cycles` failure, not a
    // move — the move case already returned above), fall through to the plain snapshot below.
    if (cycleEvidenceFor(snapshot.beads) !== undefined) {
      return { beads: snapshot.beads, version: issueSnapshotVersion(cwd), generation };
    }
  }
  return snapshot;
}

/**
 * Bound on the "board moved during strict-gate hydration" retry below (mirrors
 * `MAX_ENRICHMENT_RETRIES`). Each retry re-runs the full snapshot read plus a strict
 * `loadGateIssues` spawn, so sustained writes against a dangling-gate board could otherwise keep a
 * caller (an approval request) recursing indefinitely. Fail closed once the graph outraces this
 * many attempts rather than serve gate evidence that may not describe the current board.
 */
const MAX_STRICT_GATE_RETRIES = 3;

export async function refreshAllIssues(
  cwd: string,
  opts: LoadIssuesOptions = {},
  attempt = 0,
): Promise<Bead[]> {
  return (await refreshAllIssuesRead(cwd, opts, attempt)).beads;
}

/**
 * Like {@link refreshAllIssues} but also returns the generation the resolved board was retained
 * under, captured atomically alongside the array itself — for a caller that must hand both to a
 * function like {@link ensureCycleEvidence} later, possibly after doing real work in between (P2
 * badge review, PR #274, round 24). A caller that only has the plain `Bead[]` and re-derives the
 * generation with a fresh `issueSnapshotGeneration(cwd)` call at that later point would compare
 * "current" against itself and trivially pass even when the board it's pairing against has already
 * been replaced by a background refresh — see `ensureCycleEvidence`'s own doc for the failure this
 * closes.
 */
export async function refreshAllIssuesRead(
  cwd: string,
  opts: LoadIssuesOptions = {},
  attempt = 0,
): Promise<{ beads: Bead[]; generation: number }> {
  // Read via `refreshIssueSnapshotRead`, not `refreshIssueSnapshot` + a separate
  // `issueSnapshotGeneration(cwd)` call, so `boardGeneration` is the generation `board` was
  // actually retained under (PR #274 review, round 16): this promise is single-flight, and another
  // consumer of that same promise — including one that invalidates or hydrates the entry — can run
  // its own continuation before this `await` resumes, advancing the generation in the gap a
  // separate post-hoc read would land in. `hydrateIssueSnapshot`'s guard would then see that NEWER
  // generation match and accept `hydrated` (built from THIS stale `board`), overwriting the
  // already-current cache and hiding the concurrent change from `getBoard` and other warm readers.
  const { beads: board, generation: boardGeneration } = await refreshIssueSnapshotRead(cwd, () =>
    loadAllIssues(cwd, opts),
  );
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
    // Best-effort, like every other cycles path in this file (`attachCyclesBestEffort`,
    // `probeCycleEvidence`) — NOT let a failed `bd dep cycles` reject this call (PR #274 review,
    // round 17): the comment above promises a caller "never loses the requested evidence", which
    // reads as the same degrade-gracefully contract those siblings give, but an uncaught rejection
    // here previously failed the WHOLE forced refresh over an auxiliary enrichment query — taking
    // down a caller's ordinary bead listing along with it. No production caller passes
    // `withCycles: true` today, so this was latent, but the next one to add it would inherit a
    // refresh that 500s on a slow or unreadable `bd dep cycles` instead of returning a board with
    // no cycle evidence attached, same as a cold read degrades.
    try {
      // Keyed and guarded by `boardGeneration`, not a fresh `issueSnapshotGeneration(cwd)` read
      // here (PR #274 review, round 15): the snapshot can move again while this fetch is in
      // flight, and a fresh read at either point would key the shared fetch to — or stamp its
      // result onto `board` under — a generation that no longer describes the graph `cycles` was
      // actually fetched for.
      const cycles = await fetchCyclesShared(cwd, boardGeneration);
      if (issueSnapshotGeneration(cwd) === boardGeneration) {
        attachCycleEvidence(board, cycles);
        markCycleEvidenceRecovered(cwd);
      }
    } catch (e) {
      console.warn(
        `[beads.issues] ${cwd}: dep cycles read failed during refresh — board stays readable ` +
          `without cycle evidence; startability projections fail closed until the next successful read: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
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
      // resolved gate's `blocks` edge as still dangling and open. See `hydrateIssueSnapshot`. Guarded
      // by `boardGeneration`, captured above alongside `board` itself rather than re-read here — see
      // that capture site for why a fresh read at this point would be too late.
      const hydrated = dedupeById([...board, ...await loadGateIssues(cwd, true, dangling)]);
      // A write can invalidate the entry while the strict `loadGateIssues` await above is in
      // flight — `hydrateIssueSnapshot`'s own generation guard then correctly refuses to stamp
      // `hydrated` onto the (now different) entry. Without this check we'd still return that
      // retired array here, handing an approval-path caller beads read before the write (PR #274
      // review, thread on this line). Retry against the current board instead of serving stale
      // gate evidence.
      if (issueSnapshotGeneration(cwd) !== boardGeneration) {
        if (attempt >= MAX_STRICT_GATE_RETRIES) {
          throw new Error(
            `[beads.issues] ${cwd}: dependency graph kept moving across ${MAX_STRICT_GATE_RETRIES + 1} ` +
              "strict-gate hydration reads — giving up rather than pairing gate evidence with a board it may not describe",
          );
        }
        return refreshAllIssuesRead(cwd, opts, attempt + 1);
      }
      // `dedupeById` allocates a new array, and the cycle sidecar is WeakMap-keyed on array identity
      // (cycle-evidence.ts) — so a caller combining `withCycles` and `strictGates` would otherwise
      // lose the evidence just attached to `board` above the moment this branch rebuilds it (PR #274
      // review). Re-attach onto the rebuilt array before it's cached or returned.
      const cycles = cycleEvidenceFor(board);
      if (cycles !== undefined) attachCycleEvidence(hydrated, cycles);
      hydrateIssueSnapshot(cwd, hydrated, boardGeneration);
      // `hydrateIssueSnapshot` bumps the generation synchronously (no `await` between the call and
      // this read), so `issueSnapshotGeneration(cwd)` here is exactly the generation `hydrated` was
      // just retained under — not `boardGeneration`, which named the PRE-hydration entry.
      return { beads: hydrated, generation: issueSnapshotGeneration(cwd) };
    }
  }
  return { beads: board, generation: boardGeneration };
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
        // Read via `readIssueSnapshot`, not `getIssueSnapshot` + a follow-up `issueSnapshotGeneration`
        // call: the two reads aren't atomic, so a concurrent refresh landing in the gap could hand back
        // a `board` and a `generation` describing two different graphs (PR #274 review, round 8) — the
        // same hazard `allIssues`/`readAllIssues` above were fixed for.
        const { beads: board, generation } = await readIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, {
          blockOnPendingWrite: false,
        });
        if (cycleEvidenceFor(board) !== undefined) return;
        const cycles = await fetchCyclesShared(cwd, generation);
        // Recheck evidence: a concurrent `attachCyclesBestEffort` sharing this fetch (or a probe
        // that beat this one to it) may already have attached it — and bumped the version — while
        // this awaited the shared CLI call. Recheck generation too: a write replacing the snapshot
        // mid-fetch means `cycles` describes a graph this board no longer represents, so it must
        // not be stamped onto it as current (PR #274 review, round 7).
        if (issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
          // Neither an empty NOR a non-empty `cycles` result proves `board`'s OWN `blocks` edges
          // still describe that same graph: on a shared-server board another machine can repair one
          // cycle while leaving an unrelated one in place in the gap between this fetch starting and
          // settling, without the local generation moving (generation only bumps on a LOCAL snapshot
          // replacement) — so a non-empty result can still be paired with a stale `board` (PR #274
          // review, round 21: the `cycles.length > 0` shortcut here let that stale pairing through).
          // Always re-list and compare before attaching, same as `attachCyclesBestEffort` (PR #274
          // review, round 20), then recheck generation/evidence again after that await — the re-list
          // itself can take long enough for another writer to land. Gated on `board` actually
          // carrying a `blocks` edge, same as `attachCyclesBestEffort`'s own guard: an edge-free
          // board has no cyclic pair that could be stale, so the re-list would buy nothing.
          const boardHasBlocksEdge = beads.edgesOf(board).some((e) => e.type === "blocks");
          const consistent = !boardHasBlocksEdge || sameBlocksEdges(board, await loadAllIssues(cwd));
          if (consistent && issueSnapshotGeneration(cwd) === generation && cycleEvidenceFor(board) === undefined) {
            attachCycleEvidence(board, cycles);
            markCycleEvidenceRecovered(cwd);
          }
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
