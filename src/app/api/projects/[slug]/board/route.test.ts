/**
 * GET /board polling contract (anton-qgt4): the poll path never blocks on a cold bd list.
 * A stale ?version serves the current snapshot immediately and kicks a background refresh
 * (never awaited), so a slow loader can't stall the response; an unchanged ?version still
 * short-circuits to 304 without building the board.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const getBoard = vi.fn(async () => ({ projectSlug: "tmp", version: "2:sync" }));
const getBoardVersion = vi.fn(() => "2:sync");
vi.mock("@/lib/board", () => ({ getBoard, getBoardVersion }));

const probeAllIssues = vi.fn();
const refreshAllIssues = vi.fn(async (): Promise<[]> => []);
vi.mock("@/lib/beads/issues", () => ({ probeAllIssues, refreshAllIssues }));

const { GET } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = (version?: string) =>
  new Request(`http://t/board${version === undefined ? "" : `?version=${version}`}`);

afterEach(() => vi.clearAllMocks());

describe("GET /board — non-blocking poll refresh (anton-qgt4)", () => {
  it("serves the current snapshot without awaiting the background refresh on a stale version", async () => {
    // A refresh that only settles when we release it: the route must respond before then,
    // proving the loader is kicked in the background and never awaited on the poll path.
    let release!: () => void;
    let settled = false;
    refreshAllIssues.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          release = () => {
            settled = true;
            resolve([]);
          };
        }),
    );

    const res = await GET(req("1:sync"), ctx("tmp"));

    expect(res.status).toBe(200);
    expect((await res.json()).board.version).toBe("2:sync");
    expect(refreshAllIssues).toHaveBeenCalledWith(project.repoPath);
    expect(getBoard).toHaveBeenCalledOnce();
    expect(settled).toBe(false); // the refresh is still in flight — the route did not wait for it

    release();
  });

  it("returns 304 without building the board when the version is unchanged", async () => {
    const res = await GET(req("2:sync"), ctx("tmp"));

    expect(res.status).toBe(304);
    expect(getBoard).not.toHaveBeenCalled();
    expect(refreshAllIssues).not.toHaveBeenCalled();
    // The lightweight freshness probe still runs on the 304 fast path.
    expect(probeAllIssues).toHaveBeenCalledWith(project.repoPath);
  });

  it("builds the board on a first load with no version token", async () => {
    const res = await GET(req(), ctx("tmp"));

    expect(res.status).toBe(200);
    expect(getBoard).toHaveBeenCalledOnce();
    expect(probeAllIssues).not.toHaveBeenCalled();
    expect(refreshAllIssues).not.toHaveBeenCalled();
  });
});
