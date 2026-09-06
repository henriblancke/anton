/**
 * The deliberate-arming route (anton-d1lk), against a real in-memory anton.db.
 *
 * Four properties the settings panel cannot prove on its own. The signature is the SERVER's — who
 * armed it is resolved from the operator identity, never taken from the request — so the audit trail
 * means something. The structural floor is still refused: a project with no work policy cannot be
 * armed at all, at the route as well as in the resolver. A signature already standing is never
 * rewritten, not even by a second arming that started before it landed. And revoking removes the
 * signature ALONE, leaving the operator's chosen level in place for the earned floor to answer again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import { getProjectSettingsBySlug, resolvePickerAutonomy } from "@/lib/projects";
import type { ProjectSettings } from "@/lib/projects";

let tdb: TestDb;
/** Who the server says is asking — a function so a racing test can hand each request its own name. */
let operator: () => string | undefined = () => "Henri Blancke";

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
vi.mock("@/lib/operator", () => ({ resolveOperator: async () => operator() }));

const { DELETE, POST } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = (method: string) => new Request("http://t/", { method });

/** No pick answered either way — the state every project starts in, and the one the floor refuses. */
const NO_RECORD = { settled: 0, accepted: 0 };

async function settings(patch: ProjectSettings): Promise<void> {
  await tdb.db.update(schema.projects).set({ settingsJson: JSON.stringify(patch) });
}

const stored = () => getProjectSettingsBySlug("tmp");

describe("POST /picker/arming", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    operator = () => "Henri Blancke";
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
    await settings({ pickerPolicy: { types: ["bug"] } });
  });

  it("arms apply on a record that has not earned it, signed and dated", async () => {
    const before = Date.now();
    const res = await POST(req("POST"), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ armedBy: "Henri Blancke", autonomy: "apply" });

    const next = await stored();
    expect(next.pickerApplyOverride?.by).toBe("Henri Blancke");
    expect(Date.parse(next.pickerApplyOverride!.at)).toBeGreaterThanOrEqual(before);
    // Arming apply is one act: the signature and the level it is for.
    expect(next.pickerAutonomy).toBe("apply");
    expect(resolvePickerAutonomy(next, NO_RECORD)).toBe("apply");
  });

  it("refuses a project with no work policy, and stores nothing", async () => {
    await settings({});
    const res = await POST(req("POST"), ctx("tmp"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("no work policy") });

    const next = await stored();
    expect(next.pickerApplyOverride).toBeUndefined();
    expect(next.pickerAutonomy).toBeUndefined();
  });

  it("refuses a second arming rather than rewriting who signed and when", async () => {
    const signed = { by: "Someone Else", at: "2026-09-01T00:00:00.000Z" };
    await settings({ pickerPolicy: { types: ["bug"] }, pickerApplyOverride: signed });

    const res = await POST(req("POST"), ctx("tmp"));
    expect(res.status).toBe(409);
    expect((await stored()).pickerApplyOverride).toEqual(signed);
  });

  it("refuses to arm when anton cannot tell who is asking", async () => {
    // The whole justification for the bypass is that it names somebody; an unsigned one is a flag.
    operator = () => undefined;
    const res = await POST(req("POST"), ctx("tmp"));
    expect(res.status).toBe(500);
    expect((await stored()).pickerApplyOverride).toBeUndefined();
  });

  /**
   * The 409 has to be the state's answer, not a likely one: the guard used to run against a snapshot
   * read before the write, so two clicks landing together both found an unarmed project and the
   * loser silently replaced the winner's signature.
   */
  it("refuses the loser when two armings race, leaving one signature standing", async () => {
    const names = ["First Operator", "Second Operator"];
    operator = () => names.shift();

    const responses = await Promise.all([
      POST(req("POST"), ctx("tmp")),
      POST(req("POST"), ctx("tmp")),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);

    const winner = responses.find((r) => r.status === 200)!;
    const loser = responses.find((r) => r.status === 409)!;
    const { armedBy } = (await winner.json()) as { armedBy: string };
    expect((await stored()).pickerApplyOverride?.by).toBe(armedBy);
    // And the loser is told who actually holds it, rather than that it armed anything.
    expect(((await loser.json()) as { error: string }).error).toContain(armedBy);
  });
});

describe("DELETE /picker/arming", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    operator = () => "Henri Blancke";
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
    await settings({
      pickerPolicy: { types: ["bug"] },
      pickerAutonomy: "apply",
      pickerApplyOverride: { by: "Henri Blancke", at: "2026-09-06T10:00:00.000Z" },
    });
  });

  it("revokes the signature and returns the project to the floored level", async () => {
    const res = await DELETE(req("DELETE"), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ autonomy: "shadow" });

    const next = await stored();
    expect(next.pickerApplyOverride).toBeUndefined();
    // Only the bypass is gone — the level the operator chose is theirs, and the floor answers it.
    expect(next.pickerAutonomy).toBe("apply");
    expect(next.pickerPolicy).toEqual({ types: ["bug"] });
    expect(resolvePickerAutonomy(next, NO_RECORD)).toBe("shadow");
  });

  it("refuses when nothing is armed — the state is the server's answer", async () => {
    await DELETE(req("DELETE"), ctx("tmp"));
    const res = await DELETE(req("DELETE"), ctx("tmp"));
    expect(res.status).toBe(409);
  });
});
