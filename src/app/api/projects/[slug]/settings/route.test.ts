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

  it("PATCH persists a scanSeverity override, and GET restores it (anton-bz1w)", async () => {
    const scanSeverity = { medium: { risk: "high", priority: 1 } };
    const res = await PATCH(patchReq({ scanSeverity }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.scanSeverity).toEqual(scanSeverity);
    expect(persisted().scanSeverity).toEqual(scanSeverity);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.scanSeverity).toEqual(scanSeverity);
  });

  it("PATCH merges a scanSeverity patch per severity, leaving the others alone (anton-bz1w)", async () => {
    await PATCH(patchReq({ scanSeverity: { low: { risk: "high", priority: 2 } } }), ctx("tmp"));
    const res = await PATCH(
      patchReq({ scanSeverity: { critical: { risk: "high", priority: 0 } } }),
      ctx("tmp"),
    );
    expect((await res.json()).settings.scanSeverity).toEqual({
      low: { risk: "high", priority: 2 },
      critical: { risk: "high", priority: 0 },
    });
  });

  it("PATCH rejects an invalid scanSeverity without persisting (anton-bz1w)", async () => {
    for (const bad of [
      { medium: { risk: "medium", priority: 1 } }, // bd's risk vocabulary is low|high
      { medium: { risk: "high", priority: 9 } }, // priority is 0…4
      { medium: { risk: "high" } }, // half a rule is a question the prompt can't answer
      { nonsense: { risk: "high", priority: 1 } },
    ]) {
      const res = await PATCH(patchReq({ scanSeverity: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/scanSeverity/);
    }
    expect("scanSeverity" in persisted()).toBe(false);
  });

  it('PATCH "" / null clears scanSeverity back to the shipped mapping (anton-bz1w)', async () => {
    await PATCH(patchReq({ scanSeverity: { low: { risk: "high", priority: 0 } } }), ctx("tmp"));
    const res = await PATCH(patchReq({ scanSeverity: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.scanSeverity).toBeUndefined();
    expect("scanSeverity" in persisted()).toBe(false);
  });
});

/**
 * The product-master pass's prompt override (anton-d2sx) — the settings precedence pattern applied to
 * the one automation whose behaviour is a reasoning contract. Only the JUDGMENT is swappable; the
 * board context and the wire format stay anton's, which is what the pass's own suite asserts.
 */
describe("settings route — product-master prompt (anton-d2sx)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("persists an override and restores it, so the pass runs the operator's contract", async () => {
    const res = await PATCH(patchReq({ productMasterPrompt: "Rank by revenue." }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.productMasterPrompt).toBe("Rank by revenue.");

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.productMasterPrompt).toBe("Rank by revenue.");
  });

  it('"" / null clears it back to the shipped-default absence', async () => {
    await PATCH(patchReq({ productMasterPrompt: "Rank by revenue." }), ctx("tmp"));
    const res = await PATCH(patchReq({ productMasterPrompt: "" }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.productMasterPrompt).toBeUndefined();
    expect("productMasterPrompt" in persisted()).toBe(false);
  });

  it("rejects a non-string and an over-long prompt", async () => {
    expect((await PATCH(patchReq({ productMasterPrompt: 42 }), ctx("tmp"))).status).toBe(400);
    const long = "x".repeat(8001);
    expect((await PATCH(patchReq({ productMasterPrompt: long }), ctx("tmp"))).status).toBe(400);
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

  it("PATCH persists the score-alarm thresholds, including 0 as the off switch (anton-i98r)", async () => {
    // The cap rides along: a 3-round streak under the default cap of 2 could never trip, and is
    // rejected by the cross-check below.
    const res = await PATCH(
      patchReq({ reviewMaxRounds: 3, reviewMinScore: 7, reviewLowScoreRounds: 3 }),
      ctx("tmp"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ reviewMinScore: 7, reviewLowScoreRounds: 3 });

    // 0 is a VALUE here, not a clear: it is how the operator turns the alarm off, so it must persist.
    const off = await PATCH(patchReq({ reviewMinScore: 0 }), ctx("tmp"));
    expect((await off.json()).settings.reviewMinScore).toBe(0);
    expect(persisted().reviewMinScore).toBe(0);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings).toMatchObject({ reviewMinScore: 0, reviewLowScoreRounds: 3 });
  });

  it("PATCH rejects out-of-range score-alarm thresholds", async () => {
    for (const bad of [11, -1, 4.5, "low", "7", true]) {
      const res = await PATCH(patchReq({ reviewMinScore: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reviewMinScore/);
    }
    for (const bad of [0, 6, 1.5]) {
      const res = await PATCH(patchReq({ reviewLowScoreRounds: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reviewLowScoreRounds/);
    }
    expect("reviewMinScore" in persisted()).toBe(false);
    expect("reviewLowScoreRounds" in persisted()).toBe(false);
  });

  it("PATCH rejects a low-round streak longer than the round cap — the alarm could never fire", async () => {
    const res = await PATCH(
      patchReq({ reviewMaxRounds: 2, reviewMinScore: 5, reviewLowScoreRounds: 3 }),
      ctx("tmp"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reviewLowScoreRounds/);
    expect("reviewMaxRounds" in persisted()).toBe(false);

    // Equal is reachable: the alarm is evaluated after every round, the last one included.
    const ok = await PATCH(patchReq({ reviewMaxRounds: 2, reviewLowScoreRounds: 2 }), ctx("tmp"));
    expect(ok.status).toBe(200);
  });

  it("cross-checks the streak against the STORED round cap, not just the patched fields", async () => {
    await PATCH(patchReq({ reviewMaxRounds: 2 }), ctx("tmp"));
    // Only the streak is patched here — the cap it contradicts is the one already persisted.
    const res = await PATCH(patchReq({ reviewLowScoreRounds: 4 }), ctx("tmp"));
    expect(res.status).toBe(400);
    expect("reviewLowScoreRounds" in persisted()).toBe(false);

    // Raising the cap in the same patch resolves it.
    const ok = await PATCH(patchReq({ reviewMaxRounds: 5, reviewLowScoreRounds: 4 }), ctx("tmp"));
    expect(ok.status).toBe(200);
    expect(persisted()).toMatchObject({ reviewMaxRounds: 5, reviewLowScoreRounds: 4 });
  });

  it("allows an unreachable streak while the alarm is OFF (minimum score 0)", async () => {
    const res = await PATCH(
      patchReq({ reviewMinScore: 0, reviewMaxRounds: 1, reviewLowScoreRounds: 4 }),
      ctx("tmp"),
    );
    expect(res.status).toBe(200);
    expect(persisted()).toMatchObject({ reviewMinScore: 0, reviewLowScoreRounds: 4 });
  });

  it('PATCH null clears the score-alarm thresholds back to their defaults (keys removed)', async () => {
    await PATCH(
      patchReq({ reviewMaxRounds: 4, reviewMinScore: 8, reviewLowScoreRounds: 4 }),
      ctx("tmp"),
    );
    expect(persisted()).toMatchObject({ reviewMinScore: 8, reviewLowScoreRounds: 4 });
    const res = await PATCH(patchReq({ reviewMinScore: null, reviewLowScoreRounds: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect("reviewMinScore" in persisted()).toBe(false);
    expect("reviewLowScoreRounds" in persisted()).toBe(false);
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

describe("settings route — per-label pipeline variants (anton-aa3m)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("persists no key for a zero-config project — the map is absent, not empty", async () => {
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.formulaVariants).toBeUndefined();
    expect("formulaVariants" in persisted()).toBe(false);
  });

  it("PATCH persists the map IN ORDER — that order is the run-time precedence", async () => {
    const variants = [
      { label: "risk:high", formula: "anton-run-risk-high" },
      { label: "domain:docs", formula: "anton-run-docs" },
    ];
    const res = await PATCH(patchReq({ formulaVariants: variants }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.formulaVariants).toEqual(variants);
    expect(persisted().formulaVariants).toEqual(variants);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.formulaVariants).toEqual(variants);
  });

  it("clears the map on [] / null — back to one pipeline for everything", async () => {
    await PATCH(patchReq({ formulaVariants: [{ label: "risk:high", formula: "heavy" }] }), ctx("tmp"));
    await PATCH(patchReq({ formulaVariants: [] }), ctx("tmp"));
    expect("formulaVariants" in persisted()).toBe(false);

    await PATCH(patchReq({ formulaVariants: [{ label: "risk:high", formula: "heavy" }] }), ctx("tmp"));
    await PATCH(patchReq({ formulaVariants: null }), ctx("tmp"));
    expect("formulaVariants" in persisted()).toBe(false);
  });

  it("rejects a formula that isn't a formula name — a mapping can't escape .beads/formulas", async () => {
    await PATCH(patchReq({ formulaVariants: [{ label: "risk:high", formula: "heavy" }] }), ctx("tmp"));
    for (const formula of ["../../etc/passwd", "nested/heavy", ""]) {
      const res = await PATCH(patchReq({ formulaVariants: [{ label: "risk:high", formula }] }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/formulaVariants/);
    }
    // The stored (valid) map is untouched by every rejection.
    expect(persisted().formulaVariants).toEqual([{ label: "risk:high", formula: "heavy" }]);
  });

  it("rejects a label mapped twice — a shadowed entry is a mistake, not a precedence", async () => {
    const res = await PATCH(
      patchReq({
        formulaVariants: [
          { label: "risk:high", formula: "heavy" },
          { label: "risk:high", formula: "heavier" },
        ],
      }),
      ctx("tmp"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most one formula/);
  });

  it("rejects a malformed entry (missing label, unknown key, non-array)", async () => {
    for (const value of [
      [{ formula: "heavy" }],
      [{ label: "risk:high", formula: "heavy", when: "always" }],
      "risk:high=heavy",
      [{ label: "  ", formula: "heavy" }],
    ]) {
      const res = await PATCH(patchReq({ formulaVariants: value }), ctx("tmp"));
      expect(res.status).toBe(400);
    }
  });
});

/**
 * Nominated value labels (anton-prng): the nominations round-trip IN ORDER (the order is the value
 * band order), nominating none is stored as absent, and a repeat 400s rather than persisting a tier
 * that can never be reached.
 */
describe("settings route — nominated value labels (anton-prng)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("persists no key for a zero-config project — anton nominates nothing", async () => {
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.valueLabels).toBeUndefined();
    expect("valueLabels" in persisted()).toBe(false);
  });

  it("PATCH persists the nominations IN ORDER, and GET restores them", async () => {
    const valueLabels = ["risk:high", "blocking-PR"];
    const res = await PATCH(patchReq({ valueLabels }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.valueLabels).toEqual(valueLabels);
    expect(persisted().valueLabels).toEqual(valueLabels);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.valueLabels).toEqual(valueLabels);
  });

  it("replaces rather than merges — re-ranking must be able to drop a nomination", async () => {
    await PATCH(patchReq({ valueLabels: ["risk:high", "blocking-PR"] }), ctx("tmp"));
    await PATCH(patchReq({ valueLabels: ["blocking-PR"] }), ctx("tmp"));
    expect(persisted().valueLabels).toEqual(["blocking-PR"]);
  });

  it("clears on [] / null — back to ranking on native fields alone", async () => {
    await PATCH(patchReq({ valueLabels: ["risk:high"] }), ctx("tmp"));
    await PATCH(patchReq({ valueLabels: [] }), ctx("tmp"));
    expect("valueLabels" in persisted()).toBe(false);

    await PATCH(patchReq({ valueLabels: ["risk:high"] }), ctx("tmp"));
    await PATCH(patchReq({ valueLabels: null }), ctx("tmp"));
    expect("valueLabels" in persisted()).toBe(false);
  });

  it("rejects a repeat or malformed nomination without disturbing what is stored", async () => {
    await PATCH(patchReq({ valueLabels: ["risk:high"] }), ctx("tmp"));
    for (const value of [
      ["risk:high", "risk:high"],
      ["  "],
      [42],
      "risk:high",
      Array.from({ length: 9 }, (_, i) => `l${i}`),
    ]) {
      const res = await PATCH(patchReq({ valueLabels: value }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/valueLabels/);
    }
    expect(persisted().valueLabels).toEqual(["risk:high"]);
  });
});

/**
 * Per-kind proposal autonomy (anton-nbyy): the policy round-trips, merges per kind, and a submission
 * naming a kind or a level anton doesn't know 400s rather than persisting an entry that would
 * silently resolve back to `propose`.
 */
describe("settings route — proposal autonomy policy (anton-nbyy)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  it("persists no key for a zero-config project — propose everywhere is an absence", async () => {
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.proposalAutonomy).toBeUndefined();
    expect("proposalAutonomy" in persisted()).toBe(false);
  });

  it("PATCH persists a policy, and GET restores it after a reload", async () => {
    const proposalAutonomy = { stale: "shadow", "shipped-orphan": "apply" };
    const res = await PATCH(patchReq({ proposalAutonomy }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.proposalAutonomy).toEqual(proposalAutonomy);
    expect(persisted().proposalAutonomy).toEqual(proposalAutonomy);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.proposalAutonomy).toEqual(proposalAutonomy);
  });

  it("merges per kind, so a client that sends one kind can't disarm the others", async () => {
    await PATCH(patchReq({ proposalAutonomy: { stale: "shadow" } }), ctx("tmp"));
    const res = await PATCH(patchReq({ proposalAutonomy: { "low-value": "shadow" } }), ctx("tmp"));
    expect((await res.json()).settings.proposalAutonomy).toEqual({
      stale: "shadow",
      "low-value": "shadow",
    });
  });

  it("rejects an unknown kind or an unknown level, without persisting", async () => {
    await PATCH(patchReq({ proposalAutonomy: { stale: "shadow" } }), ctx("tmp"));
    for (const bad of [
      { "kind-from-the-future": "shadow" }, // not a detection kind
      { stale: "armed" }, // not one of the three levels
      { stale: true },
      ["stale"],
      "shadow",
    ]) {
      const res = await PATCH(patchReq({ proposalAutonomy: bad }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/proposalAutonomy/);
    }
    expect(persisted().proposalAutonomy).toEqual({ stale: "shadow" });
  });

  it('"" / null clears the policy back to propose everywhere (key removed)', async () => {
    await PATCH(patchReq({ proposalAutonomy: { stale: "shadow" } }), ctx("tmp"));
    const res = await PATCH(patchReq({ proposalAutonomy: null }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.proposalAutonomy).toBeUndefined();
    expect("proposalAutonomy" in persisted()).toBe(false);
  });
});

/**
 * The standing work policy (anton-c7iv). Absent is the load-bearing state — it means the project was
 * never armed, which is what makes first arm propose a calibrated draft — so the round trip has to
 * keep "no key" and "no key" distinguishable from an empty policy, and a criterion the operator drops
 * has to actually leave the store.
 */
describe("settings route — work policy (anton-c7iv)", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
  });

  const policy = {
    types: ["bug", "chore"],
    maxPriority: 2,
    labels: [{ namespace: "severity", values: ["critical", "major"] }],
    requireUnblocked: true,
  };

  it("persists no key for a project nobody has armed", async () => {
    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.pickerPolicy).toBeUndefined();
    expect("pickerPolicy" in persisted()).toBe(false);
  });

  it("PATCH persists an accepted policy, and GET restores it", async () => {
    const res = await PATCH(patchReq({ pickerPolicy: policy }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.pickerPolicy).toEqual(policy);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.pickerPolicy).toEqual(policy);
  });

  it("replaces rather than merges — widening a policy means dropping a criterion", async () => {
    await PATCH(patchReq({ pickerPolicy: policy }), ctx("tmp"));
    await PATCH(patchReq({ pickerPolicy: { types: ["bug"] } }), ctx("tmp"));
    expect(persisted().pickerPolicy).toEqual({ types: ["bug"] });
  });

  it("clears on null — the project is unarmed again, not armed with nothing", async () => {
    await PATCH(patchReq({ pickerPolicy: policy }), ctx("tmp"));
    await PATCH(patchReq({ pickerPolicy: null }), ctx("tmp"));
    expect("pickerPolicy" in persisted()).toBe(false);
  });

  it("round-trips a hand-ranked namespace in the operator's order (anton-qsr1)", async () => {
    // The ORDER is the ranking (R2.3), so it must survive the write and the read back unsorted —
    // a policy that re-alphabetised on save would silently discard what the operator dragged.
    const ranked = {
      labels: [{ namespace: "severity", values: ["major", "critical", "minor"], ranked: true }],
    };
    const res = await PATCH(patchReq({ pickerPolicy: ranked }), ctx("tmp"));
    expect(res.status).toBe(200);

    const get = await GET(new Request("http://t/"), ctx("tmp"));
    expect((await get.json()).settings.pickerPolicy).toEqual(ranked);
    expect(persisted().pickerPolicy).toEqual(ranked);
  });

  it("round-trips the ordered native bounds and a ranked comparison (anton-hmyo)", async () => {
    // Both ends of every ordered field, plus the one ordering a discovered namespace ever gets —
    // the operator's own ranking, with the bound they set against it.
    const ordered = {
      minPriority: 1,
      maxPriority: 3,
      minParentDepth: 0,
      maxParentDepth: 1,
      minAgeDays: 1,
      maxAgeDays: 180,
      labels: [
        {
          namespace: "severity",
          values: ["critical", "major", "minor"],
          ranked: true,
          compare: { op: "lte", value: "major" },
        },
      ],
    };
    const res = await PATCH(patchReq({ pickerPolicy: ordered }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(persisted().pickerPolicy).toEqual(ordered);
  });

  it("rejects a malformed policy without disturbing what is stored", async () => {
    await PATCH(patchReq({ pickerPolicy: policy }), ctx("tmp"));
    for (const value of [
      // An empty membership set fails closed against every bead — never what an operator meant.
      { types: [] },
      { labels: [{ namespace: "severity", values: [] }] },
      // One namespace, one criterion: a second entry could never be reached.
      {
        labels: [
          { namespace: "severity", values: ["major"] },
          { namespace: "severity", values: ["minor"] },
        ],
      },
      // A value listed twice is one membership test twice over, and under a ranking it is a value
      // at two positions — a bound could then admit a slice the stored order does not show.
      { labels: [{ namespace: "severity", values: ["major", "major"] }] },
      {
        labels: [
          {
            namespace: "severity",
            values: ["critical", "major", "critical"],
            ranked: true,
            compare: { op: "lte", value: "critical" },
          },
        ],
      },
      { maxPriority: -1 },
      { maxPriority: "P2" },
      { requireUnblocked: "yes" },
      { labels: [{ namespace: "severity", values: ["major"], ranked: "yes" }] },
      // A comparison the predicate could only ever fail closed on is a policy that admits nothing
      // and says so one bead at a time — rejected here instead, where the operator can see it.
      {
        labels: [
          { namespace: "severity", values: ["critical", "major"], compare: { op: "lte", value: "major" } },
        ],
      },
      {
        labels: [
          {
            namespace: "severity",
            values: ["critical", "major"],
            ranked: true,
            compare: { op: "lte", value: "blocker" },
          },
        ],
      },
      {
        labels: [
          {
            namespace: "severity",
            values: ["critical", "major"],
            ranked: true,
            compare: { op: "under", value: "major" },
          },
        ],
      },
      { minPriority: 5 },
      { maxParentDepth: -1 },
      { minAgeDays: "a week" },
      { unknownCriterion: true },
      ["bug"],
    ]) {
      const res = await PATCH(patchReq({ pickerPolicy: value }), ctx("tmp"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/pickerPolicy/);
    }
    expect(persisted().pickerPolicy).toEqual(policy);
  });
});
