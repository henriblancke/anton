import { describe, expect, it } from "vitest";

import { deriveSyncBadge } from "./sync-status";
import type { SyncStatusView } from "./types";

function status(over: Partial<SyncStatusView> = {}): SyncStatusView {
  return {
    state: "synced",
    lastSyncedAt: 1000,
    lastPushedAt: 1000,
    unpushedCount: 0,
    lastError: null,
    ...over,
  };
}

describe("deriveSyncBadge", () => {
  it("maps each lifecycle state to its badge kind", () => {
    expect(deriveSyncBadge(status({ state: "unknown" }))).toBe("unknown");
    expect(deriveSyncBadge(status({ state: "not-wired" }))).toBe("not-wired");
    expect(deriveSyncBadge(status({ state: "syncing" }))).toBe("syncing");
    expect(deriveSyncBadge(status({ state: "synced" }))).toBe("synced");
    expect(deriveSyncBadge(status({ state: "failing", lastError: "boom" }))).toBe("failing");
  });

  it("surfaces a synced-but-behind repo as unpushed-retrying", () => {
    expect(deriveSyncBadge(status({ state: "synced", unpushedCount: 3 }))).toBe("unpushed-retrying");
  });

  it("keeps a failing pass loud even when work is queued (the count rides in the badge)", () => {
    expect(deriveSyncBadge(status({ state: "failing", unpushedCount: 2, lastError: "boom" }))).toBe(
      "failing",
    );
  });
});
