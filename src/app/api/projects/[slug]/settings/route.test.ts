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

  it("PATCH persists a boolean budgetAware, and GET restores it (anton-7mpv.1)", async () => {
    const res = await PATCH(patchReq({ budgetAware: true }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.budgetAware).toBe(true);
    expect(persisted().budgetAware).toBe(true);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.budgetAware).toBe(true);
  });

  it("PATCH rejects a non-boolean budgetAware (anton-7mpv.1)", async () => {
    for (const bad of ["yes", 1, {}]) {
      const res = await PATCH(patchReq({ budgetAware: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
  });

  it('PATCH "" / null clears budgetAware back to OFF (key removed) (anton-7mpv.1)', async () => {
    await PATCH(patchReq({ budgetAware: true }), ctx("tmp"));
    const res = await PATCH(patchReq({ budgetAware: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.budgetAware).toBeUndefined();
    expect("budgetAware" in persisted()).toBe(false);
  });

  it("PATCH persists a budgetPolicy, and GET restores it (anton-egrg)", async () => {
    const budgetPolicy = { daytimeReservePct: 25, weeklyTargetPct: 80 };
    const res = await PATCH(patchReq({ budgetPolicy }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.budgetPolicy).toEqual(budgetPolicy);
    expect(persisted().budgetPolicy).toEqual(budgetPolicy);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.budgetPolicy).toEqual(budgetPolicy);
  });

  it("PATCH rejects an out-of-range budgetPolicy without persisting (anton-egrg)", async () => {
    for (const bad of [
      { daytimeReservePct: 101 },
      { weeklyTargetPct: -1 },
      { dayWindow: [18, 9] },
      { unknownKnob: 5 },
    ]) {
      const res = await PATCH(patchReq({ budgetPolicy: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/budgetPolicy/);
    }
    expect("budgetPolicy" in persisted()).toBe(false);
  });

  it('PATCH "" / null clears budgetPolicy back to defaults (key removed) (anton-egrg)', async () => {
    await PATCH(patchReq({ budgetPolicy: { daytimeReservePct: 25 } }), ctx("tmp"));
    const res = await PATCH(patchReq({ budgetPolicy: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.budgetPolicy).toBeUndefined();
    expect("budgetPolicy" in persisted()).toBe(false);
  });
});

/**
 * Per-project self-review settings (anton-of1m): the gate's on/off flag, the swapped reviewer
 * (validated against discoverAgents like the allowlist), the prompt override (mirroring
 * reviewFixPrompt), and the bounded round cap.
 */
describe("settings route — self-review settings (anton-of1m)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("defaults to ON by absence: a fresh project persists no reviewEnabled key", async () => {
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.reviewEnabled).toBeUndefined();
    expect("reviewEnabled" in persisted()).toBe(false);
  });

  it("PATCH persists reviewEnabled:false, and GET restores it", async () => {
    const res = await PATCH(patchReq({ reviewEnabled: false }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewEnabled).toBe(false);
    expect(persisted().reviewEnabled).toBe(false);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.reviewEnabled).toBe(false);
  });

  it('PATCH "" / null clears reviewEnabled back to the default-ON absence', async () => {
    await PATCH(patchReq({ reviewEnabled: false }), ctx("tmp"));
    const res = await PATCH(patchReq({ reviewEnabled: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewEnabled).toBeUndefined();
    expect("reviewEnabled" in persisted()).toBe(false);
  });

  it("PATCH rejects a non-boolean reviewEnabled", async () => {
    for (const bad of ["yes", 1, {}]) {
      const res = await PATCH(patchReq({ reviewEnabled: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
    expect("reviewEnabled" in persisted()).toBe(false);
  });

  it("PATCH persists a discoverable reviewAgent, and GET restores it", async () => {
    const res = await PATCH(patchReq({ reviewAgent: "nextjs" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewAgent).toBe("nextjs");
    expect(persisted().reviewAgent).toBe("nextjs");

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.reviewAgent).toBe("nextjs");
  });

  it("PATCH rejects a reviewAgent discoverAgents doesn't know, leaving settings untouched", async () => {
    await PATCH(patchReq({ reviewAgent: "fastapi" }), ctx("tmp"));
    const res = await PATCH(patchReq({ reviewAgent: "cobol" }), ctx("tmp"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cobol/);
    expect(persisted().reviewAgent).toBe("fastapi");
  });

  it("PATCH rejects a non-string reviewAgent", async () => {
    for (const bad of [42, ["nextjs"], {}]) {
      const res = await PATCH(patchReq({ reviewAgent: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
  });

  it('PATCH "" / null clears reviewAgent back to the shipped contract (key removed)', async () => {
    await PATCH(patchReq({ reviewAgent: "nextjs" }), ctx("tmp"));
    const res = await PATCH(patchReq({ reviewAgent: "" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewAgent).toBeUndefined();
    expect("reviewAgent" in persisted()).toBe(false);
  });

  it("PATCH persists a reviewPrompt override and clears it on empty", async () => {
    const res = await PATCH(patchReq({ reviewPrompt: "Review for data loss only." }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewPrompt).toBe("Review for data loss only.");

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.reviewPrompt).toBe("Review for data loss only.");

    const cleared = await PATCH(patchReq({ reviewPrompt: null }), ctx("tmp"));
    expect((await cleared.json()).settings.reviewPrompt).toBeUndefined();
    expect("reviewPrompt" in persisted()).toBe(false);
  });

  it("PATCH rejects an over-long or non-string reviewPrompt", async () => {
    const tooLong = await PATCH(patchReq({ reviewPrompt: "x".repeat(8001) }), ctx("tmp"));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/reviewPrompt/);

    const notString = await PATCH(patchReq({ reviewPrompt: 42 }), ctx("tmp"));
    expect(notString.status).toBe(400);
    expect("reviewPrompt" in persisted()).toBe(false);
  });

  it("PATCH persists an in-range reviewMaxRounds, and GET restores it", async () => {
    const res = await PATCH(patchReq({ reviewMaxRounds: 3 }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewMaxRounds).toBe(3);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.reviewMaxRounds).toBe(3);
  });

  it("PATCH rejects an out-of-range or non-integer reviewMaxRounds", async () => {
    for (const bad of [0, 6, 2.5, "many"]) {
      const res = await PATCH(patchReq({ reviewMaxRounds: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reviewMaxRounds/);
    }
    expect("reviewMaxRounds" in persisted()).toBe(false);
  });

  it('PATCH "" / null clears reviewMaxRounds back to the default (key removed)', async () => {
    await PATCH(patchReq({ reviewMaxRounds: 4 }), ctx("tmp"));
    const res = await PATCH(patchReq({ reviewMaxRounds: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.reviewMaxRounds).toBeUndefined();
    expect("reviewMaxRounds" in persisted()).toBe(false);
  });

  it("round-trips the whole review block in one PATCH, alongside the agents allowlist", async () => {
    const res = await PATCH(
      patchReq({
        agents: ["fastapi"],
        reviewEnabled: true,
        reviewAgent: "supabase",
        reviewPrompt: "Focus on RLS.",
        reviewMaxRounds: 5,
      }),
      ctx("tmp"),
    );
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings).toMatchObject({
      agents: ["fastapi"],
      reviewEnabled: true,
      reviewAgent: "supabase",
      reviewPrompt: "Focus on RLS.",
      reviewMaxRounds: 5,
    });

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings).toMatchObject({
      reviewEnabled: true,
      reviewAgent: "supabase",
      reviewPrompt: "Focus on RLS.",
      reviewMaxRounds: 5,
    });
  });
});
