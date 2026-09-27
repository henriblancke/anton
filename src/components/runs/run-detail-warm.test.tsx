// @vitest-environment jsdom
/**
 * anton-rqwy8: a failed warm is legible on the run detail view, not only in a log nobody opens.
 *
 * The three cases are the ticket's own: a failure names its command and what it said; an `ok`
 * outcome and a row from before the column existed add nothing to the view. The last matters most
 * — the notice sits above the meta grid on every run, so anything that renders it unconditionally
 * puts a warning on runs that were fine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { RunDetailView } from "@/components/runs/run-detail-view";
import type { RunDetail } from "@/components/runs/run-view-utils";

// xterm constructs against `window` APIs jsdom lacks; the terminal is not what these assert.
vi.mock("@/components/runs/run-terminal", () => ({
  RunTerminal: () => <div data-testid="run-terminal" />,
}));

const BASE: RunDetail = {
  id: "run-1",
  epicBeadId: "anton-qgpm6",
  status: "done",
  attempts: 1,
  updatedAt: 1_700_000_000,
};

function mountRun(run: Partial<RunDetail>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ run: { ...BASE, ...run }, sessions: [] }),
    }),
  );
  render(<RunDetailView slug="anton" runId="run-1" />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the run detail view's warm notice", () => {
  it("names the command that failed and the tail of what it said", async () => {
    mountRun({
      warmOutcome: "failed",
      warmCommand: "bun install",
      warmError: "error: no matching version found for @acme/private@^2.0.0",
    });

    expect(await screen.findByText(/Dependency warming failed/i)).toBeDefined();
    expect(screen.getByText("bun install")).toBeDefined();
    expect(screen.getByText(/no matching version found/)).toBeDefined();
  });

  it("says so rather than showing a blank when warming broke before resolving a command", async () => {
    // warmWorktreeBestEffort's own catch reports `failed` with no command; an empty slot there
    // reads as a missing value rather than the thing that actually happened.
    mountRun({ warmOutcome: "failed", warmError: "spawn ENOENT" });

    expect(await screen.findByText(/Dependency warming failed/i)).toBeDefined();
    expect(screen.getByText("no command resolved")).toBeDefined();
  });

  it("adds nothing for a warm that succeeded", async () => {
    mountRun({ warmOutcome: "ok", warmCommand: "bun install" });

    await screen.findByText("anton-qgpm6");
    expect(screen.queryByText(/Dependency warming failed/i)).toBeNull();
    expect(screen.queryByText("bun install")).toBeNull();
  });

  it.each(["skipped", "disabled"] as const)("adds nothing for a %s warm", async (outcome) => {
    mountRun({ warmOutcome: outcome });

    await screen.findByText("anton-qgpm6");
    expect(screen.queryByText(/Dependency warming/i)).toBeNull();
  });

  it("renders a row predating the column unchanged", async () => {
    mountRun({});

    await screen.findByText("anton-qgpm6");
    expect(screen.queryByText(/Dependency warming/i)).toBeNull();
  });
});

describe("warmFailure", () => {
  it("speaks only for a failure", async () => {
    const { warmFailure } = await import("@/components/runs/run-view-utils");
    expect(warmFailure({ warmOutcome: "failed", warmCommand: "pnpm i" })).toEqual({
      command: "pnpm i",
      detail: undefined,
    });
    expect(warmFailure({ warmOutcome: "ok", warmCommand: "pnpm i" })).toBeNull();
    expect(warmFailure({ warmOutcome: "skipped" })).toBeNull();
    expect(warmFailure({ warmOutcome: "disabled" })).toBeNull();
    expect(warmFailure({})).toBeNull();
  });
});
