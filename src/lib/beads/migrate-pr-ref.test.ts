import { describe, expect, it } from "vitest";
import { planPrRefMigration } from "./migrate-pr-ref";
import type { Bead } from "./bd";

const bead = (p: Partial<Bead>): Bead => ({ id: "x", title: "t", status: "open", ...p });

describe("planPrRefMigration", () => {
  it("plans gh- external_refs and leaves non-gh refs out", () => {
    const plan = planPrRefMigration([
      bead({ id: "a", external_ref: "gh-44" }),
      bead({ id: "b", external_ref: "https://linear.app/acme/issue/ABC-1" }),
      bead({ id: "c", external_ref: "jira-9" }),
      bead({ id: "d" }), // no ref at all
    ]);
    expect(plan).toEqual([{ id: "a", ref: "gh-44" }]);
  });

  it("skips a bead whose metadata.pr is already set (idempotent)", () => {
    const plan = planPrRefMigration([
      bead({ id: "a", external_ref: "gh-44", metadata: { pr: "gh-44" } }),
    ]);
    expect(plan).toEqual([]);
  });

  it("matches gh- case-insensitively but not near-misses", () => {
    const plan = planPrRefMigration([
      bead({ id: "a", external_ref: "GH-7" }),
      bead({ id: "b", external_ref: "gh-" }),
      bead({ id: "c", external_ref: "gh-12x" }),
      bead({ id: "d", external_ref: "xgh-3" }),
    ]);
    expect(plan).toEqual([{ id: "a", ref: "GH-7" }]);
  });
});
