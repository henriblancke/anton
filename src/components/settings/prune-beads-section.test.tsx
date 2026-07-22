// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PruneBeadsSection } from "@/components/settings/prune-beads-section";
import type { Project } from "@/lib/types";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project = { slug: "anton", name: "anton", hasBeads: true } as Project;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refresh.mockClear();
});

describe("PruneBeadsSection", () => {
  it("Preview posts a dry-run for the selected age, then confirm-delete posts the force path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ count: 4, pruned: false }))
      .mockResolvedValueOnce(jsonResponse({ count: 4, pruned: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PruneBeadsSection project={project} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Prune age" }), {
      target: { value: "90d" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    // The preview shows the count and only then exposes the delete affordance.
    const armButton = await screen.findByRole("button", { name: /Prune 4 beads/ });
    const [previewUrl, previewInit] = fetchMock.mock.calls[0]!;
    expect(previewUrl).toBe("/api/projects/anton/prune");
    expect(JSON.parse(previewInit.body)).toEqual({ age: "90d" });

    // ConfirmDeleteButton is two-step: arm, then confirm — only the confirm fires the force POST.
    fireEvent.click(armButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Confirm — delete 4/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ age: "90d", force: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // A completed prune invalidates its preview — no lingering delete affordance.
    expect(screen.queryByRole("button", { name: /Prune 4 beads/ })).toBeNull();
  });

  it("a 0-count preview shows the nothing-to-prune state and no delete affordance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ count: 0, pruned: false })));

    render(<PruneBeadsSection project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText(/Nothing to prune/);
    expect(screen.queryByRole("button", { name: /Prune / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
  });

  it("changing the age invalidates a pending preview (a stale count can't gate a wider delete)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ count: 2, pruned: false })));

    render(<PruneBeadsSection project={project} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: /Prune 2 beads/ });

    fireEvent.change(screen.getByRole("combobox", { name: "Prune age" }), {
      target: { value: "all" },
    });
    expect(screen.queryByRole("button", { name: /Prune 2 beads/ })).toBeNull();
  });

  it("renders a not-connected notice instead of controls when beads is missing", () => {
    render(<PruneBeadsSection project={{ ...project, hasBeads: false } as Project} />);
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.getByText(/beads is not connected/i)).toBeDefined();
  });
});
