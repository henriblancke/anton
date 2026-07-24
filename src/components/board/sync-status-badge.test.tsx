import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SyncStatusView } from "@/lib/types";
import { SyncStatusBadge } from "@/components/board/sync-status-badge";

function makeSync(over: Partial<SyncStatusView> = {}): SyncStatusView {
  return {
    state: "synced",
    lastSyncedAt: Date.now(),
    lastPushedAt: Date.now(),
    unpushedCount: 0,
    lastError: null,
    ...over,
  };
}

describe("SyncStatusBadge", () => {
  it("shows a live 'synced' chip when caught up", () => {
    const html = renderToStaticMarkup(<SyncStatusBadge sync={makeSync()} />);
    expect(html).toContain("Live");
    // The relative "· synced Xs ago" suffix is client-only (it depends on the current time, so
    // rendering it during SSR caused a hydration mismatch) — it is intentionally absent here.
    expect(html).not.toContain("ago");
  });

  it("shows a syncing spinner while a pass is in flight", () => {
    const html = renderToStaticMarkup(<SyncStatusBadge sync={makeSync({ state: "syncing" })} />);
    expect(html).toContain("Syncing");
    expect(html).toContain("animate-spin");
  });

  it("surfaces the unpushed count with a retrying label when synced-but-behind", () => {
    const html = renderToStaticMarkup(
      <SyncStatusBadge sync={makeSync({ state: "synced", unpushedCount: 3 })} />,
    );
    expect(html).toContain("3 unpushed");
    expect(html).toContain("retrying");
    // Amber warning, not the loud destructive treatment.
    expect(html).toContain("amber");
    expect(html).not.toContain("Sync failing");
  });

  it("renders a prominent failing state (not a subtle chip) and carries the count", () => {
    const html = renderToStaticMarkup(
      <SyncStatusBadge
        sync={makeSync({ state: "failing", unpushedCount: 2, lastError: "push rejected" })}
      />,
    );
    expect(html).toContain("Sync failing");
    expect(html).toContain("2 unpushed");
    // Prominent: destructive border + fill + bold weight, and the error surfaced via title.
    expect(html).toContain("border-destructive");
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain("font-semibold");
    expect(html).toContain("push rejected");
  });

  it("shows a not-wired chip when no shared remote is configured", () => {
    const html = renderToStaticMarkup(<SyncStatusBadge sync={makeSync({ state: "not-wired" })} />);
    expect(html).toContain("Not wired");
  });

  it("renders nothing before the engine has reported", () => {
    expect(renderToStaticMarkup(<SyncStatusBadge sync={makeSync({ state: "unknown" })} />)).toBe("");
  });
});
