// @vitest-environment jsdom
/**
 * The digest page (anton-rokar): route + layout over `projectDigest`'s result. `projectDigest`
 * itself is covered by digest-read.test.ts; this file proves the page's own job — 404 on an unknown
 * project, the empty-window state, rendering the needs-you/feature sections when there's something
 * to show, and that simply loading the page never calls the mark-seen API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ProjectDigest } from "@/lib/digest/digest-read";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

let project: { id: string; slug: string; name: string } | null = {
  id: "p1",
  slug: "anton",
  name: "anton",
};
vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async () => project,
}));

let digest: ProjectDigest;
vi.mock("@/lib/digest/digest-read", () => ({
  projectDigest: async () => digest,
}));

const EMPTY_SUMMARY = {
  items: [],
  counts: { breaker: 0, "parked-ask": 0, "merge-ready-pr": 0, proposal: 0, "human-ticket": 0 },
  total: 0,
};

function emptyDigest(overrides: Partial<ProjectDigest> = {}): ProjectDigest {
  return {
    since: null,
    until: 1_700_000_000,
    headline: "No new activity",
    needsYou: EMPTY_SUMMARY,
    // Streamed, not resolved on the real page (PR #350 review) — resolved here since this suite
    // renders the page's output synchronously and has nothing to prove about the streaming itself;
    // that's covered by needs-you-section.test.tsx and digest-read.test.ts.
    breaker: Promise.resolve(undefined),
    activityCount: 0,
    groups: [],
    isEmpty: true,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  project = { id: "p1", slug: "anton", name: "anton" };
  digest = emptyDigest();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function renderPage() {
  const { default: ProjectDigestPage } = await import("./page");
  return render(await ProjectDigestPage({ params: Promise.resolve({ slug: "anton" }) }));
}

describe("ProjectDigestPage", () => {
  it("404s an unknown project", async () => {
    project = null;
    await expect(renderPage()).rejects.toThrow("notFound");
  });

  it("shows the empty-window state when nothing happened and nothing needs the operator", async () => {
    await renderPage();
    expect(screen.getByText("Nothing new since you looked")).toBeTruthy();
    expect(screen.getByText("Nothing has happened on this project yet.")).toBeTruthy();
  });

  it("shows the window's headline in the page header", async () => {
    digest = emptyDigest({ headline: "3 events: 2 runs finished, 1 PR opened" });
    await renderPage();
    expect(screen.getByText("3 events: 2 runs finished, 1 PR opened")).toBeTruthy();
  });

  it("renders the needs-you summary and feature groups instead of the empty state once there's something", async () => {
    digest = emptyDigest({
      isEmpty: false,
      needsYou: { ...EMPTY_SUMMARY, total: 1, counts: { ...EMPTY_SUMMARY.counts, proposal: 1 } },
      groups: [
        {
          key: "unlinked",
          kind: "unlinked",
          label: "No outcome linked",
          cards: [
            {
              id: "feat-1",
              title: "Feature one",
              headline: "1 event: run finished",
              why: undefined,
              outcomeId: undefined,
              stage: "implementing",
              prRef: undefined,
              prUrl: undefined,
              reviewScore: undefined,
              costUsd: undefined,
              nextStep: "Running",
              events: [],
            },
          ],
        },
      ],
    });

    await renderPage();

    expect(screen.queryByText("Nothing new since you looked")).toBeNull();
    expect(screen.getByText("Feature one")).toBeTruthy();
  });

  it("never calls mark-seen just from being rendered", async () => {
    digest = emptyDigest({ until: 42 });
    await renderPage();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("always renders the mark-seen footer, even on an empty window", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: "Mark all as seen" })).toBeTruthy();
  });
});
