// @vitest-environment jsdom
/**
 * The Ledger link (anton-rpguq / PR #329 review): the one affordance this header gates on
 * `detail.runTarget` rather than on anything derivable from the epic alone — a container epic has no
 * ledger of its own (its features each own one), so an inverted condition here would either dead-end
 * on a container epic's 404 or silently hide the link from every run target.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { EpicDetail } from "@/lib/types";
import { makeEpic } from "@/components/board/epic.fixture";
import { EpicDetailHeader } from "@/components/epic/epic-detail-header";
import { summarizeEpicDetail } from "@/components/epic/epic-detail-summary";

afterEach(cleanup);

function renderHeader(runTarget: EpicDetail["runTarget"]) {
  const detail: EpicDetail = {
    epic: makeEpic(),
    tickets: [],
    edges: [],
    runTarget,
  };
  render(
    <EpicDetailHeader
      slug="anton"
      detail={detail}
      summary={summarizeEpicDetail(detail)}
      budgetAware={false}
      running={false}
      onRun={vi.fn()}
      onRework={vi.fn()}
      onDelete={vi.fn()}
      onCopyWorktree={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

describe("EpicDetailHeader Ledger link", () => {
  it("offers the Ledger link for a run target", () => {
    renderHeader(true);

    const link = screen.getByRole("link", { name: /Ledger/ });
    expect(link.getAttribute("href")).toBe("/projects/anton/epics/anton-1/ledger");
  });

  it("hides the Ledger link for a container epic (runTarget: false)", () => {
    renderHeader(false);

    expect(screen.queryByRole("link", { name: /Ledger/ })).toBeNull();
  });

  it("hides the Ledger link when runTarget is not carried at all", () => {
    renderHeader(undefined);

    expect(screen.queryByRole("link", { name: /Ledger/ })).toBeNull();
  });
});
