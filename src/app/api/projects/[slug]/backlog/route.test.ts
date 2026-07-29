/**
 * POST /backlog contract (anton-8mnr). This is the one write behind "Send to backlog", and the
 * epic it creates is rendered from the project's bead formula — so the route REFUSES a draft that
 * would land unshaped. Before this ticket a title alone was accepted, which produced an epic with
 * no Success Criteria and no `area:` — a blocking contract violation anton itself authored.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const createDraftEpic = vi.fn(async () => "tmp-1");
// Keep the real DraftContractError: the route tells a contract refusal (422) apart from a bd
// failure (500) by instanceof, so the mock must not shadow the class with undefined.
vi.mock("@/lib/backlog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backlog")>()),
  createDraftEpic,
}));
const { DraftContractError } = await import("@/lib/backlog");

const { POST } = await import("./route");

const ctx = { params: Promise.resolve({ slug: "tmp" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://t/backlog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );

const DRAFT = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports",
  area: "reports",
};

afterEach(() => vi.clearAllMocks());

describe("POST /backlog", () => {
  it("creates the epic from a complete draft and returns its id", async () => {
    const res = await post(DRAFT);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tmp-1" });
    expect(createDraftEpic).toHaveBeenCalledWith(project, DRAFT);
  });

  it.each(["goal", "successCriteria", "area"] as const)(
    "rejects a draft missing %s — the epic contract is not optional here",
    async (field) => {
      const res = await post({ ...DRAFT, [field]: "" });
      expect(res.status).toBe(400);
      expect(createDraftEpic).not.toHaveBeenCalled();
    },
  );

  it("rejects an area bd could not round-trip as a label", async () => {
    expect((await post({ ...DRAFT, area: "two words" })).status).toBe(400);
    expect(createDraftEpic).not.toHaveBeenCalled();
  });

  it("refuses (422) a draft whose rendered bead the contract validator faults", async () => {
    // Non-empty is not conformant: prompt-only criteria pass the schema but would land a bead the
    // board immediately flags as unapprovable — createDraftEpic throws before any bead exists.
    createDraftEpic.mockRejectedValueOnce(
      new DraftContractError([
        { section: "Success Criteria", severity: "blocking", message: "no Success Criteria — …" },
      ]),
    );
    const res = await post({ ...DRAFT, successCriteria: "- [ ] TODO — decide later" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("Success Criteria");
  });

  it("surfaces a bd failure as a 500 rather than a silent success", async () => {
    createDraftEpic.mockRejectedValueOnce(new Error("bd exploded"));
    const res = await post(DRAFT);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("bd exploded");
  });
});
