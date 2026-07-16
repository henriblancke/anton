import { describe, expect, it } from "vitest";
import { parseTicketPatch } from "./ticket-patch";

describe("parseTicketPatch", () => {
  it("accepts a flat patch and folds managed labels into labels", () => {
    const r = parseTicketPatch({ title: "New", status: "in_progress", priority: 1, risk: "high" });
    expect(r).toEqual({
      patch: { title: "New", status: "in_progress", priority: 1, labels: { risk: "high" } },
    });
  });

  it("accepts every field at once and routes each to patch or labels", () => {
    const r = parseTicketPatch({
      title: "T",
      status: "blocked",
      priority: 0,
      description: "## Goal\n\nd",
      acceptance: "- [ ] a",
      agent: "eng",
      risk: "low",
      size: "L",
      domain: "ops",
    });
    expect(r).toEqual({
      patch: {
        title: "T",
        status: "blocked",
        priority: 0,
        description: "## Goal\n\nd",
        acceptance: "- [ ] a",
        labels: { agent: "eng", risk: "low", size: "L", domain: "ops" },
      },
    });
  });

  it("rejects an unknown field", () => {
    const r = parseTicketPatch({ risk: "high", approved: true });
    expect(r).toEqual({ error: "Unknown field: approved" });
  });

  it("rejects an unknown field before validating any known field's value", () => {
    // A bad known value must not mask an unknown key — the unknown check runs first.
    expect(parseTicketPatch({ status: "done", surprise: 1 })).toEqual({
      error: "Unknown field: surprise",
    });
  });

  describe("title", () => {
    it("accepts a non-empty string", () => {
      expect(parseTicketPatch({ title: "Hello" })).toEqual({ patch: { title: "Hello" } });
    });
    it("rejects a blank or non-string value", () => {
      expect(parseTicketPatch({ title: "  " })).toEqual({
        error: "title must be a non-empty string",
      });
      expect(parseTicketPatch({ title: 5 })).toEqual({
        error: "title must be a non-empty string",
      });
    });
  });

  describe("status", () => {
    it("accepts each allowed status", () => {
      for (const status of ["open", "in_progress", "blocked", "closed"]) {
        expect(parseTicketPatch({ status })).toEqual({ patch: { status } });
      }
    });
    it("rejects an invalid status", () => {
      expect(parseTicketPatch({ status: "done" })).toEqual({ error: "Invalid status: done" });
      expect(parseTicketPatch({ status: 1 })).toEqual({ error: "Invalid status: 1" });
    });
  });

  describe("priority", () => {
    it("accepts the integer range 0-4", () => {
      for (const priority of [0, 1, 2, 3, 4]) {
        expect(parseTicketPatch({ priority })).toEqual({ patch: { priority } });
      }
    });
    it("rejects out-of-range, non-integer, or non-number priorities", () => {
      for (const priority of [-1, 5, 1.5, "2", null]) {
        expect(parseTicketPatch({ priority })).toEqual({
          error: `Invalid priority: ${String(priority)} (expected integer 0-4)`,
        });
      }
    });
  });

  describe("description / acceptance (contract markdown)", () => {
    it("passes both straight through", () => {
      const r = parseTicketPatch({ description: "## Goal\n\ng", acceptance: "- [ ] a" });
      expect(r).toEqual({ patch: { description: "## Goal\n\ng", acceptance: "- [ ] a" } });
    });
    it("rejects an empty or non-string description", () => {
      expect(parseTicketPatch({ description: "  " })).toEqual({
        error: "description must be a non-empty string",
      });
      expect(parseTicketPatch({ description: 5 })).toEqual({
        error: "description must be a non-empty string",
      });
    });
    it("rejects an empty or non-string acceptance", () => {
      expect(parseTicketPatch({ acceptance: "" })).toEqual({
        error: "acceptance must be a non-empty string",
      });
      expect(parseTicketPatch({ acceptance: [] })).toEqual({
        error: "acceptance must be a non-empty string",
      });
    });
  });

  describe("agent", () => {
    it("accepts a free-form non-empty string as a label", () => {
      expect(parseTicketPatch({ agent: "custom-bot" })).toEqual({
        patch: { labels: { agent: "custom-bot" } },
      });
    });
    it("rejects a blank or non-string agent", () => {
      expect(parseTicketPatch({ agent: "" })).toEqual({
        error: "agent must be a non-empty string",
      });
      expect(parseTicketPatch({ agent: 1 })).toEqual({
        error: "agent must be a non-empty string",
      });
    });
  });

  describe("risk / size / domain (constrained labels)", () => {
    it("accepts each allowed value", () => {
      expect(parseTicketPatch({ risk: "med" })).toEqual({ patch: { labels: { risk: "med" } } });
      expect(parseTicketPatch({ size: "S" })).toEqual({ patch: { labels: { size: "S" } } });
      expect(parseTicketPatch({ domain: "research" })).toEqual({
        patch: { labels: { domain: "research" } },
      });
    });
    it("rejects invalid label values", () => {
      expect(parseTicketPatch({ risk: "medium" })).toEqual({ error: "Invalid risk: medium" });
      expect(parseTicketPatch({ size: "XL" })).toEqual({ error: "Invalid size: XL" });
      expect(parseTicketPatch({ domain: "sales" })).toEqual({ error: "Invalid domain: sales" });
    });
  });

  describe("non-object bodies", () => {
    it("rejects null, arrays, and primitives with a single message", () => {
      for (const body of [null, [1], "x", 42, true, undefined]) {
        expect(parseTicketPatch(body)).toEqual({ error: "Body must be a JSON object" });
      }
    });
  });

  it("treats an empty patch as valid (no-op)", () => {
    expect(parseTicketPatch({})).toEqual({ patch: {} });
  });

  it("does not attach a labels key when no managed label is present", () => {
    const r = parseTicketPatch({ title: "T" });
    expect(r).toEqual({ patch: { title: "T" } });
    expect("labels" in (r as { patch: Record<string, unknown> }).patch).toBe(false);
  });
});
