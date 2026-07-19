import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./bd";
import {
  ISSUE_SNAPSHOT_MAX_AGE_MS,
  getIssueSnapshot,
  invalidateIssueSnapshot,
  issueSnapshotVersion,
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
    await expect(getIssueSnapshot("/repo", loader, 101)).resolves.toEqual([bead("one")]);
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
    await expect(getIssueSnapshot("/repo", loader, 200)).resolves.toEqual([bead("new")]);
  });

  it("preserves the last valid data when a background refresh fails", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("safe")], 100);
    await expect(refreshIssueSnapshot("/repo", async () => Promise.reject(new Error("boom"))))
      .rejects.toThrow("boom");
    await expect(getIssueSnapshot("/repo", async () => [])).resolves.toEqual([bead("safe")]);
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
    await expect(getIssueSnapshot("/repo", loader, 1)).resolves.toEqual([bead("new")]);
    expect(loader).toHaveBeenCalledTimes(2);

    // Once a post-write read has landed, reads serve warm again — no further load.
    await expect(getIssueSnapshot("/repo", loader, 2)).resolves.toEqual([bead("new")]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("serves the retained board without blocking on a pending write when blockOnPendingWrite is false", async () => {
    let resolvePostWrite!: (value: Bead[]) => void;
    const loader = vi
      .fn<() => Promise<Bead[]>>()
      .mockResolvedValueOnce([bead("old")])
      .mockImplementationOnce(() => new Promise<Bead[]>((done) => (resolvePostWrite = done)));
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
      getIssueSnapshot("/repo", async () => Promise.reject(new Error("boom")), 1),
    ).resolves.toEqual([bead("old")]);
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
      getIssueSnapshot("/repo", async () => [bead("post-write")], ISSUE_SNAPSHOT_MAX_AGE_MS),
    ).resolves.toEqual([bead("post-write")]);
  });
});
