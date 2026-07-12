import { describe, expect, it } from "vitest";
import { buildUpdateArgs } from "./bd";

describe("buildUpdateArgs", () => {
  it("builds a title-only update", () => {
    expect(buildUpdateArgs("bd-1", { title: "New title" })).toEqual([
      "update",
      "bd-1",
      "--title",
      "New title",
    ]);
  });

  it("builds a status + priority update", () => {
    expect(buildUpdateArgs("bd-1", { status: "in_progress", priority: 1 })).toEqual([
      "update",
      "bd-1",
      "--status",
      "in_progress",
      "--priority",
      "1",
    ]);
  });

  it("passes through acceptance and description", () => {
    expect(
      buildUpdateArgs("bd-1", { acceptance: "- [ ] works", description: "## Goal\nShip it" }),
    ).toEqual([
      "update",
      "bd-1",
      "--acceptance",
      "- [ ] works",
      "--description",
      "## Goal\nShip it",
    ]);
  });

  it("keeps priority 0 (falsy but meaningful)", () => {
    expect(buildUpdateArgs("bd-1", { priority: 0 })).toEqual([
      "update",
      "bd-1",
      "--priority",
      "0",
    ]);
  });

  it("diffs only the changed agent prefix and preserves control labels", () => {
    // agent:nextjs → fastapi; approved / stage:* / source:* must be untouched.
    const args = buildUpdateArgs(
      "bd-1",
      { labels: { agent: "fastapi" } },
      ["agent:nextjs", "risk:low", "approved", "stage:implementing", "source:stringer"],
    );
    expect(args).toEqual([
      "update",
      "bd-1",
      "--remove-label",
      "agent:nextjs",
      "--add-label",
      "agent:fastapi",
    ]);
    // no touch to approved / stage / source / the unchanged risk label
    expect(args).not.toContain("approved");
    expect(args).not.toContain("stage:implementing");
    expect(args).not.toContain("source:stringer");
    expect(args).not.toContain("risk:low");
  });

  it("adds a label when the prefix is not yet present", () => {
    expect(buildUpdateArgs("bd-1", { labels: { domain: "eng" } }, ["agent:nextjs"])).toEqual([
      "update",
      "bd-1",
      "--add-label",
      "domain:eng",
    ]);
  });

  it("is a no-op when the label value is unchanged", () => {
    expect(buildUpdateArgs("bd-1", { labels: { agent: "nextjs" } }, ["agent:nextjs"])).toBeNull();
  });

  it("combines a scalar edit with a label diff in one invocation", () => {
    expect(
      buildUpdateArgs("bd-1", { title: "T", labels: { size: "L" } }, ["size:S", "approved"]),
    ).toEqual([
      "update",
      "bd-1",
      "--title",
      "T",
      "--remove-label",
      "size:S",
      "--add-label",
      "size:L",
    ]);
  });

  it("treats an empty patch as no write", () => {
    expect(buildUpdateArgs("bd-1", {})).toBeNull();
  });

  it("treats empty-string and undefined fields as no-ops", () => {
    expect(buildUpdateArgs("bd-1", { title: "", status: undefined })).toBeNull();
    expect(buildUpdateArgs("bd-1", { labels: { agent: "", risk: undefined } }, ["agent:nextjs"]))
      .toBeNull();
  });
});
