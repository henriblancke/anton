/**
 * POST /cards/[cardId]/move contract (anton-4g35): a move must answer with the AUTHORITATIVE
 * post-move board, not a bare `{ ok: true }`. The write bumps the snapshot version and retains the
 * pre-move beads, so a client that can't advance its version token off this response would send the
 * stale version on its next poll, get the retained pre-move snapshot stamped with the new version
 * (the non-blocking poll path), and revert the just-moved card. The route therefore mirrors the GET
 * forced-reload path: it AWAITS a fresh read before building the board (so the board reflects the
 * move, never the retained pre-move snapshot) and returns it, falling back to last-good on a bd
 * failure rather than 500-ing the move.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../../../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const getBoard = vi.fn(async () => ({ projectSlug: "tmp", version: "3:sync" }));
vi.mock("@/lib/board", () => ({ getBoard }));

const moveCard = vi.fn(async () => {});
vi.mock("@/lib/board-move", () => ({ moveCard }));

const refreshAllIssues = vi.fn(async (): Promise<[]> => []);
vi.mock("@/lib/beads/issues", () => ({ refreshAllIssues }));

const { POST } = await import("./route");

const ctx = (slug: string, cardId: string) => ({
  params: Promise.resolve({ slug, cardId }),
});
const moveReq = (toStage: unknown) =>
  new Request("http://t/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage }),
  });

afterEach(() => vi.clearAllMocks());

describe("POST /cards/[cardId]/move — returns the post-move board (anton-4g35)", () => {
  it("answers with the freshly-built board so the client can advance its version token", async () => {
    const res = await POST(moveReq("in-review"), ctx("tmp", "anton-1"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; board: { version: string } };
    expect(body.ok).toBe(true);
    // The version token the client adopts to advance versionRef — proves it's the rebuilt board,
    // not a bare `{ ok: true }` that would leave the client's token stale and revert the card.
    expect(body.board.version).toBe("3:sync");
    expect(moveCard).toHaveBeenCalledWith(project, "anton-1", "in-review");
  });

  it("awaits a fresh read BEFORE building the board so the board reflects the move", async () => {
    // A move RETAINS the pre-move snapshot (invalidateIssueSnapshot only marks it stale). Building
    // the board before the fresh read resolves would hand back the pre-move card stamped with the
    // new version — the exact stale board a poll would then treat as current. Hold the refresh open:
    // getBoard must not run until it resolves.
    let release!: () => void;
    refreshAllIssues.mockImplementationOnce(
      () => new Promise<[]>((resolve) => (release = () => resolve([]))),
    );

    const pending = POST(moveReq("done"), ctx("tmp", "anton-2"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(moveCard).toHaveBeenCalledOnce();
    expect(refreshAllIssues).toHaveBeenCalledWith(project.repoPath);
    expect(getBoard).not.toHaveBeenCalled();

    release();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(getBoard).toHaveBeenCalledOnce();
  });

  it("still returns the board when the forced fresh read fails (no 500)", async () => {
    // A transient bd failure on the refresh must not 500 the move — fall back to the snapshot
    // getBoard already serves, matching the GET forced-reload path.
    refreshAllIssues.mockRejectedValueOnce(new Error("bd list failed"));

    const res = await POST(moveReq("backlog"), ctx("tmp", "anton-3"));

    expect(res.status).toBe(200);
    expect((await res.json()).board.version).toBe("3:sync");
    expect(getBoard).toHaveBeenCalledOnce();
  });

  it("rejects an invalid toStage without moving or reading the board", async () => {
    const res = await POST(moveReq("nowhere"), ctx("tmp", "anton-4"));

    expect(res.status).toBe(400);
    expect(moveCard).not.toHaveBeenCalled();
    expect(getBoard).not.toHaveBeenCalled();
  });

  it("404s when the card can't be moved, without building a board", async () => {
    moveCard.mockRejectedValueOnce(new Error("Card not found"));

    const res = await POST(moveReq("implementing"), ctx("tmp", "anton-5"));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Card not found");
    expect(getBoard).not.toHaveBeenCalled();
  });
});
