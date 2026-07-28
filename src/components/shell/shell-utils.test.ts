import { describe, expect, it } from "vitest";
import {
  extractProjectSlug,
  isNavItemActive,
  pageLabelFromPath,
} from "@/components/shell/shell-utils";

describe("extractProjectSlug", () => {
  it("extracts the slug from a project root path", () => {
    expect(extractProjectSlug("/projects/acme")).toBe("acme");
  });

  it("extracts the slug from nested project routes", () => {
    expect(extractProjectSlug("/projects/acme/tickets")).toBe("acme");
    expect(extractProjectSlug("/projects/acme/epics/bd-1")).toBe("acme");
  });

  it("returns undefined outside project-scoped routes", () => {
    expect(extractProjectSlug("/")).toBeUndefined();
    expect(extractProjectSlug("/other")).toBeUndefined();
  });

  it("returns undefined for nullish input", () => {
    expect(extractProjectSlug(null)).toBeUndefined();
    expect(extractProjectSlug(undefined)).toBeUndefined();
  });
});

describe("isNavItemActive", () => {
  const board = { label: "Board", href: "/projects/acme" };
  const tickets = { label: "Tickets", href: "/projects/acme/tickets" };

  it("matches the exact href", () => {
    expect(isNavItemActive("/projects/acme", board)).toBe(true);
  });

  it("matches nested routes under the href", () => {
    expect(isNavItemActive("/projects/acme/tickets", tickets)).toBe(true);
    expect(isNavItemActive("/projects/acme/tickets?risk=high", tickets)).toBe(false);
  });

  it("does not match an unrelated sibling section", () => {
    expect(isNavItemActive("/projects/acme/epics/bd-1", tickets)).toBe(false);
  });

  it("returns false for nullish pathnames", () => {
    expect(isNavItemActive(null, board)).toBe(false);
  });

  it("matches the roadmap section without claiming a sibling section's route", () => {
    const roadmap = { label: "Roadmap", href: "/projects/acme/roadmap" };
    expect(isNavItemActive("/projects/acme/roadmap", roadmap)).toBe(true);
    expect(isNavItemActive("/projects/acme/tickets", roadmap)).toBe(false);
  });
});

describe("pageLabelFromPath", () => {
  it("labels the roadmap route rather than falling back to Board", () => {
    expect(pageLabelFromPath("/projects/acme/roadmap")).toBe("Roadmap");
  });
});
