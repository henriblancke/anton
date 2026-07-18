/**
 * Settings route PATCH validation for the active-agents allowlist + autonomy flag (anton-46w),
 * against a real in-memory anton.db: a valid subset of known agents and a boolean autonomy
 * persist to projects.settings_json; an unknown agent id / non-array / non-boolean 400s;
 * "" / null clears each key back to the default; GET after PATCH restores what was saved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

let tdb: TestDb;

// Point the shared getDb() (used by projects.ts under the route) at the test db.
vi.mock("@/lib/db", () => ({
  getDb: () => tdb.db,
  schema,
}));

const { GET, PATCH } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

function patchReq(body: unknown): Request {
  return new Request("http://t/", { method: "PATCH", body: JSON.stringify(body) });
}

/** The raw persisted settings_json for the single test project. */
function persisted(): Record<string, unknown> {
  const row = tdb.db.select().from(schema.projects).all()[0];
  return JSON.parse(row.settingsJson);
}

describe("settings route — agents allowlist + autonomy (anton-46w)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("PATCH persists a valid agents subset + autonomy, and GET restores both after reload", async () => {
    const res = await PATCH(
      patchReq({ agents: ["fastapi", "nextjs"], autonomy: false }),
      ctx("tmp"),
    );
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.agents).toEqual(["fastapi", "nextjs"]);
    expect(settings.autonomy).toBe(false);
    expect(persisted()).toMatchObject({ agents: ["fastapi", "nextjs"], autonomy: false });

    // "Reload": a fresh GET reads back what was saved.
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect(get.status).toBe(200);
    const back = await get.json();
    expect(back.settings.agents).toEqual(["fastapi", "nextjs"]);
    expect(back.settings.autonomy).toBe(false);
  });

  it("PATCH rejects an unknown agent id and leaves settings untouched", async () => {
    await PATCH(patchReq({ agents: ["fastapi"] }), ctx("tmp"));
    const res = await PATCH(patchReq({ agents: ["fastapi", "cobol"] }), ctx("tmp"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cobol/);
    expect(persisted().agents).toEqual(["fastapi"]);
  });

  it("PATCH rejects a non-array agents value", async () => {
    const res = await PATCH(patchReq({ agents: "fastapi" }), ctx("tmp"));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects an agents array with a non-string element", async () => {
    const res = await PATCH(patchReq({ agents: ["fastapi", 42] }), ctx("tmp"));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects a non-boolean autonomy", async () => {
    for (const bad of ["yes", 1, {}]) {
      const res = await PATCH(patchReq({ autonomy: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
  });

  it('PATCH "" / null clears agents and autonomy back to the default (keys removed)', async () => {
    await PATCH(patchReq({ agents: ["docker"], autonomy: false }), ctx("tmp"));
    const res = await PATCH(patchReq({ agents: "", autonomy: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.agents).toBeUndefined();
    expect(settings.autonomy).toBeUndefined();
    expect("agents" in persisted()).toBe(false);
    expect("autonomy" in persisted()).toBe(false);
  });

  it("PATCH leaves agents and autonomy untouched when omitted", async () => {
    await PATCH(patchReq({ agents: ["terraform"], autonomy: false }), ctx("tmp"));
    const res = await PATCH(patchReq({ model: "claude-sonnet-5" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(persisted()).toMatchObject({
      model: "claude-sonnet-5",
      agents: ["terraform"],
      autonomy: false,
    });
  });

  it("PATCH persists an empty agents array as 'no agents', distinct from a clear", async () => {
    const res = await PATCH(patchReq({ agents: [] }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.agents).toEqual([]);
    expect(persisted().agents).toEqual([]);
  });

  it("PATCH dedupes repeated agent ids", async () => {
    const res = await PATCH(patchReq({ agents: ["fastapi", "fastapi", "nextjs"] }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.agents).toEqual(["fastapi", "nextjs"]);
  });

  it("PATCH 400s for an unknown project", async () => {
    const res = await PATCH(patchReq({ autonomy: false }), ctx("nope"));
    expect(res.status).toBe(400);
  });

  it("PATCH persists a boolean conventionalCommits, and GET restores it (anton-41d)", async () => {
    const res = await PATCH(patchReq({ conventionalCommits: true }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.conventionalCommits).toBe(true);
    expect(persisted().conventionalCommits).toBe(true);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.conventionalCommits).toBe(true);
  });

  it("PATCH rejects a non-boolean conventionalCommits (anton-41d)", async () => {
    for (const bad of ["yes", 1, {}]) {
      const res = await PATCH(patchReq({ conventionalCommits: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
  });

  it('PATCH "" / null clears conventionalCommits back to OFF (key removed) (anton-41d)', async () => {
    await PATCH(patchReq({ conventionalCommits: true }), ctx("tmp"));
    const res = await PATCH(patchReq({ conventionalCommits: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.conventionalCommits).toBeUndefined();
    expect("conventionalCommits" in persisted()).toBe(false);
  });
});
