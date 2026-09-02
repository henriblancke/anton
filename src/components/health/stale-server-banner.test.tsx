// @vitest-environment jsdom
/**
 * The banner is the half of build drift that needs no CLI (anton-pzfb): a nightly degraded by a
 * stale process has to be legible on the health page the morning after, naming both builds and the
 * one action that clears it. And it must be absent on the ordinary path — a server started from the
 * current checkout draws nothing at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { StaleServerBanner } from "@/components/health/stale-server-banner";
import type { BuildDrift } from "@/lib/build/drift";

afterEach(cleanup);

const drift = (over: Partial<BuildDrift> = {}): BuildDrift => ({
  state: "modified",
  running: { version: "0.4.0", revision: "a".repeat(40) },
  onDisk: { version: "0.4.0", revision: "b".repeat(40) },
  bootedAt: null,
  ...over,
});

describe("StaleServerBanner", () => {
  it("renders nothing when the running server is the build on disk", () => {
    const { container } = render(<StaleServerBanner drift={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("names both builds and the restart when the checkout moved under the process", () => {
    render(<StaleServerBanner drift={drift()} />);
    expect(screen.getByText("This anton server is older than the code on disk")).toBeTruthy();
    expect(screen.getByText(/booted from 0\.4\.0 \(aaaaaaa\)/)).toBeTruthy();
    expect(screen.getByText(/0\.4\.0 \(bbbbbbb\)/)).toBeTruthy();
    expect(screen.getByText(/Restart the server to adopt the build on disk/)).toBeTruthy();
  });

  it("calls a new release on disk what it is", () => {
    render(
      <StaleServerBanner
        drift={drift({
          state: "outdated",
          running: { version: "0.3.9", revision: null },
          onDisk: { version: "0.4.0", revision: null },
        })}
      />,
    );
    expect(screen.getByText(/booted from 0\.3\.9 and the runtime on disk is now 0\.4\.0/)).toBeTruthy();
  });

  it("admits when the running build cannot be identified at all", () => {
    render(<StaleServerBanner drift={drift({ state: "unstamped", running: null })} />);
    expect(screen.getByText("This anton server can't say what build it is running")).toBeTruthy();
    expect(screen.getByText(/Restart the server to adopt the build on disk/)).toBeTruthy();
  });

  // The verdict says "restart", so anton must not also be restarting itself: a live process may be
  // mid-run, and this page is read-only by construction.
  it("names no action but the operator's own restart", () => {
    render(<StaleServerBanner drift={drift()} />);
    expect(screen.getByText(/anton will not do it for you/)).toBeTruthy();
  });
});
