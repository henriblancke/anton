/** resolvePage clamps a raw ?page value to a valid 1-based page for the row count. */
import { describe, expect, it } from "vitest";
import { resolvePage } from "./pagination";

describe("resolvePage", () => {
  const size = 25;

  it("defaults to page 1 for missing/invalid input", () => {
    expect(resolvePage(undefined, 200, size)).toBe(1);
    expect(resolvePage("", 200, size)).toBe(1);
    expect(resolvePage("abc", 200, size)).toBe(1);
    expect(resolvePage("0", 200, size)).toBe(1);
    expect(resolvePage("-3", 200, size)).toBe(1);
  });

  it("returns a valid in-range page", () => {
    expect(resolvePage("2", 200, size)).toBe(2); // 200/25 = 8 pages
    expect(resolvePage("8", 200, size)).toBe(8);
  });

  it("clamps a page past the end to the last page", () => {
    expect(resolvePage("99", 200, size)).toBe(8);
    expect(resolvePage("2", 10, size)).toBe(1); // one page of rows
  });

  it("floors fractional pages and treats zero rows as a single page", () => {
    expect(resolvePage("3.9", 200, size)).toBe(3);
    expect(resolvePage("5", 0, size)).toBe(1);
  });
});
