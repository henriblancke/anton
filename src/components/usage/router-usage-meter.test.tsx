// @vitest-environment jsdom
/**
 * The project view's routed meter (anton-ds7e): unrouted renders nothing (the nav pill already
 * covers the machine-wide meter), a routed project labels its meter with the endpoint host and the
 * collapse rule and links the router's dashboard, and an unreadable router states the unknown by
 * name rather than rendering an empty or zeroed meter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RouterUsageMeter } from "@/components/usage/router-usage-meter";

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const noContent = () => () => new Response(null, { status: 204 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RouterUsageMeter", () => {
  it("renders nothing for an unrouted project — the nav pill already covers the machine-wide meter", async () => {
    const fetchMock = stubFetch(noContent());
    const { container } = render(<RouterUsageMeter slug="tmp" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("labels a routed project's meter with the endpoint host and the collapse rule, and links the router's dashboard", async () => {
    stubFetch(
      json({
        state: "ok",
        usage: {
          sessionPct: 20,
          weeklyPct: 30,
          sessionResetAt: null,
          weeklyResetAt: null,
          plan: "Claude Code",
        },
        endpointHost: "localhost:20128",
        connectionId: "conn_ab12cd34",
        dashboardUrl: "http://localhost:20128",
      }),
    );

    render(<RouterUsageMeter slug="tmp" />);

    const trigger = await screen.findByRole("button", { name: /Routed quota via localhost:20128/ });
    expect(trigger).toBeTruthy();

    fireEvent.click(trigger);
    await screen.findByText(/via/);
    const popup = screen.getByText("Routed quota").closest("[role]")?.parentElement ?? document.body;
    expect(popup.textContent).toContain("localhost:20128");
    expect(popup.textContent).toContain("conn_ab12cd34");
    expect(popup.textContent).toContain("meters on");
    expect(popup.textContent).toContain("one");

    const link = screen.getByRole("link", { name: /Open router dashboard/ });
    expect(link.getAttribute("href")).toBe("http://localhost:20128");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("states an unreadable router as a named unknown, never an empty or zeroed meter", async () => {
    stubFetch(
      json({
        state: "unreadable",
        endpointHost: "localhost:20128",
        connectionId: "conn_ab12cd34",
        dashboardUrl: "http://localhost:20128",
      }),
    );

    render(<RouterUsageMeter slug="tmp" />);

    const trigger = await screen.findByRole("button", { name: /Router quota unknown/ });
    expect(trigger).toBeTruthy();
    // No percentage is ever rendered for this state — that would be the fabricated zero this
    // acceptance criterion forbids.
    expect(screen.queryByText(/%/)).toBeNull();

    fireEvent.click(trigger);
    await screen.findByText(/Couldn.t read usage from/);
    expect(screen.getByText(/localhost:20128/).textContent).toContain("localhost:20128");
    expect(document.body.textContent).toContain("conn_ab12cd34");

    const link = screen.getByRole("link", { name: /Open router dashboard/ });
    expect(link.getAttribute("href")).toBe("http://localhost:20128");
  });
});
