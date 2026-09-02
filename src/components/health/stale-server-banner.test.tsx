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
import type { BuildDrift, ServerDrift } from "@/lib/build/drift";

afterEach(cleanup);

const drift = (over: Partial<BuildDrift> = {}): BuildDrift => ({
  state: "modified",
  running: { version: "0.4.0", revision: "a".repeat(40) },
  onDisk: { version: "0.4.0", revision: "b".repeat(40) },
  bootedAt: null,
  ...over,
});

const server = (over: Partial<ServerDrift> = {}): ServerDrift => ({
  pid: 4242,
  self: true,
  runner: true,
  drift: drift(),
  ...over,
});

describe("StaleServerBanner", () => {
  it("renders nothing when every running server is the build on disk", () => {
    const { container } = render(<StaleServerBanner servers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("names both builds and the restart when the checkout moved under the process", () => {
    render(<StaleServerBanner servers={[server()]} />);
    expect(screen.getByText("This anton server is older than the code on disk")).toBeTruthy();
    expect(screen.getByText(/booted from 0\.4\.0 \(aaaaaaa\)/)).toBeTruthy();
    expect(screen.getByText(/0\.4\.0 \(bbbbbbb\)/)).toBeTruthy();
    expect(screen.getByText(/Restart the server to adopt the build on disk/)).toBeTruthy();
  });

  it("calls a new release on disk what it is", () => {
    render(
      <StaleServerBanner
        servers={[
          server({
            drift: drift({
              state: "outdated",
              running: { version: "0.3.9", revision: null },
              onDisk: { version: "0.4.0", revision: null },
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/booted from 0\.3\.9 and the runtime on disk is now 0\.4\.0/)).toBeTruthy();
  });

  it("admits when the running build cannot be identified at all", () => {
    render(<StaleServerBanner servers={[server({ drift: drift({ state: "unstamped", running: null }) })]} />);
    expect(screen.getByText("This anton server can't say what build it is running")).toBeTruthy();
    expect(screen.getByText(/Restart the server to adopt the build on disk/)).toBeTruthy();
  });

  // The consequence, and the reason the flag is recorded at all (PR #217 review): the jobs run under
  // one specific process, and attributing them to any other is a false alarm.
  it("blames the nightlies on the process that actually runs them", () => {
    render(<StaleServerBanner servers={[server({ runner: true })]} />);
    expect(screen.getByText(/Scheduled jobs .* execute the build this process holds/)).toBeTruthy();
    expect(screen.getByText("runs scheduled jobs")).toBeTruthy();
  });

  it("says a stale UI-only server leaves the scheduled jobs alone", () => {
    render(<StaleServerBanner servers={[server({ runner: false })]} />);
    expect(screen.getByText(/serves the UI only .* scheduled jobs are unaffected by it/)).toBeTruthy();
    expect(screen.queryByText("runs scheduled jobs")).toBeNull();
  });

  it("claims neither for a server whose record predates the flag", () => {
    render(<StaleServerBanner servers={[server({ runner: undefined })]} />);
    expect(screen.queryByText(/Scheduled jobs/)).toBeNull();
    expect(screen.queryByText(/serves the UI only/)).toBeNull();
  });

  // The shape the reviewer found: the page renders in a current UI-only process while the runner
  // beside it is stale. One warning per process, each naming the pid it is about.
  it("warns about each drifting process by pid when an install runs more than one", () => {
    render(
      <StaleServerBanner
        servers={[
          server({ pid: 4242, self: true, runner: false }),
          server({ pid: 4243, self: false, runner: true }),
        ]}
      />,
    );
    expect(screen.getByText("The anton server on pid 4242 is older than the code on disk")).toBeTruthy();
    expect(screen.getByText("The anton server on pid 4243 is older than the code on disk")).toBeTruthy();
    expect(screen.getByText("runs scheduled jobs")).toBeTruthy();
  });

  // The verdict says "restart", so anton must not also be restarting itself: a live process may be
  // mid-run, and this page is read-only by construction.
  it("names no action but the operator's own restart", () => {
    render(<StaleServerBanner servers={[server()]} />);
    expect(screen.getByText(/anton will not do it for you/)).toBeTruthy();
  });
});
