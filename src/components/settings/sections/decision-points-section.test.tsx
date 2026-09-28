// @vitest-environment jsdom
/**
 * The decision-points panel (anton-xky9e): a mode selector per registered point, its agreement
 * figure, and the one rule the acceptance criteria pin down — promoting to `auto` always goes
 * through a confirm dialog, and every other mode applies the moment it is chosen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  DecisionPointsSection,
  type DecisionPointRow,
} from "@/components/settings/sections/decision-points-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const POINT: DecisionPointRow = {
  id: "review-fix-nit",
  questionKind: "yes-no",
  consequence: "low",
  defaultMode: "shadow",
  mode: "shadow",
  settled: 47,
  agreed: 44,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

const radio = (id: string, level: string) =>
  screen.getByLabelText(`${id} · ${level}`) as HTMLInputElement;
const okFetch = () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("DecisionPointsSection", () => {
  it("says so when nothing is registered yet, rather than rendering an empty list", () => {
    render(<DecisionPointsSection slug="p1" points={[]} />);
    expect(screen.getByText(/No decision points are registered yet/)).toBeTruthy();
  });

  it("shows the point, its question shape and consequence, and the agreement figure", () => {
    render(<DecisionPointsSection slug="p1" points={[POINT]} />);
    expect(screen.getByText("review-fix-nit")).toBeTruthy();
    expect(screen.getByText(/yes-no · low consequence/)).toBeTruthy();
    expect(screen.getByText("agreed 44/47")).toBeTruthy();
    expect(radio("review-fix-nit", "shadow").checked).toBe(true);
  });

  it("reads 'no settled decisions yet' rather than a bare 0/0", () => {
    render(
      <DecisionPointsSection slug="p1" points={[{ ...POINT, settled: 0, agreed: 0 }]} />,
    );
    expect(screen.getByText("no settled decisions yet")).toBeTruthy();
  });

  it("applies a non-auto mode immediately, with no confirmation", async () => {
    const fetchMock = okFetch();
    render(<DecisionPointsSection slug="p1" points={[POINT]} />);

    fireEvent.click(radio("review-fix-nit", "assist"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/p1/settings");
    expect(JSON.parse(String(init.body))).toEqual({
      decisionModes: { "review-fix-nit": "assist" },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // anton-528bw review: reselecting the point's own default must delete the override, not persist
  // it as an explicit value equal to today's default — otherwise a later release changing the
  // point's shipped default would leave this project silently pinned to the old one.
  it("selecting the point's own default clears the override instead of pinning it", async () => {
    const fetchMock = okFetch();
    render(
      <DecisionPointsSection
        slug="p1"
        points={[{ ...POINT, defaultMode: "shadow", mode: "assist" }]}
      />,
    );

    fireEvent.click(radio("review-fix-nit", "shadow"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      decisionModes: { "review-fix-nit": null },
    });
  });

  it("promoting to auto opens a confirm dialog and saves nothing until confirmed", async () => {
    const fetchMock = okFetch();
    render(<DecisionPointsSection slug="p1" points={[POINT]} />);

    fireEvent.click(radio("review-fix-nit", "auto"));

    // The click alone never saves — decide()'s registry has to be asked before anton acts unattended.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/Promote review-fix-nit to auto/)).toBeTruthy();
    expect(dialog.getByText(/agreed 44\/47/)).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: /Promote to auto/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      decisionModes: { "review-fix-nit": "auto" },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("cancelling the confirm dialog leaves the mode untouched", () => {
    const fetchMock = okFetch();
    render(<DecisionPointsSection slug="p1" points={[POINT]} />);

    fireEvent.click(radio("review-fix-nit", "auto"));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: /Cancel/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(radio("review-fix-nit", "shadow").checked).toBe(true);
  });

  it("falls back to the stored mode when the save is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
    );

    render(<DecisionPointsSection slug="p1" points={[POINT]} />);
    fireEvent.click(radio("review-fix-nit", "assist"));

    await waitFor(() => expect(radio("review-fix-nit", "shadow").checked).toBe(true));
    expect(radio("review-fix-nit", "assist").checked).toBe(false);
  });

  it("drops the pending choice once the server's resolved mode moves under it", async () => {
    okFetch();
    const { rerender } = render(<DecisionPointsSection slug="p1" points={[POINT]} />);

    fireEvent.click(radio("review-fix-nit", "assist"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(radio("review-fix-nit", "assist").checked).toBe(true);

    rerender(
      <DecisionPointsSection slug="p1" points={[{ ...POINT, mode: "assist" }]} />,
    );
    expect(radio("review-fix-nit", "assist").checked).toBe(true);
  });
});
