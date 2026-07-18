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

  it("serves prior beads immediately after a local write, then refreshes in the background", async () => {
    const loader = vi
      .fn<() => Promise<Bead[]>>()
      .mockResolvedValueOnce([bead("old")])
      .mockResolvedValueOnce([bead("new")]);
    await getIssueSnapshot("/repo", loader, 0);
    invalidateIssueSnapshot("/repo", true);

    // A local write marks the snapshot stale but keeps last-good data: the read returns the prior
    // beads at once (no await on the loader) and kicks a background refresh, never a cold load.
    await expect(
      getIssueSnapshot("/repo", loader, ISSUE_SNAPSHOT_MAX_AGE_MS),
    ).resolves.toEqual([bead("old")]);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await expect(
      getIssueSnapshot("/repo", loader, ISSUE_SNAPSHOT_MAX_AGE_MS),
    ).resolves.toEqual([bead("new")]);
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

    // The read serves the prior beads at once (stale-not-drop) and kicks a fresh post-write loader.
    const postWriteRead = getIssueSnapshot(
      "/repo",
      async () => [bead("post-write")],
      ISSUE_SNAPSHOT_MAX_AGE_MS,
    );
    await expect(postWriteRead).resolves.toEqual([bead("initial")]);

    // The pre-write loader now resolves — its result predates the write and must be discarded.
    resolveOld([bead("pre-write")]);
    await oldRefresh;

    await vi.waitFor(() =>
      expect(
        getIssueSnapshot("/repo", async () => [bead("post-write")], ISSUE_SNAPSHOT_MAX_AGE_MS),
      ).resolves.toEqual([bead("post-write")]),
    );
  });
});
