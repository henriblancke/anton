import { describe, expect, it } from "vitest";
import { parseTicketPatch } from "./ticket-patch";

describe("parseTicketPatch", () => {
  it("accepts a flat patch and folds managed labels into labels", () => {
    const r = parseTicketPatch({ title: "New", status: "in_progress", priority: 1, risk: "high" });
    expect(r).toEqual({
      patch: { title: "New", status: "in_progress", priority: 1, labels: { risk: "high" } },
    });
  });

  it("rejects an unknown field", () => {
    const r = parseTicketPatch({ risk: "high", approved: true });
    expect(r).toEqual({ error: "Unknown field: approved" });
  });

  it("rejects an invalid status", () => {
    expect(parseTicketPatch({ status: "done" })).toEqual({ error: "Invalid status: done" });
  });

  it("rejects an out-of-range or non-integer priority", () => {
    expect("error" in parseTicketPatch({ priority: 5 })).toBe(true);
    expect("error" in parseTicketPatch({ priority: 1.5 })).toBe(true);
    expect("error" in parseTicketPatch({ priority: "2" })).toBe(true);
  });

  it("rejects invalid label values", () => {
    expect(parseTicketPatch({ risk: "medium" })).toEqual({ error: "Invalid risk: medium" });
    expect(parseTicketPatch({ size: "XL" })).toEqual({ error: "Invalid size: XL" });
    expect(parseTicketPatch({ domain: "sales" })).toEqual({ error: "Invalid domain: sales" });
  });

  it("requires a non-empty title/agent", () => {
    expect("error" in parseTicketPatch({ title: "  " })).toBe(true);
    expect("error" in parseTicketPatch({ agent: "" })).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect("error" in parseTicketPatch(null)).toBe(true);
    expect("error" in parseTicketPatch([1])).toBe(true);
    expect("error" in parseTicketPatch("x")).toBe(true);
  });

  it("treats an empty patch as valid (no-op)", () => {
    expect(parseTicketPatch({})).toEqual({ patch: {} });
  });
});
