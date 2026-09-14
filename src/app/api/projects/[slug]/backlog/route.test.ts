/**
 * POST /backlog contract (anton-8mnr, anton-h1ds). This is the one write behind "Send to backlog",
 * and what it lands is a `feature` under an epic — the tier anton runs — rendered from the project's
 * bead formula. So the route REFUSES a draft that would land unshaped, and refuses one that names no
 * epic: a parentless feature runs fine and appears on no roadmap, which is exactly the shape this
 * path used to produce (an epic per PR).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const createDraftFeature = vi.fn(async () => ({
  id: "tmp-2",
  epicId: "tmp-1",
  epicCreated: false,
}));
// Keep the real error classes: the route tells a contract refusal (422) and an unusable epic (400)
// apart from a bd failure (500) by instanceof, so the mock must not shadow them with undefined.
vi.mock("@/lib/backlog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backlog")>()),
  createDraftFeature,
}));
const { DraftContractError, DraftEpicError } = await import("@/lib/backlog");

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

const FEATURE = {
  title: "Export a report view to CSV",
  goal: "A customer can take a report out of the app as CSV.",
  acceptance: "- [ ] every report view has a working CSV export button",
  context: "touches: src/app/reports; follow the pattern in src/lib/export.ts",
  outOfScope: "- PDF export, which is its own feature",
  verify: "unit test on the serializer, route test on the download",
};

const NEW_EPIC = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports",
  area: "reports",
};

const DRAFT = { feature: FEATURE, epic: { kind: "existing", id: "tmp-1" } };

afterEach(() => vi.clearAllMocks());

describe("POST /backlog", () => {
  it("creates the feature under the chosen epic and returns both ids", async () => {
    const res = await post(DRAFT);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tmp-2", epicId: "tmp-1", epicCreated: false });
    expect(createDraftFeature).toHaveBeenCalledWith(project, DRAFT);
  });

  it("accepts a draft that shapes its own epic alongside the feature", async () => {
    const draft = { feature: FEATURE, epic: { kind: "new", epic: NEW_EPIC } };
    expect((await post(draft)).status).toBe(201);
    expect(createDraftFeature).toHaveBeenCalledWith(project, draft);
  });

  it.each(["title", "goal", "acceptance", "context", "outOfScope", "verify"] as const)(
    "rejects a draft missing the feature's %s — the contract is not optional here",
    async (field) => {
      const res = await post({ ...DRAFT, feature: { ...FEATURE, [field]: "" } });
      expect(res.status).toBe(400);
      expect(createDraftFeature).not.toHaveBeenCalled();
    },
  );

  // The whole point of anton-h1ds: the UI producer must not be able to file a run target that
  // hangs off nothing.
  it.each([
    ["no epic key at all", { feature: FEATURE }],
    ["an empty epic id", { feature: FEATURE, epic: { kind: "existing", id: "" } }],
    ["an unknown epic kind", { feature: FEATURE, epic: { kind: "none" } }],
  ])("rejects a draft with %s rather than committing a parentless feature", async (_why, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(createDraftFeature).not.toHaveBeenCalled();
  });

  it.each(["title", "goal", "successCriteria"] as const)(
    "rejects a NEW epic missing its %s",
    async (field) => {
      const res = await post({
        feature: FEATURE,
        epic: { kind: "new", epic: { ...NEW_EPIC, [field]: "" } },
      });
      expect(res.status).toBe(400);
      expect(createDraftFeature).not.toHaveBeenCalled();
    },
  );

  it("rejects an area bd could not round-trip as a label", async () => {
    const res = await post({
      feature: FEATURE,
      epic: { kind: "new", epic: { ...NEW_EPIC, area: "two words" } },
    });
    expect(res.status).toBe(400);
    expect(createDraftFeature).not.toHaveBeenCalled();
  });

  it("answers 400 when the chosen epic is gone — a question for the founder, not a bd failure", async () => {
    createDraftFeature.mockRejectedValueOnce(new DraftEpicError("epic tmp-9 is not on the board"));
    const res = await post({ ...DRAFT, epic: { kind: "existing", id: "tmp-9" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("tmp-9");
  });

  it("refuses (422) a draft whose rendered bead the contract validator faults", async () => {
    // Non-empty is not conformant: prompt-only criteria pass the schema but would land a bead the
    // board immediately flags as unapprovable — createDraftFeature throws before any bead exists.
    createDraftFeature.mockRejectedValueOnce(
      new DraftContractError([
        { section: "Acceptance", severity: "blocking", message: "no Acceptance criteria — …" },
      ]),
    );
    const res = await post({
      ...DRAFT,
      feature: { ...FEATURE, acceptance: "- [ ] TODO — decide later" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("Acceptance");
  });

  it("surfaces a bd failure as a 500 rather than a silent success", async () => {
    createDraftFeature.mockRejectedValueOnce(new Error("bd exploded"));
    const res = await post(DRAFT);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("bd exploded");
  });
});
