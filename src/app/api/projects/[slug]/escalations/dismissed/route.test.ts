/**
 * Route test for GET /api/projects/[slug]/escalations/dismissed — the older pages (PR #261 review).
 *
 * The property under test is REACHABILITY, not paging mechanics. A dismissal suppresses its stall
 * for as long as its row exists, and the Health page's disclosure is the only surface carrying
 * `Restore`. A row past the first page was therefore not merely hidden: it was a standing
 * suppression with no id and no way back, and a single bulk call dismisses up to 200 of them. So
 * what this asserts is that walking the offsets yields every dismissed row, once each.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { paramsCtx } from "@/lib/testing/integration";
import type { RunHealthFinding } from "@/lib/run-health";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

const { GET } = await import("./route");
const { raiseEscalation, settleEscalation, DISMISSED_PAGE } = await import("@/lib/escalations");

const NOW = 1_700_000_000_000;
const clock = { now: () => NOW };

const ctx = (slug: string) => paramsCtx({ slug });
const req = (query = "") => new Request(`http://t/${query}`);

interface Body {
  dismissed?: { id: string }[];
  total?: number;
  nextCursor?: { dismissedAt: number; id: string } | null;
  error?: string;
}

function finding(n: number): RunHealthFinding {
  return {
    kind: "exhausted-job",
    key: `exhausted-job:j-${n}`,
    reason: "claude exited 1: API Error 503",
    since: NOW - 4 * 3_600_000,
    ageMs: 4 * 3_600_000,
    jobId: `j-${n}`,
  };
}

/** One dismissed row, stamped by a human — the stamp that makes it suppress. */
async function dismissed(n: number, projectId = "p-alpha"): Promise<string> {
  const { escalation } = await raiseEscalation(tdb.db, clock, {
    projectId,
    finding: finding(n),
  });
  await settleEscalation(tdb.db, clock, escalation.id, "dismissed", true);
  return escalation.id;
}

describe("GET /api/projects/[slug]/escalations/dismissed", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(() => {
    tdb.db.delete(schema.escalations).run();
    tdb.db.delete(schema.projects).run();
    tdb.db
      .insert(schema.projects)
      .values([
        { id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" },
        { id: "p-beta", slug: "beta", name: "Beta", repoPath: "/tmp/beta" },
      ])
      .run();
  });

  it("hands back every dismissal across the pages, once each", async () => {
    const total = DISMISSED_PAGE + 7;
    const ids = new Set<string>();
    for (let n = 0; n < total; n++) ids.add(await dismissed(n));

    const first = (await (await GET(req(), ctx("alpha"))).json()) as Body;
    const cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    const second = (await (
      await GET(req(`?before=${cursor?.dismissedAt}&beforeId=${cursor?.id}`), ctx("alpha"))
    ).json()) as Body;

    expect(first.dismissed).toHaveLength(DISMISSED_PAGE);
    expect(second.dismissed).toHaveLength(7);
    expect(first.total).toBe(total);

    // The claim that matters: nothing is stranded. Every suppression is restorable from some page.
    const walked = [...(first.dismissed ?? []), ...(second.dismissed ?? [])].map((r) => r.id);
    expect(new Set(walked)).toEqual(ids);
  });

  it("is scoped to its project — one board's dismissals never page into another's", async () => {
    await dismissed(1);
    const body = (await (await GET(req(), ctx("beta"))).json()) as Body;
    expect(body.dismissed).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("refuses malformed cursor parts rather than silently answering page one", async () => {
    await dismissed(1);
    for (const q of ["?before=-1&beforeId=x", "?before=abc&beforeId=x", "?before=1"]) {
      const res = await GET(req(q), ctx("alpha"));
      expect(res.status).toBe(400);
    }
  });

  it("answers a cursor past the end with an empty page, not an error", async () => {
    await dismissed(1);
    const first = (await (await GET(req(), ctx("alpha"))).json()) as Body;
    const res = await GET(
      req(`?before=${first.nextCursor?.dismissedAt}&beforeId=00000000`),
      ctx("alpha"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.dismissed).toEqual([]);
    expect(body.total).toBe(1);
  });
});
