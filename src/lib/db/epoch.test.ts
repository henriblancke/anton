import { describe, expect, it } from "vitest";

import { epochOrZero, toEpoch } from "@/lib/db/epoch";

describe("toEpoch", () => {
  it("floors a Date to whole epoch seconds", () => {
    expect(toEpoch(new Date(1_700_000_000_999))).toBe(1_700_000_000);
  });

  it("passes an integer column through", () => {
    expect(toEpoch(1_700_000_000)).toBe(1_700_000_000);
  });

  it("reports a null column as absent rather than 1970", () => {
    expect(toEpoch(null)).toBeUndefined();
    expect(toEpoch(undefined)).toBeUndefined();
  });
});

describe("epochOrZero", () => {
  it("collapses an absent column to the 0 sentinel", () => {
    expect(epochOrZero(null)).toBe(0);
    expect(epochOrZero(undefined)).toBe(0);
  });

  it("agrees with toEpoch on present values", () => {
    const at = new Date(1_700_000_000_999);
    expect(epochOrZero(at)).toBe(toEpoch(at));
    expect(epochOrZero(42)).toBe(42);
  });
});
