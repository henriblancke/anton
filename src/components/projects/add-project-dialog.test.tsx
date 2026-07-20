// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AddProjectDialog } from "@/components/projects/add-project-dialog";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface BrowseOverrides {
  path?: string;
  hasBeads?: boolean;
}

function browseResult(overrides: BrowseOverrides = {}) {
  const path = overrides.path ?? "/home/user/fresh-repo";
  return {
    path,
    parent: "/home/user",
    home: "/home/user",
    hasBeads: overrides.hasBeads ?? false,
    entries: [],
  };
}

/** Stub fetch: browse returns `folder`, POST /api/projects echoes a created project. */
function stubFetch(folder = browseResult()) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
    const url = String(input);
    if (url.startsWith("/api/fs/browse")) {
      return Promise.resolve(new Response(JSON.stringify(folder), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ project: { name: "fresh-repo" } }), { status: 201 }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openDialog(fetchMock: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: /add project/i }));
  // Wait for the initial browse to resolve so the folder + inputs render.
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText("/home/user/fresh-repo")).toBeDefined());
}

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.restoreAllMocks();
});

describe("AddProjectDialog (anton-ivtj)", () => {
  it("lets a folder without .beads/ be added and threads the chosen prefix to the API", async () => {
    const fetchMock = stubFetch(browseResult({ hasBeads: false }));
    render(<AddProjectDialog />);
    await openDialog(fetchMock);

    // Name + prefix inputs exist; the prefix is seeded from the folder name.
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("fresh-repo");
    expect((screen.getByLabelText(/board prefix/i) as HTMLInputElement).value).toBe("fresh-repo");

    // The add button is not hard-gated on a pre-existing .beads/.
    const addBtn = screen.getByRole("button", { name: /initialize & add/i });
    expect((addBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/board prefix/i), { target: { value: "myproj" } });
    fireEvent.click(addBtn);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u]) => u === "/api/projects");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toMatchObject({ repoPath: "/home/user/fresh-repo", prefix: "myproj" });
    });
  });

  it("blocks the add when a fresh repo has no prefix", async () => {
    const fetchMock = stubFetch(browseResult({ hasBeads: false }));
    render(<AddProjectDialog />);
    await openDialog(fetchMock);

    fireEvent.change(screen.getByLabelText(/board prefix/i), { target: { value: "" } });
    expect(
      (screen.getByRole("button", { name: /initialize & add/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("adds an existing board as-is, with no prefix input and no prefix in the request", async () => {
    const fetchMock = stubFetch(browseResult({ hasBeads: true }));
    render(<AddProjectDialog />);
    await openDialog(fetchMock);

    expect(screen.queryByLabelText(/board prefix/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /add this project/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u]) => u === "/api/projects");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.prefix).toBeUndefined();
    });
  });
});
