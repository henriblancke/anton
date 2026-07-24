import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { STAGES } from "@/lib/types";
import { STAGE_LABELS } from "@/components/board/board-utils";
import { BoardSkeleton } from "@/components/board/board-skeleton";

describe("BoardSkeleton", () => {
  it("renders one labeled column per stage so the real board swaps in without layout shift", () => {
    const html = renderToStaticMarkup(<BoardSkeleton />);
    for (const stage of STAGES) {
      expect(html).toContain(STAGE_LABELS[stage]);
    }
  });

  it("announces itself as a loading region with the board's grid frame", () => {
    const html = renderToStaticMarkup(<BoardSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading board");
    // Same responsive column classes as the live board grid (epic-board.tsx) — the
    // no-layout-shift guarantee.
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("xl:grid-cols-4");
  });
});
