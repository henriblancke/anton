/**
 * Unit tests for the PR-title derivation helper (anton-41d). Covers the OFF/default path (byte-
 * identical to anton's historical title — the regression guard) and the ON path's deterministic
 * type + optional `agent:` scope.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { buildPrTitle } from "./pr-title";

function target(overrides: Partial<Bead>): Pick<Bead, "title" | "issue_type" | "labels"> {
  return { title: "Add a widget", issue_type: "task", ...overrides } as Bead;
}

describe("buildPrTitle", () => {
  describe("conventionalCommits OFF (default)", () => {
    it("returns the historical `title (id)`, unchanged", () => {
      expect(buildPrTitle(target({}), "anton-41d", false)).toBe("Add a widget (anton-41d)");
    });

    it("treats absent (undefined) as OFF", () => {
      expect(buildPrTitle(target({ labels: ["agent:nextjs"] }), "anton-41d", undefined)).toBe(
        "Add a widget (anton-41d)",
      );
    });
  });

  describe("conventionalCommits ON — type derivation", () => {
    it("maps a bug to `fix`", () => {
      expect(buildPrTitle(target({ issue_type: "bug" }), "anton-9z9", true)).toBe(
        "fix: Add a widget (anton-9z9)",
      );
    });

    it("maps a task to `feat`", () => {
      expect(buildPrTitle(target({ issue_type: "task" }), "anton-9z9", true)).toBe(
        "feat: Add a widget (anton-9z9)",
      );
    });

    it("maps an epic to `feat`", () => {
      expect(buildPrTitle(target({ issue_type: "epic" }), "anton-9z9", true)).toBe(
        "feat: Add a widget (anton-9z9)",
      );
    });
  });

  describe("conventionalCommits ON — scope from the agent: label", () => {
    it("adds the agent: value as scope when present", () => {
      expect(
        buildPrTitle(
          target({ issue_type: "task", labels: ["domain:eng", "agent:nextjs", "risk:low"] }),
          "anton-9z9",
          true,
        ),
      ).toBe("feat(nextjs): Add a widget (anton-9z9)");
    });

    it("omits the scope when no agent: label is present", () => {
      expect(
        buildPrTitle(target({ issue_type: "bug", labels: ["domain:eng"] }), "anton-9z9", true),
      ).toBe("fix: Add a widget (anton-9z9)");
    });

    it("omits the scope when the bead has no labels at all", () => {
      expect(buildPrTitle(target({ labels: undefined }), "anton-9z9", true)).toBe(
        "feat: Add a widget (anton-9z9)",
      );
    });
  });
});
