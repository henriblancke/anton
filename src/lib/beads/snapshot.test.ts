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

  it("drops local-write snapshots so the next read waits for fresh data", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("old")]);
    invalidateIssueSnapshot("/repo", true);
    await expect(getIssueSnapshot("/repo", async () => [bead("new")])).resolves.toEqual([
      bead("new"),
    ]);
  });

  it("discards a pre-write refresh that resolves after hard invalidation", async () => {
    await refreshIssueSnapshot("/repo", async () => [bead("initial")]);
    let resolveOld!: (value: Bead[]) => void;
    const oldRefresh = refreshIssueSnapshot(
      "/repo",
      () => new Promise<Bead[]>((resolve) => (resolveOld = resolve)),
    );

    invalidateIssueSnapshot("/repo", true);
    const freshRead = getIssueSnapshot("/repo", async () => [bead("post-write")]);
    resolveOld([bead("pre-write")]);

    await oldRefresh;
    await expect(freshRead).resolves.toEqual([bead("post-write")]);
    await expect(getIssueSnapshot("/repo", async () => [])).resolves.toEqual([
      bead("post-write"),
    ]);
  });
});
