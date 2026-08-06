/**
 * Route test for POST /api/projects/[slug]/epics/[epicId]/rework — the surface that sends a ticket
 * back. What is under test is the HTTP CONTRACT the rework dialog codes against: the five-way status
 * mapping the domain's error classes are folded onto, and the body shaping done before they can run.
 *
 * The domain verb (`reworkTicket`) is stubbed — what it does to the board is `rework.ts`'s own suite
 * and the integration test's job — while its ERROR CLASSES stay real, so `instanceof` is dispatched
 * on the same objects production throws. A wrong mapping here is what strands a 422 the dialog would
 * have explained behind a generic 500, or reads a live-run race as a malformed request.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { jsonRequest, paramsCtx } from "@/lib/testing/integration";
import type { Project, ReworkResult } from "@/lib/types";
import type { ReviewFinding } from "@/lib/jobs/review-context";
import type { ReworkInput } from "@/lib/rework";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// rework.ts reaches jobs/service for its live-run check; nothing here starts a runner.
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const reworkTicket =
  vi.fn<(project: Project, targetId: string, input: ReworkInput) => Promise<ReworkResult>>();
vi.mock("@/lib/rework", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rework")>("@/lib/rework");
  return {
    ...actual,
    reworkTicket: (...args: [Project, string, ReworkInput]) => reworkTicket(...args),
  };
});

const { POST } = await import("./route");
const {
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
} = await import("@/lib/rework");

const post = (slug: string, epicId: string, body?: unknown) =>
  POST(jsonRequest("POST", body), paramsCtx({ slug, epicId }));

/** A well-formed request — each case varies only what it is about. */
const BODY = {
  ticketId: "anton-t9",
  mode: "reopen",
  summary: "the retry path is still untested",
  instructions: "Add a test that fails without the backoff cap.",
} as const;

const RESULT: ReworkResult = {
  mode: "reopen",
  ticketId: "anton-t9",
  reworkedId: "anton-t9",
  note: "Add a test that fails without the backoff cap.",
  applied: true,
};

/** The input the handler shaped out of the last request body. */
const lastInput = (): ReworkInput => reworkTicket.mock.calls.at(-1)![2];

describe("POST /api/projects/[slug]/epics/[epicId]/rework", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(() => {
    tdb.db.delete(schema.projects).run();
    tdb.db
      .insert(schema.projects)
      .values({ id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" })
      .run();
    reworkTicket.mockResolvedValue(RESULT);
  });

  afterEach(() => vi.clearAllMocks());

  describe("200 — the rework applied", () => {
    it("returns the domain result, against the project the slug resolved to", async () => {
      const res = await post("alpha", "anton-e1", BODY);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: RESULT });
      const [project, targetId] = reworkTicket.mock.calls[0];
      expect(project).toMatchObject({ id: "p-alpha", repoPath: "/tmp/alpha" });
      expect(targetId).toBe("anton-e1");
    });

    // A double-submit is a 200 that changed nothing — the dialog reads `applied` to say so.
    it("carries an idempotent repeat's applied:false through unchanged", async () => {
      reworkTicket.mockResolvedValue({ ...RESULT, applied: false });

      const res = await post("alpha", "anton-e1", BODY);

      expect(res.status).toBe(200);
      expect((await res.json()).result.applied).toBe(false);
    });
  });

  describe("the status mapping — one code per refusal the dialog can explain", () => {
    it.each<[number, new (message: string) => Error, string]>([
      [409, ReworkConflictError, "A run is executing anton-e1 right now"],
      [422, ReworkNotAllowedError, "anton-t9 is not part of anton-e1's run"],
      [400, ReworkInvalidError, "Fix instructions are required"],
      [404, ReworkNotFoundError, "Ticket anton-e1 not found on the board"],
    ])("answers %i with the error's own message", async (status, Err, message) => {
      reworkTicket.mockRejectedValue(new Err(message));

      const res = await post("alpha", "anton-e1", BODY);

      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(message);
    });

    // Anything the domain did not classify is a bug, not a refusal: it must not borrow a 4xx that
    // tells the founder their request was wrong.
    it("500s an unclassified failure, surfacing its message", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      reworkTicket.mockRejectedValue(new Error("bd: database is locked"));

      const res = await post("alpha", "anton-e1", BODY);

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("bd: database is locked");
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });

    it("500s with a generic message when the throw carries none", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      reworkTicket.mockRejectedValue("rework exploded");

      const res = await post("alpha", "anton-e1", BODY);

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Failed to send the ticket back");
      logged.mockRestore();
    });

    it("404s an unknown project slug before the domain runs at all", async () => {
      const res = await post("nope", "anton-e1", BODY);

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Project not found");
      expect(reworkTicket).not.toHaveBeenCalled();
    });
  });

  describe("400 — the request body never parsed", () => {
    it.each([
      ["no body at all", undefined],
      ["a body that is not JSON", "reopen"],
      ["a truncated JSON body", '{"ticketId":'],
    ])("rejects %s without touching the board", async (_label, raw) => {
      const res = await POST(
        new Request("http://t/", { method: "POST", ...(raw === undefined ? {} : { body: raw }) }),
        paramsCtx({ slug: "alpha", epicId: "anton-e1" }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
      expect(reworkTicket).not.toHaveBeenCalled();
    });
  });

  describe("body shaping — shape only, the domain owns the validation", () => {
    it("passes the four text fields through, coercing a non-string to empty for the domain to reject", async () => {
      await post("alpha", "anton-e1", { ...BODY, mode: "follow-up", ticketId: 7, summary: null });

      expect(lastInput()).toEqual({
        ticketId: "",
        mode: "follow-up",
        summary: "",
        instructions: BODY.instructions,
        findings: [],
      });
    });

    it("defaults a bodyless-but-valid JSON payload to empty fields rather than throwing", async () => {
      await post("alpha", "anton-e1", null);

      expect(lastInput()).toMatchObject({ ticketId: "", summary: "", instructions: "" });
    });

    // The findings are inlined into a bead note and from there into an agent's prompt, so a
    // malformed entry has to be DROPPED — never rendered as `undefined — undefined`.
    it("keeps well-formed findings and drops the malformed ones", async () => {
      const kept: ReviewFinding = {
        severity: "blocking",
        location: "src/retry.ts:20",
        note: "no backoff cap",
      };

      await post("alpha", "anton-e1", {
        ...BODY,
        findings: [
          kept,
          { severity: "blocking", location: "src/a.ts" }, // no note
          { severity: "advisory", location: "src/b.ts", note: "   " }, // blank note
          { severity: "advisory", location: "src/c.ts", note: 42 }, // note isn't text
          null,
          "not a finding",
          { note: "unlocated and unrated" }, // salvageable: defaults fill the rest
        ],
      });

      expect(lastInput().findings).toEqual([
        kept,
        { severity: "advisory", location: "(general)", note: "unlocated and unrated" },
      ]);
    });

    it("treats a findings field that is not a list as no findings", async () => {
      await post("alpha", "anton-e1", { ...BODY, findings: "no backoff cap" });

      expect(lastInput().findings).toEqual([]);
    });

    // Only "blocking" is blocking: an unknown severity from a hand-edited payload must not be
    // inlined verbatim into the prompt as if the reviewer had written it.
    it("narrows an unknown severity to advisory", async () => {
      await post("alpha", "anton-e1", {
        ...BODY,
        findings: [{ severity: "catastrophic", location: "src/a.ts", note: "the roof is on fire" }],
      });

      expect(lastInput().findings).toEqual([
        { severity: "advisory", location: "src/a.ts", note: "the roof is on fire" },
      ]);
    });
  });
});
