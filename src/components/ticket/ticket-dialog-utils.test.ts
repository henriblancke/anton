import { describe, expect, it } from "vitest";
import {
  diffTicketPatch,
  draftFromDetail,
  hasTicketChanges,
  type TicketDraft,
} from "@/components/ticket/ticket-dialog-utils";
import type { TicketDetail } from "@/lib/types";

const detail: TicketDetail = {
  id: "bd-1",
  title: "Do the thing",
  status: "open",
  stage: "backlog",
  type: "task",
  priority: 2,
  agent: "nextjs",
  risk: "low",
  size: "M",
};

const base = draftFromDetail(detail);

describe("draftFromDetail", () => {
  it("maps detail fields, defaulting absent labels to empty strings", () => {
    const bare = draftFromDetail({ id: "x", title: "t", status: "open", stage: "backlog", type: "task" });
    expect(bare).toEqual({ title: "t", status: "open", priority: undefined, agent: "", risk: "", size: "" });
  });
});

describe("diffTicketPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(diffTicketPatch(base, { ...base })).toEqual({});
  });

  it("sends only the one changed field", () => {
    expect(diffTicketPatch(base, { ...base, risk: "high" })).toEqual({ risk: "high" });
  });

  it("collects multiple changed fields", () => {
    const draft: TicketDraft = { ...base, title: "New title", status: "in_progress", size: "L" };
    expect(diffTicketPatch(base, draft)).toEqual({ title: "New title", status: "in_progress", size: "L" });
  });

  it("trims the title and ignores whitespace-only changes", () => {
    expect(diffTicketPatch(base, { ...base, title: "  Do the thing  " })).toEqual({});
    expect(diffTicketPatch(base, { ...base, title: "  Renamed  " })).toEqual({ title: "Renamed" });
  });

  it("never sends an empty title", () => {
    expect(diffTicketPatch(base, { ...base, title: "   " })).toEqual({});
  });

  it("sends a changed priority including 0, but not a cleared one", () => {
    expect(diffTicketPatch(base, { ...base, priority: 0 })).toEqual({ priority: 0 });
    expect(diffTicketPatch(base, { ...base, priority: undefined })).toEqual({});
  });

  it("sets a previously-absent label but never clears one to empty", () => {
    const bare = draftFromDetail({ id: "x", title: "t", status: "open", stage: "backlog", type: "task" });
    expect(diffTicketPatch(bare, { ...bare, agent: "docker" })).toEqual({ agent: "docker" });
    expect(diffTicketPatch(base, { ...base, agent: "" })).toEqual({});
  });
});

describe("hasTicketChanges", () => {
  it("is false when nothing changed and true otherwise", () => {
    expect(hasTicketChanges(base, { ...base })).toBe(false);
    expect(hasTicketChanges(base, { ...base, risk: "high" })).toBe(true);
  });
});
