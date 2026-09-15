import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./bd";
import { attachCycleEvidence, cycleEvidenceFor } from "./cycle-evidence";
import {
  ISSUE_SNAPSHOT_MAX_AGE_MS,
  getBeadDescription,
  getIssueSnapshot,
  invalidateIssueSnapshot,
  issueSnapshotGeneration,
  issueSnapshotVersion,
  onBoardChanged,
  readIssueSnapshot,
  refreshIssueSnapshot,
  resetIssueSnapshots,
} from "./snapshot";

const bead = (id: string): Bead => ({ id, title: id, status: "open" });

beforeEach(resetIssueSnapshots);

describe("issue snapshots", () => {
  it("deduplicates concurrent cold loads and reuses the warm result", async () => {
    let resolve!: (value: Bead[]) => void;
    const loader = vi.fn(() => new Promise<Bead[]>((done) => (resolve = done)));

    const first = getIssueSnapshot("/repo", loader, 100);
    const concurrent = getIssueSnapshot("/repo", loader, 100);
    expect(loader).toHaveBeenCalledTimes(1);

    resolve([bead("one")]);
    await expect(first).resolves.toEqual([bead("one")]);
    await expect(concurrent).resolves.toEqual([bead("one")]);
    await expect(getIssueSnapshot("/repo", loader, 101)).resolves.toEqual([
      bead("one"),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves stale data immediately while refreshing in the background", async () => {
    const loader = vi
      .fn<() => Promise<Bead[]>>()
      .mockResolvedValueOnce([bead("old")])
      .mockResolvedValueOnce([bead("new")]);
    await getIssueSnapshot("/repo", loader, 100);

    await expect(
      getIssueSnapshot("/repo", loader, 100 + ISSUE_SNAPSHOT_MAX_AGE_MS),
    ).resolves.toEqual([bead("old")]);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await expect(getIssueSnapshot("/repo", loader, 200)).resolves.toEqual([
      bead("new"),
    ]);
  });

  it("preserves the last valid data when a background refresh fails", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("safe")], 100);
    await expect(
      refreshIssueSnapshot("/repo", async () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    await expect(getIssueSnapshot("/repo", async () => [])).resolves.toEqual([
      bead("safe"),
    ]);
  });

  it("isolates repositories and increments versions only for local invalidation", async () => {
    await refreshIssueSnapshot("/a", async () => [bead("a")]);
    await refreshIssueSnapshot("/b", async () => [bead("b")]);
    const aVersion = issueSnapshotVersion("/a");
    const bVersion = issueSnapshotVersion("/b");

    invalidateIssueSnapshot("/a", true);
    expect(issueSnapshotVersion("/a")).toBe(aVersion + 1);
    expect(issueSnapshotVersion("/b")).toBe(bVersion);
  });

  it("keeps the retained array's identity across a refresh with identical content that didn't ask for it", async () => {
    // Cycle evidence is a WeakMap sidecar keyed on array identity (cycle-evidence.ts). An ordinary
    // refresh whose content hasn't changed must reuse the retained array rather than latch a
    // fresh-but-identical one (PR #274 review round 9): a concurrent cycle probe racing this refresh
    // may already hold a reference to the retained array and attach evidence to THAT object, and
    // swapping in a new object here would silently discard that attachment even though the probe
    // reported success. Reusing identity means evidence attached to the retained array — before,
    // during, or after this refresh — stays visible.
    const first = await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);
    attachCycleEvidence(first, [{ ids: ["a"], raw: {} }]);

    const second = await refreshIssueSnapshot("/repo", async () => [bead("a")], 200);

    expect(second).toBe(first);
    expect(cycleEvidenceFor(second)).toEqual([{ ids: ["a"], raw: {} }]);
  });

  it("does not discard evidence a concurrent probe attached to the retained array while an unrelated refresh was in flight", async () => {
    // Reproduces the board/route.ts poll race (PR #274 review): probeAllIssues (an ordinary,
    // cycles-blind refresh) and probeCycleEvidence (which attaches evidence to whatever array
    // getIssueSnapshot handed it) fire together. If the ordinary refresh replaced the retained array
    // even on unchanged content, evidence the probe attached to the now-discarded old array would
    // never surface through the entry again.
    const retained = await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);

    let resolveRefresh!: (beads: Bead[]) => void;
    const refresh = refreshIssueSnapshot(
      "/repo",
      () => new Promise<Bead[]>((resolve) => (resolveRefresh = resolve)),
      200,
    );

    // The probe attaches evidence to the array it read BEFORE the in-flight refresh resolves —
    // exactly the object `retained` points to, since the entry hasn't moved yet.
    attachCycleEvidence(retained, [{ ids: ["a"], raw: {} }]);

    resolveRefresh([bead("a")]);
    const next = await refresh;

    expect(next).toBe(retained);
    expect(cycleEvidenceFor(next)).toEqual([{ ids: ["a"], raw: {} }]);
  });

  it("carries evidence the refresh itself fetched onto the retained array's identity", async () => {
    // Mirrors `refreshAllIssues({ withCycles: true })`: the loader's own result already carries
    // evidence attached to a freshly-allocated array. Content is unchanged, so the retained array's
    // identity is kept — the fresh evidence must be copied onto it rather than dropped along with
    // the array it arrived on.
    await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);

    const withEvidence = await refreshIssueSnapshot(
      "/repo",
      async () => attachCycleEvidence([bead("a")], [{ ids: ["a"], raw: {} }]),
      200,
    );

    expect(cycleEvidenceFor(withEvidence)).toEqual([{ ids: ["a"], raw: {} }]);
  });

  it("does not carry stale cycle evidence forward once the graph content actually changes", async () => {
    const first = await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);
    attachCycleEvidence(first, [{ ids: ["a"], raw: {} }]);

    const second = await refreshIssueSnapshot(
      "/repo",
      async () => [bead("a"), bead("b")],
      200,
    );

    expect(cycleEvidenceFor(second)).toBeUndefined();
  });

  it("bumps the generation when a refresh discovers changed content with no invalidation call in between (PR #274 review, round 8)", async () => {
    // A shared-server board can move because ANOTHER machine wrote it — this repo only ever learns
    // of that through a plain TTL refresh noticing the content differs, never through
    // `invalidateIssueSnapshot`. The generation still has to move, or a cycles fetch started against
    // the pre-refresh graph coalesces onto the replaced board as if it described it (issues.ts's
    // `fetchCyclesShared`).
    await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);
    const before = issueSnapshotGeneration("/repo");

    await refreshIssueSnapshot("/repo", async () => [bead("a"), bead("b")], 200);
    expect(issueSnapshotGeneration("/repo")).toBe(before + 1);
  });

  it("does not bump the generation when a refresh lands identical content", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);
    const before = issueSnapshotGeneration("/repo");

    await refreshIssueSnapshot("/repo", async () => [bead("a")], 200);
    expect(issueSnapshotGeneration("/repo")).toBe(before);
  });

  it("bumps the version when a refresh recovers cycle evidence even though bead content is unchanged", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("a")], 100);
    const before = issueSnapshotVersion("/repo");

    // Content is identical to the prior read, but this load itself attaches evidence the retained
    // snapshot never had — a poller stuck on "evidence unavailable" needs a fresh token for this,
    // not only for a content change.
    const recovered = await refreshIssueSnapshot(
      "/repo",
      async () => attachCycleEvidence([bead("a")], [{ ids: ["a"], raw: {} }]),
      200,
    );

    expect(cycleEvidenceFor(recovered)).toEqual([{ ids: ["a"], raw: {} }]);
    expect(issueSnapshotVersion("/repo")).toBe(before + 1);
  });

  it("blocks a full board read on a fresh post-write load instead of serving the stale board", async () => {
    const loader = vi
      .fn<() => Promise<Bead[]>>()
      .mockResolvedValueOnce([bead("old")])
      .mockResolvedValueOnce([bead("new")]);
    await getIssueSnapshot("/repo", loader, 0);
    invalidateIssueSnapshot("/repo", true);

    // A local write bumps the version but retains last-good data. A full board read must NOT hand
    // back the stale board stamped with the advanced version (a version poll would then treat it as
    // current) — it blocks on a fresh post-write load so write-then-navigate/server-render is fresh.
    await expect(getIssueSnapshot("/repo", loader, 1)).resolves.toEqual([
      bead("new"),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);

    // Once a post-write read has landed, reads serve warm again — no further load.
    await expect(getIssueSnapshot("/repo", loader, 2)).resolves.toEqual([
      bead("new"),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("serves the retained board without blocking on a pending write when blockOnPendingWrite is false", async () => {
    let resolvePostWrite!: (value: Bead[]) => void;
    const loader = vi
      .fn<() => Promise<Bead[]>>()
      .mockResolvedValueOnce([bead("old")])
      .mockImplementationOnce(
        () => new Promise<Bead[]>((done) => (resolvePostWrite = done)),
      );
    await getIssueSnapshot("/repo", loader, 0);
    invalidateIssueSnapshot("/repo", true);

    // The non-blocking poll path serves last-good immediately even while a write is pending, kicking
    // the post-write load in the background rather than awaiting the cold bd read.
    await expect(
      getIssueSnapshot("/repo", loader, 1, { blockOnPendingWrite: false }),
    ).resolves.toEqual([bead("old")]);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));

    // Once the background post-write read lands, the pending write clears and reads serve it.
    resolvePostWrite([bead("new")]);
    await vi.waitFor(async () =>
      expect(await getIssueSnapshot("/repo", loader, 2)).toEqual([bead("new")]),
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("falls back to the retained board when the post-write read fails", async () => {
    await getIssueSnapshot("/repo", async () => [bead("old")], 0);
    invalidateIssueSnapshot("/repo", true);

    // A transient bd failure on the forced post-write read must serve last-good, never throw the
    // render — the same fall-back the API forced-reload path relies on.
    await expect(
      getIssueSnapshot(
        "/repo",
        async () => Promise.reject(new Error("boom")),
        1,
      ),
    ).resolves.toEqual([bead("old")]);
  });

  it("serves a cold load that raced a local write instead of an empty board", async () => {
    let resolveCold!: (value: Bead[]) => void;
    const coldLoader = vi.fn(
      () => new Promise<Bead[]>((resolve) => (resolveCold = resolve)),
    );
    const read = readIssueSnapshot("/repo", coldLoader, 0);

    // The write lands while the only load is in flight: the generation guard will refuse to cache
    // that result, but the read still asked for a board and one was successfully loaded.
    invalidateIssueSnapshot("/repo", true);
    resolveCold([bead("loaded")]);

    // Version 1: the write bumped it, the discarded load did not.
    await expect(read).resolves.toEqual({
      beads: [bead("loaded")],
      version: 1,
    });

    // …and the guard still holds: the raced load did not repopulate the cache, so the next
    // non-blocking read has no retained board to serve and loads afresh.
    const nextLoader = vi.fn(async () => [bead("fresh")]);
    await expect(
      getIssueSnapshot("/repo", nextLoader, 1, { blockOnPendingWrite: false }),
    ).resolves.toEqual([bead("fresh")]);
    expect(nextLoader).toHaveBeenCalledTimes(1);
  });

  it("keeps a pre-write loader from repopulating post-write data", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("initial")], 0);

    // A loader that started BEFORE the write is still in flight when the write lands.
    let resolveOld!: (value: Bead[]) => void;
    const oldRefresh = refreshIssueSnapshot(
      "/repo",
      () => new Promise<Bead[]>((resolve) => (resolveOld = resolve)),
    );

    invalidateIssueSnapshot("/repo", true);

    // The read blocks on a fresh post-write loader that starts after the write.
    const postWriteRead = getIssueSnapshot(
      "/repo",
      async () => [bead("post-write")],
      ISSUE_SNAPSHOT_MAX_AGE_MS,
    );
    await expect(postWriteRead).resolves.toEqual([bead("post-write")]);

    // The pre-write loader now resolves — its result predates the write and must be discarded.
    resolveOld([bead("pre-write")]);
    await oldRefresh;

    await expect(
      getIssueSnapshot(
        "/repo",
        async () => [bead("post-write")],
        ISSUE_SNAPSHOT_MAX_AGE_MS,
      ),
    ).resolves.toEqual([bead("post-write")]);
  });
});

describe("bead description cache", () => {
  it("does not cache a failed description load", async () => {
    const loader = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error("bd show failed"))
      .mockResolvedValueOnce("retry succeeded");

    await expect(getBeadDescription("/repo", "one", loader)).rejects.toThrow(
      "bd show failed",
    );
    await expect(getBeadDescription("/repo", "one", loader)).resolves.toBe(
      "retry succeeded",
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight pre-invalidation load repopulate stale data", async () => {
    let resolveOld!: (value: string) => void;
    const oldLoad = getBeadDescription(
      "/repo",
      "one",
      () => new Promise<string>((resolve) => (resolveOld = resolve)),
    );

    invalidateIssueSnapshot("/repo", true);
    await expect(
      getBeadDescription("/repo", "one", async () => "post-write"),
    ).resolves.toBe("post-write");

    resolveOld("pre-write");
    await expect(oldLoad).resolves.toBe("pre-write");

    const loader = vi.fn(async () => "unexpected reload");
    await expect(getBeadDescription("/repo", "one", loader)).resolves.toBe(
      "post-write",
    );
    expect(loader).not.toHaveBeenCalled();
  });
});

/**
 * The board-change announcement (anton-h32k): what {@link onBoardChanged} promises a subscriber, and
 * the promise the picker's nudge is wired to. A subscriber acts on it — the nudge spends a `bd list`
 * under the repo's exclusive Dolt lock per announcement — so "the board moved" has to mean the
 * content moved, not that someone marked the cache stale.
 */
describe("board-change announcements", () => {
  const moves = (): { cwd: string[]; stop: () => void } => {
    const cwd: string[] = [];
    return { cwd, stop: onBoardChanged((repo) => cwd.push(repo)) };
  };

  it("announces a read whose board differs from the one it held", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const heard = moves();

    await refreshIssueSnapshot("/repo", async () => [bead("one"), bead("two")]);

    expect(heard.cwd).toEqual(["/repo"]);
    heard.stop();
  });

  // The invalidation the sync coalescer fires on EVERY pass that reaches `synced` — landed commits
  // or not. A subscriber woken by it would beat with the 30s sync heartbeat rather than the board.
  it("says nothing when an invalidated read comes back with the same board", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const heard = moves();

    invalidateIssueSnapshot("/repo");
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);

    expect(heard.cwd).toEqual([]);
    heard.stop();
  });

  it("says nothing for an invalidation on its own, before any read lands", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const heard = moves();

    invalidateIssueSnapshot("/repo", true);

    expect(heard.cwd).toEqual([]);
    heard.stop();
  });

  // A cold entry has no board to differ from: the read that fills it is a baseline, not a move.
  it("says nothing for the first read of a repository", async () => {
    const heard = moves();

    await refreshIssueSnapshot("/cold", async () => [bead("one")]);

    expect(heard.cwd).toEqual([]);
    heard.stop();
  });

  // A read that a write invalidated mid-flight is discarded rather than cached, so announcing it
  // would name a board the snapshot never took.
  it("says nothing for a read the generation guard threw away", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const heard = moves();

    const stale = refreshIssueSnapshot("/repo", async () => {
      invalidateIssueSnapshot("/repo", true);
      return [bead("two")];
    });
    await stale;

    expect(heard.cwd).toEqual([]);
    heard.stop();
  });

  it("keeps announcing after one subscriber throws", async () => {
    const console_ = vi.spyOn(console, "error").mockImplementation(() => {});
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const stopThrower = onBoardChanged(() => {
      throw new Error("boom");
    });
    const heard = moves();

    await expect(
      refreshIssueSnapshot("/repo", async () => [bead("two")]),
    ).resolves.toEqual([bead("two")]);

    expect(heard.cwd).toEqual(["/repo"]);
    stopThrower();
    heard.stop();
    console_.mockRestore();
  });

  it("drops every subscriber on reset, so a suite cannot leak one into the next", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    const heard = moves();

    resetIssueSnapshots();
    await refreshIssueSnapshot("/repo", async () => [bead("one")]);
    await refreshIssueSnapshot("/repo", async () => [bead("two")]);

    expect(heard.cwd).toEqual([]);
  });
});
